/**
 * 排班手动调整服务（S3 第一片 / F04 / FE-08，2026-10-26）。
 *
 * 职责：对**已写入**排班的单格操作——添加、移除、移动、锁定/解锁、连续短段例外登记。
 *
 * 设计要点（计划 §7 + §5.1）：
 * - 每个操作是**一个原子事务**（CAS：携带期望 dataRevision，陈旧写入拒绝）；
 * - 写前用**独立评价器**复算"改完后的整周终态"，与改前终态做差——
 *   差集非空即拒绝并给出明细（复用 evaluate.ts 的硬约束口径；已存在的旧问题
 *   不阻塞无关操作）；手动短段仅在登记例外原因后放行（只豁免连续性）；
 * - 候选列表逐人给出"为什么不能排"（有课/时段已满/个人上限/状态不可排/已在此时段），
 *   空冲突清单不冒充安全（未知节次课程按保守阻断并提示核对）。
 */
import { db } from './database'
import { operationLogRepo, now } from './repositories'
import { withDataRevision } from './dataRevision'
import { StaleDataError } from './dataRevision'
import { evaluateSchedule, type ContinuityException, type EvaluationReport, type LockEntry, type Violation } from '../algorithms/evaluate'
import { normalizeRules, type Assignment, type CourseInput, type SchedulingRules } from '../algorithms/types'
import { isSchedulableStatus, timetableStatusOf } from '../algorithms/timetableStatus'
import { sectionOrdinal, sectionOrdinalRange } from '../utils/sectionOrder'
import { weekInRanges } from '../utils/weekParser'
import type { Assistant, Course, DutySchedule } from './schema'

// ---------- 候选与冲突解释（FE-08） ----------

export interface SlotCandidate {
  assistantId: number
  name: string
  eligible: boolean
  /** 不可排原因（可展示） */
  reason?: string
}

/** 课程在某周是否对占用判定生效（与 greedy/evaluate 同口径：uniform 任一周有课即占用） */
function courseActiveInWeek(rules: SchedulingRules, weekNo: number, ranges: [number, number][]): boolean {
  if (!rules.uniformMode) return weekInRanges(weekNo, ranges)
  for (let w = rules.weekStart; w <= rules.weekEnd; w++) {
    if (weekInRanges(w, ranges)) return true
  }
  return false
}

/**
 * 某时段的可排候选：逐人给出可排/不可排与原因。
 * 只做"读取 + 解释"，不写库；界面据此渲染候选与灰项。
 */
export async function getSlotCandidates(
  weekNo: number,
  dayOfWeek: number,
  timeSlot: string,
): Promise<SlotCandidate[]> {
  const [rulesRaw, assistants, courses, weekRows] = await Promise.all([
    db.config.get('rules'),
    db.assistant.toArray(),
    db.course.toArray(),
    db.duty_schedule.where('weekNo').equals(weekNo).toArray(),
  ])
  const rules = normalizeRules(rulesRaw?.value as Partial<SchedulingRules> | undefined)

  const courseCountBy = new Map<number, number>()
  for (const c of courses) courseCountBy.set(c.assistantId, (courseCountBy.get(c.assistantId) ?? 0) + 1)

  const inSlot = new Set(weekRows.filter((r) => r.dayOfWeek === dayOfWeek && r.timeSlot === timeSlot).map((r) => r.assistantId))
  const slotCount = weekRows.filter((r) => r.dayOfWeek === dayOfWeek && r.timeSlot === timeSlot).length
  const slotFull = slotCount >= rules.maxPerSlot
  const sectionsInWeek = new Map<number, number>()
  for (const r of weekRows) sectionsInWeek.set(r.assistantId, (sectionsInWeek.get(r.assistantId) ?? 0) + 1)

  const ord = sectionOrdinal(timeSlot.replace(/^c/, ''))

  return assistants
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name, 'zh'))
    .map((a): SlotCandidate => {
      if (inSlot.has(a.id!)) {
        return { assistantId: a.id!, name: a.name, eligible: false, reason: '已在该时段' }
      }
      const status = timetableStatusOf(a, (courseCountBy.get(a.id!) ?? 0) > 0)
      if (!isSchedulableStatus(status)) {
        return {
          assistantId: a.id!,
          name: a.name,
          eligible: false,
          reason: status === 'missing' ? '未导入课表（未确认无课）' : '课表含无法识别节次，待核对',
        }
      }
      // 课程占用（含未知节次的保守阻断——不能因"识别不了"而显示可排）
      for (const c of courses as Course[]) {
        if (c.assistantId !== a.id || c.dayOfWeek !== dayOfWeek) continue
        const isExp = (c.kind ?? 'theory') === 'experiment'
        if (isExp ? !rules.countExperiment : !rules.countTheory) continue
        if (!courseActiveInWeek(rules, weekNo, c.weekRanges as [number, number][])) continue
        const range = sectionOrdinalRange(c.sectionText)
        if (range === null) {
          return { assistantId: a.id!, name: a.name, eligible: false, reason: `课程「${c.courseName}」节次无法识别（${c.sectionText}），请先在课程管理核对` }
        }
        if (ord !== null && range.start <= ord && range.end >= ord) {
          return { assistantId: a.id!, name: a.name, eligible: false, reason: `有课：${c.courseName}（${c.sectionText}）` }
        }
      }
      if (slotFull) {
        return { assistantId: a.id!, name: a.name, eligible: false, reason: `时段已满（${slotCount}/${rules.maxPerSlot}）` }
      }
      const max = a.customMaxSections ?? rules.maxSectionsPerAssistant
      const already = sectionsInWeek.get(a.id!) ?? 0
      if (already + 1 > max) {
        return { assistantId: a.id!, name: a.name, eligible: false, reason: `将超过个人周上限（${already}/${max}）` }
      }
      return { assistantId: a.id!, name: a.name, eligible: true }
    })
}

// ---------- 终态校验（复用独立评价器） ----------

interface WeekContext {
  rules: SchedulingRules
  assistants: Assistant[]
  courses: Course[]
}

async function loadWeekContext(): Promise<WeekContext> {
  const [rulesRaw, assistants, courses] = await Promise.all([
    db.config.get('rules'),
    db.assistant.toArray(),
    db.course.toArray(),
  ])
  return {
    rules: normalizeRules(rulesRaw?.value as Partial<SchedulingRules> | undefined),
    assistants,
    courses,
  }
}

/** 把整周行转为评价器输入（含锁定与短段例外），并对目标行豁免其自身锁定 */
function toEvaluation(
  ctx: WeekContext,
  weekNo: number,
  rows: DutySchedule[],
  excludeLockRowId?: number,
): Parameters<typeof evaluateSchedule>[0] {
  const assignments: Assignment[] = rows.map((r) => ({
    dayOfWeek: r.dayOfWeek,
    slotKey: r.timeSlot,
    assistantId: r.assistantId,
    source: r.source,
  }))
  const locks: LockEntry[] = rows
    .filter((r) => r.locked && r.id !== excludeLockRowId)
    .map((r) => ({ weekNo, dayOfWeek: r.dayOfWeek, slotKey: r.timeSlot, assistantId: r.assistantId }))
  const continuityExceptions: ContinuityException[] = rows
    .filter((r) => r.continuityExceptionReason)
    .map((r) => ({
      dayOfWeek: r.dayOfWeek,
      slotKey: r.timeSlot,
      assistantId: r.assistantId,
      reason: r.continuityExceptionReason!,
    }))
  const courses: CourseInput[] = ctx.courses.map((c) => ({
    assistantId: c.assistantId,
    kind: c.kind ?? (c.note ? 'experiment' : 'theory'),
    courseName: c.courseName,
    dayOfWeek: c.dayOfWeek,
    sectionText: c.sectionText,
    weekRanges: c.weekRanges as [number, number][],
  }))
  return {
    rules: ctx.rules,
    assistants: ctx.assistants.map((a) => ({
      id: a.id!,
      name: a.name,
      identity: a.identity,
      minSections: a.customMinSections,
      maxSections: a.customMaxSections,
    })),
    courses,
    weekNo,
    assignments,
    locks,
    continuityExceptions,
  }
}

const violationKey = (v: Violation) => `${v.type}|${v.dayOfWeek}|${v.slotKey}|${v.assistantId}|${v.message}`

/**
 * 差分校验：改后终态相对改前**新增**的硬违规必须为空。
 * 已存在的旧问题（遗留数据）不阻塞无关操作。
 */
function diffViolations(before: EvaluationReport, after: EvaluationReport): Violation[] {
  const beforeKeys = new Set(before.violations.map(violationKey))
  return after.violations.filter((v) => !beforeKeys.has(violationKey(v)))
}

class ManualAdjustRejected extends Error {
  constructor(public violations: Violation[]) {
    super(
      violations.length === 1
        ? `无法完成操作：${violations[0].message}`
        : `无法完成操作（${violations.length} 项）：${violations.map((v) => v.message).join('；')}`,
    )
    this.name = 'ManualAdjustRejected'
  }
}

// ---------- 五个原子操作（CAS） ----------

export interface ManualOpResult {
  revision: number
}

/** 添加一条手动安排（默认锁定；短段需例外原因） */
export async function addManualAssignment(
  params: {
    weekNo: number
    dayOfWeek: number
    timeSlot: string
    assistantId: number
    /** 手动短段的例外原因（可空；评价器判定需要时必须提供） */
    continuityExceptionReason?: string
  },
  expectedRevision: number | null,
): Promise<ManualOpResult> {
  const { revision } = await withDataRevision(
    expectedRevision,
    [db.duty_schedule, db.operation_log, db.assistant, db.course],
    async () => {
      const ctx = await loadWeekContext()
      const rows = await db.duty_schedule.where('weekNo').equals(params.weekNo).toArray()
      const before = evaluateSchedule(toEvaluation(ctx, params.weekNo, rows))
      const newRow: DutySchedule = {
        weekNo: params.weekNo,
        dayOfWeek: params.dayOfWeek,
        timeSlot: params.timeSlot,
        assistantId: params.assistantId,
        status: 'normal',
        source: 'manual',
        locked: true, // 新手调默认锁定（计划 §5.2）
        ...(params.continuityExceptionReason ? { continuityExceptionReason: params.continuityExceptionReason } : {}),
        createdAt: now(),
        updatedAt: now(),
      }
      const after = evaluateSchedule(toEvaluation(ctx, params.weekNo, [...rows, newRow]))
      const diff = diffViolations(before, after)
      if (diff.length > 0) throw new ManualAdjustRejected(diff)

      await db.duty_schedule.add(newRow)
      await operationLogRepo.add('schedule.manualAdd', {
        weekNo: params.weekNo,
        dayOfWeek: params.dayOfWeek,
        timeSlot: params.timeSlot,
        assistantId: params.assistantId,
        exception: params.continuityExceptionReason ?? null,
      })
    },
  )
  return { revision }
}

/** 移除一条安排（锁定项需先解锁或经此显式移除——操作即意图） */
export async function removeAssignment(rowId: number, expectedRevision: number | null): Promise<ManualOpResult> {
  const { revision } = await withDataRevision(
    expectedRevision,
    [db.duty_schedule, db.operation_log, db.assistant, db.course],
    async () => {
      const row = await db.duty_schedule.get(rowId)
      if (!row) throw new Error('该安排已不存在（可能已被其他窗口修改），请刷新')
      const ctx = await loadWeekContext()
      const rows = await db.duty_schedule.where('weekNo').equals(row.weekNo).toArray()
      const before = evaluateSchedule(toEvaluation(ctx, row.weekNo, rows))
      const after = evaluateSchedule(
        // 被移除的若是锁定项，其自身锁定不再约束终态
        toEvaluation(ctx, row.weekNo, rows.filter((r) => r.id !== rowId), rowId),
      )
      const diff = diffViolations(before, after)
      if (diff.length > 0) throw new ManualAdjustRejected(diff)

      await db.duty_schedule.delete(rowId)
      await operationLogRepo.add('schedule.manualRemove', {
        weekNo: row.weekNo,
        dayOfWeek: row.dayOfWeek,
        timeSlot: row.timeSlot,
        assistantId: row.assistantId,
        wasLocked: row.locked ?? false,
      })
    },
  )
  return { revision }
}

/** 跨格移动：移除 + 新位置写入，同一事务（原子移动，不产生中间态） */
export async function moveAssignment(
  rowId: number,
  to: { dayOfWeek: number; timeSlot: string },
  expectedRevision: number | null,
): Promise<ManualOpResult> {
  const { revision } = await withDataRevision(
    expectedRevision,
    [db.duty_schedule, db.operation_log, db.assistant, db.course],
    async () => {
      const row = await db.duty_schedule.get(rowId)
      if (!row) throw new Error('该安排已不存在（可能已被其他窗口修改），请刷新')
      if (row.dayOfWeek === to.dayOfWeek && row.timeSlot === to.timeSlot) return

      const ctx = await loadWeekContext()
      const rows = await db.duty_schedule.where('weekNo').equals(row.weekNo).toArray()
      const before = evaluateSchedule(toEvaluation(ctx, row.weekNo, rows))
      const moved: DutySchedule = {
        ...row,
        dayOfWeek: to.dayOfWeek,
        timeSlot: to.timeSlot,
        updatedAt: now(),
      }
      const afterRows = [...rows.filter((r) => r.id !== rowId), moved]
      const after = evaluateSchedule(toEvaluation(ctx, row.weekNo, afterRows, rowId))
      const diff = diffViolations(before, after)
      if (diff.length > 0) throw new ManualAdjustRejected(diff)

      await db.duty_schedule.put(moved)
      await operationLogRepo.add('schedule.manualMove', {
        weekNo: row.weekNo,
        from: { dayOfWeek: row.dayOfWeek, timeSlot: row.timeSlot },
        to,
        assistantId: row.assistantId,
      })
    },
  )
  return { revision }
}

/** 锁定 / 解锁（锁定只约束重排，不阻止老师的显式增删移） */
export async function setLocked(rowId: number, locked: boolean, expectedRevision: number | null): Promise<ManualOpResult> {
  const { revision } = await withDataRevision(
    expectedRevision,
    [db.duty_schedule, db.operation_log, db.assistant, db.course],
    async () => {
      const row = await db.duty_schedule.get(rowId)
      if (!row) throw new Error('该安排已不存在，请刷新')
      await db.duty_schedule.update(rowId, { locked, updatedAt: now() })
      await operationLogRepo.add(locked ? 'schedule.lock' : 'schedule.unlock', {
        weekNo: row.weekNo,
        dayOfWeek: row.dayOfWeek,
        timeSlot: row.timeSlot,
        assistantId: row.assistantId,
      })
    },
  )
  return { revision }
}

/** 登记 / 清除连续短段例外（只豁免连续性，原因必填可追溯） */
export async function setContinuityException(
  rowId: number,
  reason: string | null,
  expectedRevision: number | null,
): Promise<ManualOpResult> {
  if (reason !== null && !reason.trim()) throw new Error('例外原因不能为空（需可追溯）')
  const { revision } = await withDataRevision(
    expectedRevision,
    [db.duty_schedule, db.operation_log, db.assistant, db.course],
    async () => {
      const row = await db.duty_schedule.get(rowId)
      if (!row) throw new Error('该安排已不存在，请刷新')
      // Dexie update 不删字段：读取-合并(-删键)-写回
      const next = { ...row, updatedAt: now() }
      if (reason === null) delete next.continuityExceptionReason
      else next.continuityExceptionReason = reason.trim()
      await db.duty_schedule.put(next)
      await operationLogRepo.add('schedule.continuityException', {
        weekNo: row.weekNo,
        dayOfWeek: row.dayOfWeek,
        timeSlot: row.timeSlot,
        assistantId: row.assistantId,
        reason,
      })
    },
  )
  return { revision }
}

export { ManualAdjustRejected, StaleDataError }

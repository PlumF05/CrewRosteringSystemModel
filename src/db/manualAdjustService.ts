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

      const newId = await db.duty_schedule.add(newRow)
      const name = ctx.assistants.find((a) => a.id === params.assistantId)?.name ?? `#${params.assistantId}`
      await appendJournal({
        kind: 'add',
        row: { ...newRow, id: newId },
        label: `第${params.weekNo}周 星期${params.dayOfWeek} ${params.timeSlot} 添加「${name}」`,
      })
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
      const name = ctx.assistants.find((a) => a.id === row.assistantId)?.name ?? `#${row.assistantId}`
      await appendJournal({
        kind: 'remove',
        row,
        label: `第${row.weekNo}周 星期${row.dayOfWeek} ${row.timeSlot} 移除「${name}」`,
      })
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
      const name = ctx.assistants.find((a) => a.id === row.assistantId)?.name ?? `#${row.assistantId}`
      await appendJournal({
        kind: 'move',
        rowId,
        from: { dayOfWeek: row.dayOfWeek, timeSlot: row.timeSlot },
        to,
        label: `第${row.weekNo}周 移动「${name}」：星期${row.dayOfWeek} ${row.timeSlot} → 星期${to.dayOfWeek} ${to.timeSlot}`,
      })
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
      await appendJournal({
        kind: 'lock',
        rowId,
        to: locked,
        label: `第${row.weekNo}周 星期${row.dayOfWeek} ${row.timeSlot} ${locked ? '锁定' : '解锁'}`,
      })
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
      await appendJournal({
        kind: 'exception',
        rowId,
        from: row.continuityExceptionReason ?? null,
        to: reason === null ? null : reason.trim(),
        label: `第${row.weekNo}周 星期${row.dayOfWeek} ${row.timeSlot} ${reason === null ? '清除' : '登记'}短段例外`,
      })
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

// ---------- 撤销 / 重做（S3 第二片，FE-10，2026-10-26） ----------
//
// 每个手调操作在**同一事务**内向 config 键 ADJUST_JOURNAL 追加一条撤销日志
// （携带逆操作所需的完整信息）；新操作截断 redo 分支；栈深默认 50。
// 撤销/重做本身也是 CAS 写事务：逆操作先经同一评价器差分校验——
// 期间输入变化导致逆操作会制造硬违规时拒绝（如撤销例外登记会留下孤立短段），
// 不倒退 dataRevision、不覆盖其他窗口的新修改。

const ADJUST_JOURNAL_KEY = 'adjustJournal'
const JOURNAL_MAX = 50

export type JournalEntry =
  | { kind: 'add'; row: DutySchedule; label: string }
  | { kind: 'remove'; row: DutySchedule; label: string }
  | {
      kind: 'move'
      rowId: number
      from: { dayOfWeek: number; timeSlot: string }
      to: { dayOfWeek: number; timeSlot: string }
      label: string
    }
  | { kind: 'lock'; rowId: number; to: boolean; label: string }
  | { kind: 'exception'; rowId: number; from: string | null; to: string | null; label: string }

interface JournalState {
  undo: JournalEntry[]
  redo: JournalEntry[]
}

async function readJournal(): Promise<JournalState> {
  const entry = await db.config.get(ADJUST_JOURNAL_KEY)
  const v = entry?.value as JournalState | undefined
  return { undo: v?.undo ?? [], redo: v?.redo ?? [] }
}

/** 事务内：追加撤销日志（新操作截断 redo），栈深封顶 */
async function appendJournal(entry: JournalEntry): Promise<void> {
  const j = await readJournal()
  j.undo.push(entry)
  if (j.undo.length > JOURNAL_MAX) j.undo.splice(0, j.undo.length - JOURNAL_MAX)
  j.redo = []
  await db.config.put({ key: ADJUST_JOURNAL_KEY, value: j })
}

/**
 * 日志条目在该方向上是否仍可执行（按行存在性；刷新/重排后用于自动跳过）：
 * - add：撤销方向要求行存在（将被删除）；重做方向要求行不存在（将被放回）
 * - remove：恰好相反
 * - move/lock/exception：行必须存在
 */
async function entryStillValid(e: JournalEntry, which: 'undo' | 'redo'): Promise<boolean> {
  if (e.kind === 'add' || e.kind === 'remove') {
    const exists = Boolean(await db.duty_schedule.get(e.row.id!))
    return which === 'undo' ? (e.kind === 'add' ? exists : !exists) : e.kind === 'add' ? !exists : exists
  }
  return Boolean(await db.duty_schedule.get(e.rowId))
}

export interface AdjustHistory {
  canUndo: boolean
  canRedo: boolean
  /** 最近可撤销步骤的描述（新→旧，最多 5 条，供按钮提示） */
  undoLabels: string[]
  redoLabels: string[]
}

/** 刷新后恢复撤销/重做按钮：只报告，不改数据；失效条目在实际撤销时自动跳过 */
export async function getAdjustHistory(): Promise<AdjustHistory> {
  const j = await readJournal()
  return {
    canUndo: j.undo.length > 0,
    canRedo: j.redo.length > 0,
    undoLabels: [...j.undo].reverse().slice(0, 5).map((e) => e.label),
    redoLabels: j.redo.slice(0, 5).map((e) => e.label),
  }
}

/** 弹出并返回仍可执行的条目；失效条目（行已被重排覆盖等）自动跳过并清理 */
async function popValidEntry(
  which: 'undo' | 'redo',
): Promise<{ entry: JournalEntry; state: JournalState } | null> {
  const j = await readJournal()
  const list = which === 'undo' ? j.undo : j.redo
  while (list.length > 0) {
    const entry = list[list.length - 1]!
    if (await entryStillValid(entry, which)) return { entry, state: j }
    list.pop() // 失效 → 丢弃（不打断后续步骤）
  }
  await db.config.put({ key: ADJUST_JOURNAL_KEY, value: j })
  return null
}

/**
 * 撤销最近一步（direction='undo'）或重做（'redo'）。
 * 逆/正操作先做整周终态差分校验，非法则拒绝并说明；成功后条目在两栈间转移。
 */
export async function undoRedoAdjust(
  direction: 'undo' | 'redo',
  expectedRevision: number | null,
): Promise<{ label: string } | null> {
  let label = ''
  await withDataRevision(
    expectedRevision,
    [db.duty_schedule, db.operation_log, db.assistant, db.course],
    async () => {
      const popped = await popValidEntry(direction)
      if (!popped) return
      const { entry } = popped
      label = entry.label

      const applyInverse = direction === 'undo'
      let target: DutySchedule | undefined
      let deleteRowId: number | undefined
      let weekNo: number
      const e = entry as JournalEntry
      if (e.kind === 'add') {
        weekNo = e.row.weekNo
        if (applyInverse) deleteRowId = e.row.id
        else target = e.row // 原行原 id 放回
      } else if (e.kind === 'remove') {
        weekNo = e.row.weekNo
        if (applyInverse) target = e.row
        else deleteRowId = e.row.id
      } else {
        const row = await db.duty_schedule.get(e.rowId)
        if (!row) throw new Error('该安排已不存在（可能已被重排覆盖），请刷新')
        weekNo = row.weekNo
        if (e.kind === 'move') {
          const dest = applyInverse ? e.from : e.to
          target = { ...row, dayOfWeek: dest.dayOfWeek, timeSlot: dest.timeSlot, updatedAt: now() }
        } else if (e.kind === 'lock') {
          target = { ...row, locked: applyInverse ? !e.to : e.to, updatedAt: now() }
        } else {
          const value = applyInverse ? e.from : e.to
          target = { ...row, updatedAt: now() }
          if (value === null) delete target.continuityExceptionReason
          else target.continuityExceptionReason = value
        }
      }

      const ctx = await loadWeekContext()
      const rows = await db.duty_schedule.where('weekNo').equals(weekNo).toArray()
      const before = evaluateSchedule(toEvaluation(ctx, weekNo, rows))
      const afterRows =
        deleteRowId !== undefined
          ? rows.filter((r) => r.id !== deleteRowId)
          : target && rows.some((r) => r.id === target!.id)
            ? [...rows.filter((r) => r.id !== target!.id), target]
            : [...rows, target!]
      const after = evaluateSchedule(
        toEvaluation(ctx, weekNo, afterRows, deleteRowId ?? target?.id),
      )
      const diff = diffViolations(before, after)
      if (diff.length > 0) {
        throw new ManualAdjustRejected(
          diff.map((v) => ({ ...v, message: `${direction === 'undo' ? '撤销' : '重做'}会产生违规：${v.message}` })),
        )
      }

      if (deleteRowId !== undefined) await db.duty_schedule.delete(deleteRowId)
      else await db.duty_schedule.put(target!)

      // 条目在两栈间转移（结构匹配：重新读出的数组与弹出的条目不是同一引用）
      const j = await readJournal()
      const from = direction === 'undo' ? j.undo : j.redo
      const to = direction === 'undo' ? j.redo : j.undo
      const key = JSON.stringify(entry)
      for (let i = from.length - 1; i >= 0; i--) {
        if (JSON.stringify(from[i]) === key) {
          from.splice(i, 1)
          break
        }
      }
      to.push(entry)
      await db.config.put({ key: ADJUST_JOURNAL_KEY, value: j })
      await operationLogRepo.add(direction === 'undo' ? 'schedule.undo' : 'schedule.redo', { label: entry.label })
    },
  )
  return label ? { label } : null
}

export { ManualAdjustRejected, StaleDataError }

/**
 * 独立评价器（2026-10-26，S1 / 计划 §5.1，FE-03 基座）。
 *
 * 职责：对**最终排班结果**做一次与求解器内部记账无关的完整复算——
 * 生成、手动调整、恢复为当前、增量重排、保存前校验都必须经过同一口径，
 * 不能只相信算法自己标过的"合法"。审查缺陷 P01/P02/P05/P08 的共同根源
 * 都是"缺少独立终态校验"，本模块就是那道校验。
 *
 * 判定分两级：
 * - **硬违规（violation）**：课程冲突、重复安排、时段超上限、个人超上限、
 *   非法时段/人员、自动安排的连续段破坏、锁定被破坏或锁定本身非法。
 *   存在任何硬违规 ⇒ legal=false，方案不得写入/发布。
 * - **软缺口（gap）**：资源不足导致的时段缺员、个人低于下限、未知节次待核对。
 *   缺口如实报告，绝不靠制造硬违规来填满。
 *
 * 纯函数：不 import Vue/Dexie/Tauri，与 greedy.ts 并列、互不依赖
 * （仅共用 utils/sectionOrder 的节次序号轴——那是课表语义本身，不是求解器记账）。
 */
import type {
  Assignment,
  AssistantInput,
  CourseInput,
  SchedulingRules,
  Slot,
} from './types'
import { buildSlots } from './types'
import { sectionOrdinal, sectionOrdinalRange } from '../utils/sectionOrder'
import { weekInRanges } from '../utils/weekParser'

/** 带周次的锁定项（计划 §5.2：锁定必须显式携带周次，修复 P04 的跨周传播） */
export interface LockEntry {
  weekNo: number
  dayOfWeek: number
  slotKey: string
  assistantId: number
}

/** 连续性例外：手动短段 + 原因（只豁免连续性，不豁免课程/人数/个人上限） */
export interface ContinuityException {
  dayOfWeek: number
  slotKey: string
  assistantId: number
  reason: string
}

export interface EvaluateInput {
  rules: SchedulingRules
  assistants: AssistantInput[]
  courses: CourseInput[]
  weekNo: number
  assignments: Assignment[]
  /** 本周应当保持不变的锁定（weekNo 匹配者才参与本周校验） */
  locks?: LockEntry[]
  /** 手动短段的显式例外（无例外的手动短段按硬违规处理） */
  continuityExceptions?: ContinuityException[]
}

export type ViolationType =
  | 'course-conflict' // 有课时段被排班（含锁定项有课，P01）
  | 'duplicate' // 同一人同一时段重复
  | 'slot-over-capacity' // 时段人数超上限（含锁定挤爆容量，P02）
  | 'personal-over-max' // 个人周节数超上限
  | 'invalid-slot' // 时段不在 工作日×上班节次 内
  | 'unknown-assistant' // 排到了不存在的人
  | 'continuity-broken' // 自动安排的连续段 < 最少连续节数（P08），或无例外的手动短段
  | 'lock-broken' // 锁定项被搬走/删除（P03/P04 的校验面）
  | 'lock-outside-week' // 锁定项周次不在本周期内（数据错误）

export interface Violation {
  type: ViolationType
  message: string
  weekNo: number
  dayOfWeek?: number
  slotKey?: string
  assistantId?: number
  /** 关联证据（如冲突课程的原文），供界面解释 */
  evidence?: string
}

export type GapType =
  | 'slot-understaffed' // 时段实际人数 < minPerSlot
  | 'assistant-below-min' // 个人周节数 < 生效下限
  | 'needs-review' // 未知节次的课程无法判定占用（P05：不是"安全"）

export interface Gap {
  type: GapType
  message: string
  weekNo: number
  dayOfWeek?: number
  slotKey?: string
  assistantId?: number
  evidence?: string
}

export interface SlotCoverage {
  dayOfWeek: number
  slotKey: string
  actual: number
  required: number
}

export interface EvaluationReport {
  weekNo: number
  /** 无任何硬违规才为 true；缺口不影响 legal */
  legal: boolean
  violations: Violation[]
  gaps: Gap[]
  metrics: {
    totalAssignments: number
    /** 各时段实际/要求人数（用于质量报告） */
    coverage: SlotCoverage[]
    /** 值班日覆盖：每个工作日是否有人（balanceDaily 质量口径） */
    coveredDays: number[]
    emptyDays: number[]
    /** 每人实际节数（assistantId → 节数） */
    sectionsByAssistant: Map<number, number>
  }
}

/** 判定课程在某周是否对本方案的占用判定生效 */
function courseActive(
  rules: SchedulingRules,
  weekNo: number,
  weekRanges: [number, number][],
): boolean {
  if (!rules.uniformMode) return weekInRanges(weekNo, weekRanges)
  // 各周相同模式：任一周有课即占用（方案复制到全部周）
  for (let w = rules.weekStart; w <= rules.weekEnd; w++) {
    if (weekInRanges(w, weekRanges)) return true
  }
  return false
}

/** 课程类别是否计入占用（缺省按理论课处理，与 greedy/dutyConflict 一致） */
function kindCounted(rules: SchedulingRules, kind?: string): boolean {
  const isExp = (kind ?? 'theory') === 'experiment'
  return isExp ? rules.countExperiment : rules.countTheory
}

const aKey = (a: Assignment) => `${a.assistantId}|${a.dayOfWeek}|${a.slotKey}`
const lockKey = (l: LockEntry) => `${l.assistantId}|${l.dayOfWeek}|${l.slotKey}`
const exKey = (e: ContinuityException) => `${e.assistantId}|${e.dayOfWeek}|${e.slotKey}`

/** slotKey（c{n}）→ 节次序号；识别失败返回 null */
function slotOrdinal(slotKey: string): number | null {
  return sectionOrdinal(slotKey.replace(/^c/, ''))
}

/** 节号属于哪个工作区段（连续性不得跨越区段，如午休） */
function workSectionNumberOf(rules: SchedulingRules, num: number): number {
  return rules.workSections.findIndex((s) => num >= s.start && num <= s.end)
}

/**
 * 评价单周最终结果。任何来源（auto/manual/锁定）的安排都进入同一套校验；
 * 锁定额外要求"仍在原位"，但锁定**不享受**课程/容量豁免（P01/P02）。
 */
export function evaluateSchedule(input: EvaluateInput): EvaluationReport {
  const { rules, assistants, courses, weekNo, assignments } = input
  const violations: Violation[] = []
  const gaps: Gap[] = []

  const assistantIds = new Set(assistants.map((a) => a.id))
  const slots: Slot[] = buildSlots(rules)
  const slotSet = new Map<string, Slot>()
  for (const s of slots) slotSet.set(`${s.dayOfWeek}|${s.key}`, s)

  // ---- 1. 结构合法性：人员存在、时段合法、无重复 ----
  const seen = new Map<string, Assignment>()
  for (const a of assignments) {
    if (!assistantIds.has(a.assistantId)) {
      violations.push({
        type: 'unknown-assistant',
        message: `安排引用了不存在的助理 #${a.assistantId}`,
        weekNo,
        dayOfWeek: a.dayOfWeek,
        slotKey: a.slotKey,
        assistantId: a.assistantId,
      })
      continue
    }
    if (!slotSet.has(`${a.dayOfWeek}|${a.slotKey}`)) {
      violations.push({
        type: 'invalid-slot',
        message: `时段不合法：星期${a.dayOfWeek} ${a.slotKey} 不在 工作日×上班节次 范围内`,
        weekNo,
        dayOfWeek: a.dayOfWeek,
        slotKey: a.slotKey,
        assistantId: a.assistantId,
      })
      continue
    }
    const k = aKey(a)
    const prev = seen.get(k)
    if (prev) {
      violations.push({
        type: 'duplicate',
        message: `同一时段重复安排了同一人（${a.slotKey}，助理 #${a.assistantId}）`,
        weekNo,
        dayOfWeek: a.dayOfWeek,
        slotKey: a.slotKey,
        assistantId: a.assistantId,
      })
    } else {
      seen.set(k, a)
    }
  }

  // ---- 2. 课程冲突（独立复算占用；未知节次 → 待核对，P05）----
  for (const a of assignments) {
    const ord = slotOrdinal(a.slotKey)
    if (ord === null) continue // 非法键已在上面报过
    for (const c of courses) {
      if (c.assistantId !== a.assistantId || c.dayOfWeek !== a.dayOfWeek) continue
      if (!kindCounted(rules, c.kind)) continue
      if (!courseActive(rules, weekNo, c.weekRanges)) continue
      const range = sectionOrdinalRange(c.sectionText)
      if (range === null) {
        // P05：未知节次既不能当"安全"，也不能武断判冲突 —— 记待核对
        const exists = gaps.some(
          (g) =>
            g.type === 'needs-review' &&
            g.assistantId === a.assistantId &&
            g.dayOfWeek === a.dayOfWeek &&
            (g.evidence ?? '').includes(c.sectionText),
        )
        if (!exists) {
          gaps.push({
            type: 'needs-review',
            message: `课程节次「${c.sectionText}」无法识别，星期${a.dayOfWeek} 该生的安排需人工核对`,
            weekNo,
            dayOfWeek: a.dayOfWeek,
            assistantId: a.assistantId,
            evidence: c.sectionText,
          })
        }
        continue
      }
      if (range.start <= ord && range.end >= ord) {
        violations.push({
          type: 'course-conflict',
          message: `助理 #${a.assistantId} 在星期${a.dayOfWeek} ${a.slotKey} 有课${c.courseName ? `：「${c.courseName}」` : ''}（${c.sectionText}）`,
          weekNo,
          dayOfWeek: a.dayOfWeek,
          slotKey: a.slotKey,
          assistantId: a.assistantId,
          evidence: c.sectionText,
        })
        break
      }
    }
  }

  // ---- 3. 时段容量：超上限=硬违规，低于下限=缺口 ----
  const coverage: SlotCoverage[] = []
  const countBySlot = new Map<string, number>()
  for (const a of assignments) {
    const k = `${a.dayOfWeek}|${a.slotKey}`
    countBySlot.set(k, (countBySlot.get(k) ?? 0) + 1)
  }
  for (const s of slots) {
    const k = `${s.dayOfWeek}|${s.key}`
    const actual = countBySlot.get(k) ?? 0
    coverage.push({ dayOfWeek: s.dayOfWeek, slotKey: s.key, actual, required: rules.minPerSlot })
    if (actual > rules.maxPerSlot) {
      violations.push({
        type: 'slot-over-capacity',
        message: `星期${s.dayOfWeek} ${s.key} 有 ${actual} 人，超过上限 ${rules.maxPerSlot}`,
        weekNo,
        dayOfWeek: s.dayOfWeek,
        slotKey: s.key,
      })
    } else if (actual < rules.minPerSlot) {
      gaps.push({
        type: 'slot-understaffed',
        message: `星期${s.dayOfWeek} ${s.key} 只有 ${actual} 人，少于下限 ${rules.minPerSlot}`,
        weekNo,
        dayOfWeek: s.dayOfWeek,
        slotKey: s.key,
        evidence: `缺 ${rules.minPerSlot - actual} 人`,
      })
    }
  }

  // ---- 4. 个人周节数：超上限=硬违规，低于下限=缺口 ----
  const sectionsByAssistant = new Map<number, number>()
  for (const a of assignments) {
    sectionsByAssistant.set(a.assistantId, (sectionsByAssistant.get(a.assistantId) ?? 0) + 1)
  }
  for (const p of assistants) {
    const n = sectionsByAssistant.get(p.id) ?? 0
    const max = p.maxSections ?? rules.maxSectionsPerAssistant
    const min = p.minSections ?? rules.minSectionsPerAssistant
    if (n > max) {
      violations.push({
        type: 'personal-over-max',
        message: `助理「${p.name}」本周 ${n} 节，超过上限 ${max}`,
        weekNo,
        assistantId: p.id,
      })
    } else if (n < min) {
      gaps.push({
        type: 'assistant-below-min',
        message: `助理「${p.name}」本周 ${n} 节，低于下限 ${min}`,
        weekNo,
        assistantId: p.id,
        evidence: `差 ${min - n} 节`,
      })
    }
  }

  // ---- 5. 连续性：按 (人, 日, 区段) 分段，序号相邻且同区段才算连续 ----
  if (rules.minConsecutiveSections > 1) {
    const exceptions = new Set((input.continuityExceptions ?? []).map(exKey))
    const groups = new Map<string, Assignment[]>()
    for (const a of assignments) {
      const ord = slotOrdinal(a.slotKey)
      if (ord === null) continue
      const num = Number(a.slotKey.slice(1))
      const gk = `${a.assistantId}|${a.dayOfWeek}|${workSectionNumberOf(rules, num)}`
      groups.set(gk, [...(groups.get(gk) ?? []), a])
    }
    for (const [gk, list] of groups) {
      const [aid, day] = gk.split('|').map(Number)
      const sorted = list.sort((x, y) => slotOrdinal(x.slotKey)! - slotOrdinal(y.slotKey)!)
      let run: Assignment[] = []
      const flush = () => {
        if (run.length === 0) return
        if (run.length < rules.minConsecutiveSections) {
          const manualAll = run.every((r) => r.source === 'manual')
          const exempted = manualAll && run.every((r) => exceptions.has(aKey(r)))
          if (!exempted) {
            violations.push({
              type: 'continuity-broken',
              message:
                `助理 #${aid} 星期${day} 存在 ${run.length} 节的孤立段（` +
                `${run.map((r) => r.slotKey).join('、')}），` +
                `少于最少连续 ${rules.minConsecutiveSections} 节` +
                (manualAll ? '（手动短段需登记例外与原因）' : ''),
              weekNo,
              dayOfWeek: day,
              assistantId: aid,
              slotKey: run[0].slotKey,
              evidence: run.map((r) => `${r.slotKey}(${r.source})`).join('、'),
            })
          }
        }
        run = []
      }
      for (let i = 0; i < sorted.length; i++) {
        if (i === 0) {
          run = [sorted[i]]
          continue
        }
        const prevOrd = slotOrdinal(sorted[i - 1].slotKey)!
        const curOrd = slotOrdinal(sorted[i].slotKey)!
        if (curOrd === prevOrd + 1) run.push(sorted[i])
        else {
          flush()
          run = [sorted[i]]
        }
      }
      flush()
    }
  }

  // ---- 6. 锁定完整性：在位 + 本身合法（在位性在此，合法性已由上面统一覆盖）----
  const assignmentKeys = new Set(assignments.map(aKey))
  const weekLocks = (input.locks ?? []).filter((l) => l.weekNo === weekNo)
  for (const l of input.locks ?? []) {
    if (l.weekNo < rules.weekStart || l.weekNo > rules.weekEnd) {
      violations.push({
        type: 'lock-outside-week',
        message: `锁定项周次 ${l.weekNo} 不在排班周期 ${rules.weekStart}~${rules.weekEnd} 内`,
        weekNo: l.weekNo,
        dayOfWeek: l.dayOfWeek,
        slotKey: l.slotKey,
        assistantId: l.assistantId,
      })
    }
  }
  for (const l of weekLocks) {
    if (!assignmentKeys.has(lockKey(l))) {
      violations.push({
        type: 'lock-broken',
        message: `锁定项被改动：星期${l.dayOfWeek} ${l.slotKey} 助理 #${l.assistantId} 不在最终方案中`,
        weekNo,
        dayOfWeek: l.dayOfWeek,
        slotKey: l.slotKey,
        assistantId: l.assistantId,
      })
    }
  }

  // ---- 7. 指标（质量报告输入）----
  const coveredDays: number[] = []
  const emptyDays: number[] = []
  for (const d of [...rules.workdays].sort((x, y) => x - y)) {
    if (assignments.some((a) => a.dayOfWeek === d)) coveredDays.push(d)
    else emptyDays.push(d)
  }

  return {
    weekNo,
    legal: violations.length === 0,
    violations,
    gaps,
    metrics: {
      totalAssignments: assignments.length,
      coverage,
      coveredDays,
      emptyDays,
      sectionsByAssistant,
    },
  }
}

/** 多周整体评价：任一周有硬违规 ⇒ 整体不合法 */
export function evaluateAllWeeks(
  weeks: Array<Omit<EvaluateInput, 'weekNo'> & { weekNo: number; assignments: Assignment[] }>,
): { legal: boolean; reports: EvaluationReport[] } {
  const reports = weeks.map((w) => evaluateSchedule(w))
  return { legal: reports.every((r) => r.legal), reports }
}

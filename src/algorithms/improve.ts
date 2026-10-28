/**
 * 有界局部改良（S4 第二片 / F01 / FE-14，2026-10-26，计划 §5.3）。
 *
 * 定位：不引入 OR-Tools/Python/WASM——在贪心输出的**合法基线**上做带预算的爬山：
 *   ① 补位（向缺员/空白天加合法安排）② 让位搬移（把高负载者的安排挪给低于下限者）
 * 两种保守操作，逐个候选**先经独立评价器复算**，按质量优先级严格变优才应用——
 * 因此结果**永不劣于合法基线**（FE-14），也不虚称最优/完备。
 *
 * 质量优先级（字典序，越小越好）：
 *   空白天数（仅 balanceDaily 开启）→ 覆盖缺口时段数 → 个人低于下限总差 → 负担方差。
 *
 * 有界性：操作尝试次数与总耗时双预算；确定性（固定遍历顺序 + seed 参与平手扰动），
 * 同输入同 seed 同预算结果稳定；触发时间预算时如实记录实际步数与结束原因。
 */
import { evaluateSchedule, type EvaluationReport } from './evaluate'
import type {
  Assignment,
  AssistantInput,
  BaseScheduleInput,
  SchedulingRules,
  UnmetSlot,
  WeeklySchedule,
} from './types'

export interface ImproveOptions {
  /** 尝试操作预算（默认 200） */
  maxOperations: number
  /** 总耗时预算毫秒（默认 1500） */
  timeBudgetMs: number
  /** 平手扰动种子（保证同输入同预算结果稳定） */
  seed: number
}

export const DEFAULT_IMPROVE_OPTIONS: ImproveOptions = {
  maxOperations: 200,
  timeBudgetMs: 1500,
  seed: 42,
}

export type ImproveStopReason = 'converged' | 'operation-budget' | 'time-budget'

export interface ImproveResult {
  week: WeeklySchedule
  /** 是否至少应用了一次改良 */
  improved: boolean
  /** 实际尝试的候选数 / 应用的操作数 */
  attempts: number
  applied: number
  stopReason: ImproveStopReason
  /** 基线分 → 最终分（展示与验证"不劣于基线"） */
  baselineScore: QualityScore
  finalScore: QualityScore
}

/** 质量分（字典序比较；越靠前权重越高） */
export interface QualityScore {
  emptyDays: number
  unmetSlots: number
  belowMinSum: number
  fairnessVariance: number
}

function scoreOf(
  rules: SchedulingRules,
  assistants: AssistantInput[],
  report: EvaluationReport,
): QualityScore {
  const sections = assistants.map((a) => report.metrics.sectionsByAssistant.get(a.id) ?? 0)
  const mean = sections.reduce((s, x) => s + x, 0) / (sections.length || 1)
  const variance =
    sections.length > 0 ? sections.reduce((s, x) => s + (x - mean) * (x - mean), 0) / sections.length : 0
  let belowMinSum = 0
  for (const a of assistants) {
    const min = a.minSections ?? rules.minSectionsPerAssistant
    const n = report.metrics.sectionsByAssistant.get(a.id) ?? 0
    if (n < min) belowMinSum += min - n
  }
  return {
    emptyDays: rules.balanceDaily ? report.metrics.emptyDays.length : 0,
    unmetSlots: report.gaps.filter((g) => g.type === 'slot-understaffed').length,
    belowMinSum,
    fairnessVariance: Number(variance.toFixed(6)),
  }
}

function better(a: QualityScore, b: QualityScore): boolean {
  // 字典序严格变小才算改良（平手不应用——保证确定性与"保留最佳解"）
  return (
    a.emptyDays < b.emptyDays ||
    (a.emptyDays === b.emptyDays &&
      (a.unmetSlots < b.unmetSlots ||
        (a.unmetSlots === b.unmetSlots &&
          (a.belowMinSum < b.belowMinSum ||
            (a.belowMinSum === b.belowMinSum && a.fairnessVariance < b.fairnessVariance)))))
  )
}

/** 确定性伪随机（seed 驱动，用于同分候选的稳定扰动） */
function makeRng(seed: number): () => number {
  let s = seed >>> 0 || 1
  return () => {
    s = (Math.imul(s, 1103515245) + 12345) >>> 0
    return s / 0xffffffff
  }
}

/**
 * 单周有界改良。基线非法时原样返回（improved=false——改良只作用于合法基线，
 * 非法输出交由生成路径修复）。
 */
export function improveWeek(
  input: BaseScheduleInput,
  week: WeeklySchedule,
  options: Partial<ImproveOptions> = {},
): ImproveResult {
  const opts = { ...DEFAULT_IMPROVE_OPTIONS, ...options }
  const { rules, assistants, courses } = input
  const rng = makeRng(opts.seed)
  const t0 = performance.now()

  const evaluate = (assignments: Assignment[]): EvaluationReport =>
    evaluateSchedule({
      rules,
      assistants,
      courses,
      weekNo: week.weekNo,
      assignments,
      locks: [],
      continuityExceptions: [],
    })

  let assignments: Assignment[] = week.assignments.map((a) => ({ ...a }))
  let report = evaluate(assignments)
  if (!report.legal) {
    return {
      week,
      improved: false,
      attempts: 0,
      applied: 0,
      stopReason: 'converged',
      baselineScore: scoreOf(rules, assistants, report),
      finalScore: scoreOf(rules, assistants, report),
    }
  }
  let score = scoreOf(rules, assistants, report)
  const baselineScore = score

  /** 尝试一个候选：合法且严格变优才应用，返回是否应用 */
  let attempts = 0
  let applied = 0
  const tryCandidate = (candidate: Assignment[]): boolean => {
    attempts++
    const rep = evaluate(candidate)
    if (!rep.legal) return false
    const s = scoreOf(rules, assistants, rep)
    if (!better(s, score)) return false
    assignments = candidate
    score = s
    applied++
    return true
  }

  const sectionsOf = (aid: number): number =>
    assignments.filter((a) => a.assistantId === aid).length
  const maxOf = (a: AssistantInput): number => a.maxSections ?? rules.maxSectionsPerAssistant
  const minOf = (a: AssistantInput): number => a.minSections ?? rules.minSectionsPerAssistant

  /** 生成"补位/让位"候选：向 (day, slot) 添加 assistant（保持其余不变） */
  const addAt = (day: number, slot: string, aid: number): Assignment[] => [
    ...assignments,
    { dayOfWeek: day, slotKey: slot, assistantId: aid, source: 'auto' },
  ]

  /** 空闲格子 = 规则内时段 × 未满 × 该人可加（判定交给评价器统一把关） */
  const allSlots: Array<{ day: number; slot: string }> = []
  const seenSlot = new Set<string>()
  for (const d of [...rules.workdays].sort((a, b) => a - b)) {
    for (const sec of [...rules.workSections].sort((a, b) => a.start - b.start)) {
      for (let s = sec.start; s <= sec.end; s++) {
        const k = `${d}|c${s}`
        if (!seenSlot.has(k)) {
          seenSlot.add(k)
          allSlots.push({ day: d, slot: `c${s}` })
        }
      }
    }
  }

  let stopReason: ImproveStopReason = 'converged'
  const budgetExhausted = (): boolean => {
    if (attempts >= opts.maxOperations) {
      stopReason = 'operation-budget'
      return true
    }
    if (performance.now() - t0 > opts.timeBudgetMs) {
      stopReason = 'time-budget'
      return true
    }
    return false
  }

  // ---- 逐轮尝试：① 缺员补位 ② 空白天补位（balanceDaily）③ 低于下限补位 ④ 让位搬移 ----
  let pass = 0
  while (pass++ < 5) {
    let changedInPass = false

    // ①+② 缺员/空白天补位：按（缺口大→小的稳定序）遍历时段
    const unmetNow = evaluate(assignments).gaps.filter((g) => g.type === 'slot-understaffed')
    const targets: Array<{ day: number; slot: string; pri: number }> = []
    for (const g of unmetNow) {
      targets.push({ day: g.dayOfWeek!, slot: g.slotKey!, pri: 1 })
    }
    if (rules.balanceDaily) {
      const emptyDays = evaluate(assignments).metrics.emptyDays
      for (const d of emptyDays) {
        for (const s of allSlots.filter((x) => x.day === d)) {
          targets.push({ day: d, slot: s.slot, pri: 0 }) // 空白天优先级最高
        }
      }
    }
    // 稳定排序：空白天 → 周次内 (day, slot) 自然序；seed 扰动仅作用于同分候选遍历起点
    const rotate = Math.floor(rng() * Math.max(1, targets.length))
    const ordered = [...targets.slice(rotate), ...targets.slice(0, rotate)].sort(
      (a, b) => a.pri - b.pri || a.day - b.day || a.slot.localeCompare(b.slot),
    )
    for (const t of ordered) {
      if (budgetExhausted()) break
      for (const a of [...assistants].sort((x, y) => x.id - y.id)) {
        if (budgetExhausted()) break
        if (sectionsOf(a.id) + 1 > maxOf(a)) continue
        if (assignments.some((x) => x.assistantId === a.id && x.dayOfWeek === t.day && x.slotKey === t.slot)) continue
        if (tryCandidate(addAt(t.day, t.slot, a.id))) {
          changedInPass = true
          break // 该时段已补一人，重评后继续外层
        }
      }
      if (stopReason !== 'converged') break
    }
    if (stopReason !== 'converged') break

    // ③+④ 低于下限者：先直接补位；无空可补则从"高于下限者"让位搬一格
    for (const a of [...assistants].sort((x, y) => x.id - y.id)) {
      if (budgetExhausted()) break
      if (sectionsOf(a.id) >= minOf(a)) continue
      let placed = false
      for (const s of allSlots) {
        if (budgetExhausted()) break
        if (assignments.some((x) => x.assistantId === a.id && x.dayOfWeek === s.day && x.slotKey === s.slot)) continue
        if (tryCandidate(addAt(s.day, s.slot, a.id))) {
          placed = true
          changedInPass = true
          break
        }
      }
      if (placed || stopReason !== 'converged') continue
      // 让位：把某高于下限者的一条安排改为 a（同槽替换；合法性由评价器统一判定）
      const donors = [...assistants]
        .filter((d) => d.id !== a.id && sectionsOf(d.id) > minOf(d))
        .sort((x, y) => sectionsOf(y.id) - sectionsOf(x.id) || x.id - y.id)
      for (const donor of donors) {
        if (budgetExhausted()) break
        const donorRows = assignments.filter((x) => x.assistantId === donor.id)
        for (const row of donorRows) {
          if (budgetExhausted()) break
          const candidate = assignments
            .filter((x) => x !== row)
            .concat([{ dayOfWeek: row.dayOfWeek, slotKey: row.slotKey, assistantId: a.id, source: 'auto' }])
          if (tryCandidate(candidate)) {
            changedInPass = true
            break
          }
        }
        if (stopReason !== 'converged') break
      }
    }
    if (stopReason !== 'converged') break
    if (!changedInPass) break
  }

  // 汇总为 WeeklySchedule（缺口清单与工时摘要按最终结果复算）
  const finalReport = evaluate(assignments)
  const unmetSlots: UnmetSlot[] = finalReport.gaps
    .filter((g) => g.type === 'slot-understaffed')
    .map((g) => ({
      dayOfWeek: g.dayOfWeek!,
      slotKey: g.slotKey!,
      short: Number(/缺 (\d+)/.exec(g.evidence ?? '')?.[1] ?? rules.minPerSlot),
      required: rules.minPerSlot,
      actual: 0,
      reason: g.message,
    }))
  const summaries = assistants
    .map((a) => {
      const secs = finalReport.metrics.sectionsByAssistant.get(a.id) ?? 0
      const min = minOf(a)
      const max = maxOf(a)
      return {
        assistantId: a.id,
        name: a.name,
        sections: secs,
        slots: secs,
        minSections: min,
        maxSections: max,
        belowMin: secs < min,
        atMax: secs + 1 > max,
      }
    })
    .sort((x, y) => x.assistantId - y.assistantId)

  return {
    week: {
      ...week,
      assignments: assignments.sort(
        (x, y) =>
          x.dayOfWeek - y.dayOfWeek || x.slotKey.localeCompare(y.slotKey) || x.assistantId - y.assistantId,
      ),
      unmetSlots,
      summaries,
    },
    improved: applied > 0,
    attempts,
    applied,
    stopReason,
    baselineScore,
    finalScore: scoreOf(rules, assistants, finalReport),
  }
}

/**
 * 增量重排（S4 第一片 / F08 / FE-13，2026-10-26，计划 §5.4）。
 *
 * 语义：
 * - 以**已写入方案（基准）**为出发点；只重算目标周次范围内的周，范围外周按基准原样输出；
 * - **有效锁定不动**：锁定行作为 manual 来源的保留项传入求解（沿用 V-009 的入口
 *   安全校验——非法锁定被拒绝并给明细，不静默丢弃/传播）；
 * - **自动安排优先保留**：基准的自动行也作为保留项传入（来源仍记 auto），
 *   非法者（如新课程冲突、容量变化）被入口校验拒绝后由求解重新安排——
 *   变化只发生在约束被迫之处，天然稳定；
 * - **零改动保证**：无输入变化（inputsUnchanged=true）且基准终态合法时，
 *   直接返回基准原样（连求解都不跑）；
 * - 差异按 (weekNo, dayOfWeek, slot, assistantId) 输出 保留/新增/移除/替换 与原因；
 *   原因只使用可验证的信息（拒绝明细/缺员补位/重新求解），不伪造唯一因果。
 *
 * 纯函数：不碰数据库；输入由调用方（incrementalService）装配。
 */
import { evaluateSchedule } from './evaluate'
import { scheduleAll } from './greedy'
import {
  assertRulesValid,
  type Assignment,
  type BaseScheduleInput,
  type RejectedKeep,
  type UnmetSlot,
  type WeeklySchedule,
} from './types'

/** 基准行（已写入方案的一行，字段与 duty_schedule 对应） */
export interface BaselineRow {
  weekNo: number
  dayOfWeek: number
  slotKey: string
  assistantId: number
  source: 'auto' | 'manual'
  locked?: boolean
}

export interface IncrementalOptions {
  /** 目标周次范围（含端点）；缺省 = 整个排班周期 */
  targetWeeks?: [number, number]
  /**
   * 输入未变化标记（调用方以 dataRevision 等可验证依据判定）：
   * true 时走零改动快路径（基准合法 → 原样返回）。
   */
  inputsUnchanged: boolean
}

export type DiffChangeType = 'kept' | 'added' | 'removed' | 'replaced'

export interface DiffEntry {
  type: DiffChangeType
  weekNo: number
  dayOfWeek: number
  slotKey: string
  assistantId?: number
  /** added/replaced：新安排的人；removed：原安排的人 */
  otherAssistantId?: number
  /** 可验证的原因（拒绝明细 / 缺员补位 / 重新求解） */
  reason: string
}

export interface IncrementalResult {
  weeks: WeeklySchedule[]
  diff: DiffEntry[]
  rejectedKeeps: RejectedKeep[]
  /** 是否走了零改动快路径 */
  zeroChange: boolean
}

const rowKey = (r: { dayOfWeek: number; slotKey: string; assistantId: number }) =>
  `${r.dayOfWeek}|${r.slotKey}|${r.assistantId}`

/** 把基准行包成 WeeklySchedule（范围外周/零改动路径：不重新求解，只做指标复算） */
function baselineAsWeek(
  input: BaseScheduleInput,
  weekNo: number,
  rows: BaselineRow[],
): WeeklySchedule {
  const report = evaluateSchedule({
    rules: input.rules,
    assistants: input.assistants,
    courses: input.courses,
    weekNo,
    assignments: rows.map((r) => ({
      dayOfWeek: r.dayOfWeek,
      slotKey: r.slotKey,
      assistantId: r.assistantId,
      source: r.source,
    })),
    locks: rows
      .filter((r) => r.locked)
      .map((r) => ({ weekNo, dayOfWeek: r.dayOfWeek, slotKey: r.slotKey, assistantId: r.assistantId })),
    continuityExceptions: [],
  })
  const unmetSlots: UnmetSlot[] = []
  for (const g of report.gaps) {
    if (g.type !== 'slot-understaffed') continue
    const m = /缺 (\d+)/.exec(g.evidence ?? '')
    const short = m ? Number(m[1]) : input.rules.minPerSlot
    unmetSlots.push({
      dayOfWeek: g.dayOfWeek!,
      slotKey: g.slotKey!,
      short,
      required: input.rules.minPerSlot,
      actual: input.rules.minPerSlot - short, // 恒等推导，无需回查时段表
      reason: g.message,
    })
  }
  const summaries = input.assistants.map((a) => {
    const secs = report.metrics.sectionsByAssistant.get(a.id) ?? 0
    const min = a.minSections ?? input.rules.minSectionsPerAssistant
    const max = a.maxSections ?? input.rules.maxSectionsPerAssistant
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
  return {
    weekNo,
    assignments: rows
      .map((r) => ({
        dayOfWeek: r.dayOfWeek,
        slotKey: r.slotKey,
        assistantId: r.assistantId,
        source: r.source,
      }))
      .sort(
        (x, y) =>
          x.dayOfWeek - y.dayOfWeek || x.slotKey.localeCompare(y.slotKey) || x.assistantId - y.assistantId,
      ),
    unmetSlots,
    summaries,
    rejectedKeeps: [],
    elapsedMs: 0,
  }
}

/** 逐周比较基准与结果，输出带原因的差异（不伪造因果） */
function diffWeek(
  weekNo: number,
  before: BaselineRow[],
  after: Assignment[],
  rejected: RejectedKeep[],
): DiffEntry[] {
  const out: DiffEntry[] = []
  const beforeMap = new Map(before.map((r) => [rowKey(r), r]))
  const afterMap = new Map(after.map((a) => [rowKey(a), a]))
  const rejectedByPos = new Map(
    rejected.filter((k) => (k.weekNo ?? weekNo) === weekNo).map((k) => [
      `${k.dayOfWeek}|${k.slotKey}|${k.assistantId}`,
      k,
    ]),
  )

  for (const [k, r] of beforeMap) {
    if (afterMap.has(k)) {
      out.push({ type: 'kept', weekNo, dayOfWeek: r.dayOfWeek, slotKey: r.slotKey, assistantId: r.assistantId, reason: '' })
    } else {
      const rej = rejectedByPos.get(k)
      const [day, slot, aid] = k.split('|')
      // 同时段是否换人了（替换）
      const replacement = after.find(
        (a) => a.dayOfWeek === Number(day) && a.slotKey === slot && a.assistantId !== Number(aid),
      )
      if (replacement) {
        out.push({
          type: 'replaced',
          weekNo,
          dayOfWeek: Number(day),
          slotKey: slot,
          assistantId: Number(aid),
          otherAssistantId: replacement.assistantId,
          reason: rej?.reason ?? '重新求解后被替换（原安排在当前约束下不再保留）',
        })
      } else {
        out.push({
          type: 'removed',
          weekNo,
          dayOfWeek: Number(day),
          slotKey: slot,
          assistantId: Number(aid),
          reason: rej?.reason ?? '重新求解后未再安排（连续性/容量调整）',
        })
      }
    }
  }
  for (const [k, a] of afterMap) {
    if (!beforeMap.has(k)) {
      const hadSomeone = before.some((r) => r.dayOfWeek === a.dayOfWeek && r.slotKey === a.slotKey)
      out.push({
        type: 'added',
        weekNo,
        dayOfWeek: a.dayOfWeek,
        slotKey: a.slotKey,
        assistantId: a.assistantId,
        reason: hadSomeone
          ? '替换原安排后补入（见同时段 replaced 条目原因）'
          : '该时段此前缺员/无人，本次补入',
      })
    }
  }
  return out.sort(
    (x, y) =>
      x.dayOfWeek - y.dayOfWeek ||
      x.slotKey.localeCompare(y.slotKey) ||
      x.type.localeCompare(y.type),
  )
}

/**
 * 增量重排主入口。
 * @param input 与 scheduleAll 相同的输入（rules/assistants/courses）
 * @param baseline 已写入方案的全部行（含范围外周）
 */
export function incrementalSchedule(
  input: BaseScheduleInput,
  baseline: BaselineRow[],
  options: IncrementalOptions,
): IncrementalResult {
  const { rules } = input
  assertRulesValid(rules)
  if (rules.uniformMode) {
    throw new Error('增量重排需要"各周独立"模式：各周相同模式的方案由模板复制而来，请用全量重排')
  }

  const allWeeks: number[] = []
  for (let w = rules.weekStart; w <= rules.weekEnd; w++) allWeeks.push(w)
  const [tStart, tEnd] = options.targetWeeks ?? [rules.weekStart, rules.weekEnd]
  if (tStart < rules.weekStart || tEnd > rules.weekEnd || tStart > tEnd) {
    throw new Error(`目标周次范围不合法（应在 ${rules.weekStart}~${rules.weekEnd} 内且起 ≤ 止）`)
  }

  const baselineByWeek = new Map<number, BaselineRow[]>()
  for (const r of baseline) {
    baselineByWeek.set(r.weekNo, [...(baselineByWeek.get(r.weekNo) ?? []), r])
  }

  // ---- 零改动快路径：输入未变 且 基准全部周终态合法 → 原样返回 ----
  if (options.inputsUnchanged) {
    const legal = allWeeks.every((w) => {
      const rows = baselineByWeek.get(w) ?? []
      const rep = evaluateSchedule({
        rules,
        assistants: input.assistants,
        courses: input.courses,
        weekNo: w,
        assignments: rows.map((r) => ({
          dayOfWeek: r.dayOfWeek,
          slotKey: r.slotKey,
          assistantId: r.assistantId,
          source: r.source,
        })),
        locks: rows
          .filter((r) => r.locked)
          .map((r) => ({ weekNo: w, dayOfWeek: r.dayOfWeek, slotKey: r.slotKey, assistantId: r.assistantId })),
      })
      return rep.legal
    })
    if (legal) {
      return {
        weeks: allWeeks.map((w) => baselineAsWeek(input, w, baselineByWeek.get(w) ?? [])),
        diff: [],
        rejectedKeeps: [],
        zeroChange: true,
      }
    }
    // 基准本身有硬违规（遗留问题）→ 继续重算修复
  }

  // ---- 目标周：基准行全部作为保留项传入（锁定=manual，自动=auto 优先保留）----
  const keep = baseline
    .filter((r) => r.weekNo >= tStart && r.weekNo <= tEnd)
    .map((r) => ({
      weekNo: r.weekNo,
      dayOfWeek: r.dayOfWeek,
      slotKey: r.slotKey,
      assistantId: r.assistantId,
      source: r.locked ? 'manual' : r.source,
    } as const))

  const results = scheduleAll({ ...input, keep })
  const rejectedKeeps = results.flatMap((w) => w.rejectedKeeps)

  const weeks: WeeklySchedule[] = []
  const diff: DiffEntry[] = []
  for (const w of allWeeks) {
    if (w < tStart || w > tEnd) {
      // 范围外：基准原样（含锁定与来源），不重新求解
      weeks.push(baselineAsWeek(input, w, baselineByWeek.get(w) ?? []))
      continue
    }
    const solved = results.find((x) => x.weekNo === w)!
    weeks.push(solved)
    diff.push(
      ...diffWeek(w, baselineByWeek.get(w) ?? [], solved.assignments, solved.rejectedKeeps),
    )
  }

  return { weeks, diff, rejectedKeeps, zeroChange: false }
}

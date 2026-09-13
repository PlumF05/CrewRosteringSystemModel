/**
 * 贪心启发式排班算法（ADR-002 第三节选型与流程约定 + 第七节修订）。
 *
 * 流程：
 *   1. 时段由规则推导（工作日 × 上班节次，key=c{start}-{end}）；
 *   2. 计算可用性矩阵：助理 × 时段，课程占用的格子标记忙
 *      （课程按规则过滤：理论课/实验课是否计入；uniform 模式下任一周有课即占用）；
 *   3. 时段按"约束紧度"排序——可用候选人少的时段优先分配（先难后易）；
 *   4. 时段内候选人按"稀缺度"排序——可选时段最少的人优先，平手按已排节数（负载均衡）；
 *   5. 第二遍修复：低于最少工时的助理在未满时段补位；
 *   6. 输出未满足时段清单交由手动调整兜底（F04）。
 *
 * scheduleAll：按排班模式产出全部周——
 *   各周独立：逐周计算可用性；
 *   各周相同（uniform）：按"任一周有课即占用"计算一次，复制到全部周。
 *
 * 纯函数约束：不修改输入、不碰数据库/UI、同输入必同输出（可重放）。
 * 复杂度 O(周数 × A×S)，50 人 × 35 时段 × 17 周仍为毫秒级。
 */
import { weekInRanges } from '../utils/weekParser'
import { buildSlots } from './types'
import type {
  Assignment,
  AssistantInput,
  AssistantSummary,
  BaseScheduleInput,
  ScheduleInput,
  ScheduleOutput,
  Slot,
  UnmetSlot,
  WeeklySchedule,
} from './types'

const slotKeyOf = (day: number, key: string) => `${day}|${key}`

/**
 * 单周排班。internalAnyWeek=true 时（uniform 模式的计算步），
 * 课程在其周次范围与整个排班周期有交集即视为占用。
 */
function scheduleOneWeek(input: ScheduleInput, internalAnyWeek = false): ScheduleOutput {
  const t0 = performance.now()
  const { weekNo, rules, assistants, courses, keep } = input

  // ---------- 1. 时段槽位 ----------
  const slots: Slot[] = buildSlots(rules)
  const slotHoursMap = new Map<string, number>()
  for (const s of slots) slotHoursMap.set(`${s.dayOfWeek}|${s.key}`, s.sectionEnd - s.sectionStart + 1)
  const slotHoursOf = (day: number, key: string) => slotHoursMap.get(`${day}|${key}`) ?? 0

  // ---------- 2. 课程过滤（理论课/实验课） ----------
  const effectiveCourses = courses.filter((c) => {
    const isExp = (c.kind ?? 'theory') === 'experiment'
    return isExp ? rules.countExperiment : rules.countTheory
  })

  // ---------- 3. 可用性矩阵 ----------
  // courseBusy = 课程占用（不可改变的硬约束）；busy = courseBusy + 已排值班（随分配增长）
  const courseBusy = new Map<number, Set<string>>()
  for (const a of assistants) courseBusy.set(a.id, new Set())
  const busy = new Map<number, Set<string>>()
  for (const a of assistants) busy.set(a.id, new Set())

  const isCourseActive = (c: (typeof effectiveCourses)[number]) => {
    if (internalAnyWeek) {
      // uniform：任一周有课即占用（课程周次与排班周期有交集）
      return c.weekRanges.some(([s, e]) => s <= rules.weekEnd && e >= rules.weekStart)
    }
    return weekInRanges(weekNo, c.weekRanges)
  }
  const overlaps = (c: (typeof effectiveCourses)[number], s: Slot) =>
    c.sectionStart !== null &&
    c.sectionEnd !== null &&
    c.sectionStart <= s.sectionEnd &&
    c.sectionEnd >= s.sectionStart

  for (const c of effectiveCourses) {
    if (!isCourseActive(c)) continue
    const set = courseBusy.get(c.assistantId)
    if (!set) continue
    for (const s of slots) {
      if (s.dayOfWeek !== c.dayOfWeek) continue
      // 数字节次按区间重叠判定；非数字节次（中课/晚课）保守按全天占用
      if (c.sectionStart === null || c.sectionEnd === null || overlaps(c, s)) {
        set.add(slotKeyOf(s.dayOfWeek, s.key))
      }
    }
  }
  for (const a of assistants) busy.set(a.id, new Set(courseBusy.get(a.id) ?? []))

  // 每天处于上班时段内的节号集合（最少连续节次约束的边界）
  const dayWorkSections = new Map<number, Set<number>>()
  for (const s of slots) {
    if (!dayWorkSections.has(s.dayOfWeek)) dayWorkSections.set(s.dayOfWeek, new Set())
    dayWorkSections.get(s.dayOfWeek)!.add(s.sectionStart)
  }

  /**
   * 最少连续节次守卫：候选节所在"可值班连续段"（上班节次内、且未被课程占用）
   * 的长度必须 ≥ minConsecutiveSections。
   * 例：第 9~10 节有课、min=2 时，第 11 节所在连续段仅剩 {11} → 不可排。
   */
  const freeRunOk = (a: AssistantInput, day: number, sec: number): boolean => {
    if (rules.minConsecutiveSections <= 1) return true
    const ws = dayWorkSections.get(day)
    const cb = courseBusy.get(a.id)
    if (!ws?.has(sec)) return false
    if (cb?.has(`${day}|c${sec}`)) return false
    let len = 1
    for (let x = sec - 1; ws.has(x) && !cb?.has(`${day}|c${x}`); x--) len++
    for (let x = sec + 1; ws.has(x) && !cb?.has(`${day}|c${x}`); x++) len++
    return len >= rules.minConsecutiveSections
  }

  // ---------- 4. 槽位容量与 keep 预占（F08 手动保留） ----------
  const slotCount = new Map<string, number>()
  const slotMembers = new Map<string, Set<number>>()
  for (const s of slots) {
    slotCount.set(slotKeyOf(s.dayOfWeek, s.key), 0)
    slotMembers.set(slotKeyOf(s.dayOfWeek, s.key), new Set())
  }
  const hours = new Map<number, number>()
  for (const a of assistants) hours.set(a.id, 0)

  const assignments: Assignment[] = []
  const keptKeys = new Set<string>()
  for (const k of keep ?? []) {
    const key = slotKeyOf(k.dayOfWeek, k.slotKey)
    if (!slotCount.has(key)) continue
    if (slotMembers.get(key)!.has(k.assistantId)) continue
    const h = slotHoursOf(k.dayOfWeek, k.slotKey)
    if ((hours.get(k.assistantId) ?? 0) + h > rules.maxSectionsPerAssistant) continue
    slotCount.set(key, slotCount.get(key)! + 1)
    slotMembers.get(key)!.add(k.assistantId)
    hours.set(k.assistantId, (hours.get(k.assistantId) ?? 0) + h)
    assignments.push({
      dayOfWeek: k.dayOfWeek,
      slotKey: k.slotKey,
      assistantId: k.assistantId,
      source: 'manual',
    })
    busy.get(k.assistantId)?.add(key)
    keptKeys.add(key)
  }

  const freeAt = (a: AssistantInput, s: Slot) => !busy.get(a.id)!.has(slotKeyOf(s.dayOfWeek, s.key))

  // 每个助理的全部可选时段数（稀缺度）
  const freeSlotCount = new Map<number, number>()
  for (const a of assistants) {
    let n = 0
    for (const s of slots) if (freeAt(a, s)) n++
    freeSlotCount.set(a.id, n)
  }

  function candidatesFor(s: Slot): AssistantInput[] {
    return assistants.filter(
      (a) =>
        freeAt(a, s) &&
        freeRunOk(a, s.dayOfWeek, s.sectionStart) &&
        (hours.get(a.id) ?? 0) + slotHoursOf(s.dayOfWeek, s.key) <= rules.maxSectionsPerAssistant,
    )
  }

  function assign(a: AssistantInput, s: Slot, source: 'auto' | 'manual') {
    const key = slotKeyOf(s.dayOfWeek, s.key)
    slotCount.set(key, (slotCount.get(key) ?? 0) + 1)
    slotMembers.get(key)!.add(a.id)
    const h = slotHoursOf(s.dayOfWeek, s.key)
    hours.set(a.id, (hours.get(a.id) ?? 0) + h)
    busy.get(a.id)!.add(key)
    freeSlotCount.set(a.id, Math.max(0, (freeSlotCount.get(a.id) ?? 1) - 1))
    assignments.push({ dayOfWeek: s.dayOfWeek, slotKey: s.key, assistantId: a.id, source })
  }

  // ---------- 5. 主分配：时段按紧度排序，逐时段填人 ----------
  const byTightness = [...slots].sort((x, y) => {
    const cx = candidatesFor(x).length
    const cy = candidatesFor(y).length
    if (cx !== cy) return cx - cy
    return slotKeyOf(x.dayOfWeek, x.key).localeCompare(slotKeyOf(y.dayOfWeek, y.key))
  })

  // min>1 时：优先让候选"延续自己已有的相邻值班"（避免把连续块拆散）
  const extendsOwnBlock = (a: AssistantInput, s: Slot): boolean => {
    if (rules.minConsecutiveSections <= 1) return false
    const day = s.dayOfWeek
    const sec = s.sectionStart
    return (
      busy.get(a.id)!.has(`${day}|c${sec - 1}`) ||
      busy.get(a.id)!.has(`${day}|c${sec + 1}`)
    )
  }

  for (const s of byTightness) {
    const key = slotKeyOf(s.dayOfWeek, s.key)
    if (keptKeys.has(key) && slotCount.get(key)! >= rules.maxPerSlot) continue
    let candidates = candidatesFor(s)
    // 排序：延续已有连续块者优先 → 负载均衡（已排节数少者先）→ 稀缺度 → id（确定性）
    candidates = candidates.sort((x, y) => {
      const ex = extendsOwnBlock(x, s) ? 0 : 1
      const ey = extendsOwnBlock(y, s) ? 0 : 1
      if (ex !== ey) return ex - ey
      const hx = hours.get(x.id)!
      const hy = hours.get(y.id)!
      if (hx !== hy) return hx - hy
      const fx = freeSlotCount.get(x.id)!
      const fy = freeSlotCount.get(y.id)!
      if (fx !== fy) return fx - fy
      return x.id - y.id
    })
    for (const a of candidates) {
      if (slotCount.get(key)! >= rules.maxPerSlot) break
      if (slotMembers.get(key)!.has(a.id)) continue
      assign(a, s, 'auto')
    }
  }

  // ---------- 6. 第二遍：最少工时修复 ----------
  const belowMinAssistants = assistants.filter((a) => (hours.get(a.id) ?? 0) < rules.minSectionsPerAssistant)
  for (const a of belowMinAssistants) {
    const order = [...slots].sort((x, y) => {
      const cx = slotCount.get(slotKeyOf(x.dayOfWeek, x.key))!
      const cy = slotCount.get(slotKeyOf(y.dayOfWeek, y.key))!
      if (cx !== cy) return cx - cy
      return slotKeyOf(x.dayOfWeek, x.key).localeCompare(slotKeyOf(y.dayOfWeek, y.key))
    })
    for (const s of order) {
      if ((hours.get(a.id) ?? 0) >= rules.minSectionsPerAssistant) break
      const key = slotKeyOf(s.dayOfWeek, s.key)
      if (slotMembers.get(key)!.has(a.id)) continue
      if (slotCount.get(key)! >= rules.maxPerSlot) continue
      if (!freeAt(a, s)) continue
      if (!freeRunOk(a, s.dayOfWeek, s.sectionStart)) continue
      if ((hours.get(a.id) ?? 0) + slotHoursOf(s.dayOfWeek, s.key) > rules.maxSectionsPerAssistant) continue
      assign(a, s, 'auto')
    }
  }

  // ---------- 6.5 最少连续节次约束：撤销孤立值班（仅 auto，手动保留项不动） ----------
  // 分配阶段的守卫基于"可值班连续段"长度，仍可能出现段内只排了 1 节的情况
  //（如段 {8,9,10} 因容量/负载只落到第 8 节）——在此统一撤销，保证输出满足连续性。
  if (rules.minConsecutiveSections > 1) {
    const byAssistantDay = new Map<string, Map<number, Assignment>>() // "aId|day" -> secNum -> assignment
    for (const a of assignments.filter((x) => x.source === 'auto')) {
      const k = `${a.assistantId}|${a.dayOfWeek}`
      if (!byAssistantDay.has(k)) byAssistantDay.set(k, new Map())
      byAssistantDay.get(k)!.set(Number(a.slotKey.slice(1)), a)
    }
    const toRemove: Assignment[] = []
    for (const secMap of byAssistantDay.values()) {
      const sorted = [...secMap.keys()].sort((x, y) => x - y)
      let start = sorted[0]
      let len = 1
      const flush = (runStart: number, runLen: number) => {
        if (runLen >= rules.minConsecutiveSections) return
        for (let s = runStart; s < runStart + runLen; s++) {
          const a = secMap.get(s)
          if (a) toRemove.push(a)
        }
      }
      for (let i = 1; i < sorted.length; i++) {
        if (sorted[i] === sorted[i - 1] + 1) len++
        else {
          flush(start, len)
          start = sorted[i]
          len = 1
        }
      }
      flush(start, len)
    }
    for (const a of toRemove) {
      const key = slotKeyOf(a.dayOfWeek, a.slotKey)
      slotCount.set(key, Math.max(0, (slotCount.get(key) ?? 1) - 1))
      slotMembers.get(key)?.delete(a.assistantId)
      hours.set(a.assistantId, Math.max(0, (hours.get(a.assistantId) ?? 1) - slotHoursOf(a.dayOfWeek, a.slotKey)))
      freeSlotCount.set(a.assistantId, (freeSlotCount.get(a.assistantId) ?? 0) + 1)
      busy.get(a.assistantId)?.delete(key)
      assignments.splice(assignments.indexOf(a), 1)
    }
  }

  // ---------- 7. 汇总 ----------
  const unmetSlots: UnmetSlot[] = []
  for (const s of slots) {
    const key = slotKeyOf(s.dayOfWeek, s.key)
    const actual = slotCount.get(key)!
    if (actual < rules.minPerSlot) {
      unmetSlots.push({
        dayOfWeek: s.dayOfWeek,
        slotKey: s.key,
        short: rules.minPerSlot - actual,
        required: rules.minPerSlot,
        actual,
        reason: `星期${s.dayOfWeek} ${s.label}：可用助理不足`,
      })
    }
  }

  const summaries: AssistantSummary[] = assistants
    .map((a) => {
      const secs = hours.get(a.id) ?? 0
      const slotsN = assignments.filter((x) => x.assistantId === a.id).length
      return {
        assistantId: a.id,
        name: a.name,
        sections: secs,
        slots: slotsN,
        belowMin: secs < rules.minSectionsPerAssistant,
        atMax: secs + rules.minPerSlot > rules.maxSectionsPerAssistant,
      }
    })
    .sort((x, y) => x.assistantId - y.assistantId)

  return {
    assignments: assignments.sort(
      (x, y) =>
        x.dayOfWeek - y.dayOfWeek || x.slotKey.localeCompare(y.slotKey) || x.assistantId - y.assistantId,
    ),
    unmetSlots,
    summaries,
    elapsedMs: performance.now() - t0,
  }
}

/**
 * 按排班模式产出全部周（SRS F01 2026-09-11 补充：一次性完成全周期排班）。
 * - 各周独立：逐周按当周课程占用计算；
 * - 各周相同（uniform）：以"任一周有课即占用"计算一次，复制到全部周。
 */
export function scheduleAll(input: BaseScheduleInput): WeeklySchedule[] {
  const { rules } = input
  const weeks: number[] = []
  for (let w = rules.weekStart; w <= rules.weekEnd; w++) weeks.push(w)

  if (rules.uniformMode) {
    const once = scheduleOneWeek({ ...input, weekNo: rules.weekStart }, true)
    return weeks.map((weekNo) => ({ ...once, weekNo, replicated: true }))
  }
  return weeks.map((weekNo) => ({ ...scheduleOneWeek({ ...input, weekNo }), weekNo }))
}

export { scheduleOneWeek }

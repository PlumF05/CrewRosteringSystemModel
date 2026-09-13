/**
 * 贪心启发式排班算法（ADR-002 第三节选型与流程约定 + 第七节修订）。
 *
 * 流程：
 *   1. 时段由规则推导（工作日 × 上班节次，key=c{start}-{end}）；
 *   2. 计算可用性矩阵：助理 × 时段，课程占用的格子标记忙
 *      （课程按规则过滤：理论课/实验课是否计入；uniform 模式下任一周有课即占用；
 *      节次经 utils/sectionOrder 换算到"当日先后序号"再判重叠——课程表的节次是
 *      数字与命名（中课/晚课）混排，排班表编号已与课程表对齐）；
 *   3. 时段按"约束紧度"排序——可用候选人少的时段优先分配（先难后易）；
 *   4. 时段内候选人按"稀缺度"排序——可选时段最少的人优先，平手按已排节数（负载均衡）；
 *   5. 第二遍修复：低于最少工时的助理在未满时段补位；
 *   6. 每日均衡（balanceDaily，2026-09-13 增补）：在收敛结果之上做保守再平衡——
 *      补齐"整天无人"的工作日，并收敛各天人数差，全程不违反课程/人数上限/最少连续节数；
 *   7. 输出未满足时段清单交由手动调整兜底（F04）。
 *
 * scheduleAll：按排班模式产出全部周——
 *   各周独立：逐周计算可用性；
 *   各周相同（uniform）：按"任一周有课即占用"计算一次，复制到全部周。
 *
 * 纯函数约束：不修改输入、不碰数据库/UI、同输入必同输出（可重放）。
 * 复杂度 O(周数 × A×S)，50 人 × 35 时段 × 17 周仍为毫秒级。
 */
import { weekInRanges } from '../utils/weekParser'
import { sectionOrdinal, sectionOrdinalRange } from '../utils/sectionOrder'
import { assertRulesValid, buildSlots } from './types'
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
  // 入口把关：非法规则直接抛错，避免静默产出空结果（详见 validateRules 的说明）
  assertRulesValid(rules)

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

  // 节次序号轴：课程与排班时段都必须先换算到"当日先后序号"再比较。
  // 课程表节次是"数字节次 + 命名节次（中课/晚课）"混排，排班表的下午编号已与
  // 课程表对齐（第6节 = 下午第一节），故按序号区间判重叠——既不漏判（在课上排班），
  // 也不会把中课/晚课误当成整天占用而白丢一天的可排时间。
  const slotOrdinalMap = new Map<string, number | null>()
  for (const s of slots) slotOrdinalMap.set(s.key, sectionOrdinal(String(s.sectionStart)))
  const courseRangeCache = new Map<(typeof effectiveCourses)[number], { start: number; end: number } | null>()
  for (const c of effectiveCourses) courseRangeCache.set(c, sectionOrdinalRange(c.sectionText))

  for (const c of effectiveCourses) {
    if (!isCourseActive(c)) continue
    const set = courseBusy.get(c.assistantId)
    if (!set) continue
    const range = courseRangeCache.get(c) ?? null
    for (const s of slots) {
      if (s.dayOfWeek !== c.dayOfWeek) continue
      const ord = slotOrdinalMap.get(s.key) ?? null
      // 节次无法识别（异常原文）→ 保守按"该日整天占用"：宁可少排，不可在课上排班
      const busy = range === null || ord === null ? true : range.start <= ord && range.end >= ord
      if (busy) set.add(slotKeyOf(s.dayOfWeek, s.key))
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

  // ---------- 6. 最少工时修复（可重复执行：撤销孤立块释放容量后需要再次补位） ----------
  function repairPass(): boolean {
    let made = false
    const belowMinAssistants = assistants.filter(
      (a) => (hours.get(a.id) ?? 0) < rules.minSectionsPerAssistant,
    )
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
        if ((hours.get(a.id) ?? 0) + slotHoursOf(s.dayOfWeek, s.key) > rules.maxSectionsPerAssistant)
          continue
        assign(a, s, 'auto')
        made = true
      }
    }
    return made
  }

  // ---------- 6.5 最少连续节次约束：撤销孤立值班（仅 auto，手动保留项不动） ----------
  // 分配阶段的守卫基于"可值班连续段"长度，仍可能出现段内只排了 1 节的情况
  //（如段 {8,9,10} 因容量/负载只落到第 8 节）——在此统一撤销，保证输出满足连续性。
  function removalPass(): boolean {
    if (rules.minConsecutiveSections <= 1) return false
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
    return toRemove.length > 0
  }

  // 修复 → 撤销 → 再修复 迭代：撤销孤立块释放的容量可能允许新的合法补位
  //（缺陷案例：修复达标后撤销又使人低于下限，但撤销后不再补位 → 永远缺节）
  repairPass()
  let iter = 0
  while (iter++ < 4) {
    const removed = removalPass()
    const added = repairPass()
    if (!removed && !added) break
  }

  // ---------- 6.6 每日均衡（2026-09-13 增补，规则 balanceDaily） ----------
  // 目标：在"不违反其他约束"的前提下尽量平均每日排班，避免出现某天无人值班。
  //
  // 动机：主分配是按"时段紧度先难后易"逐时段填人的，容量会优先消耗在排序靠前的
  // 日子上，可能出现"周一~周四已排妥、周五一个人都没有"的不均衡。于是本阶段在
  // 收敛结果之上，对"整天无人"的工作日做补救，只使用两种**保守**原子操作：
  //   ① 新建块：某助理在该天空闲、剩余额度够 → 排一个满足最少连续节数的连续块；
  //   ② 整块搬移：把某助理在别天的**整个连续块**搬到该天的空闲连续段上。逐个移除
  //      再逐个指派、块节数不变 ⇒ 该助理工时净变化为 0，不破坏课程占用、人数上限
  //      与最少连续节数；且**仅当源时段移出后仍满足人数下限**才允许搬（即只动用
  //      "冗余"值班）——因此绝不会把"某天无人"的问题转移到另一天。
  //
  // 范围界定（两档策略，以及为什么不做更激进的"人数差最小化"）：
  //   A 档 · 零损伤：只用 ① 新建块、② 冗余值班整块搬移，绝不新增"未满足时段"。
  //   B 档 · 兜底让位：仅当某天"一个人都没有"且 A 档无解时启用（典型场景是工时上限
  //      已用尽：3 人 × 上限 6 节 = 18 人节，却要覆盖 40 个时段）。允许搬走整个连续块、
  //      把源时段的覆盖让出来以保证"每天都有人"，但**硬性要求源日让出后仍有人**，
  //      绝不把空白天转移给别的日期。此时"每时段都有人"数学上不可达（18 < 40），
  //      "每天有人"与"每时段有人"不可兼得，取舍是显式的，而非静默破坏约束。
  //   不做"人数差最小化"：各工作日的上班节次相同 ⇒ 每日时段数相同，主分配本就会把每个
  //      时段填到人数上限，真正的失衡形态就是"某天归零"；而搬移粒度受最少连续节数约束、
  //      无法细分到单节微调人数差，强行迭代会在两个状态间来回搬运、永不收敛。
  const workdaysSorted = [...new Set(rules.workdays)].sort((a, b) => a - b)

  /** 某助理当前已在多少个工作日值班（为空白天挑人时，优先挑天数最少的人以分散排班） */
  const coveredDaysOf = (aId: number): number =>
    new Set(assignments.filter((x) => x.assistantId === aId).map((x) => x.dayOfWeek)).size

  /** 某助理在某天的空闲连续段（上班节次内 ∪ 未被课程占用），单位=节 */
  const freeSegmentsOf = (a: AssistantInput, day: number): Array<{ start: number; len: number }> => {
    const ws = dayWorkSections.get(day)
    if (!ws) return []
    const cb = courseBusy.get(a.id)
    const secs = [...ws].sort((x, y) => x - y)
    const runs: Array<{ start: number; len: number }> = []
    let cur: { start: number; len: number } | null = null
    for (const s of secs) {
      if (cb?.has(`${day}|c${s}`)) {
        cur = null
        continue
      }
      if (cur && cur.start + cur.len === s) cur.len++
      else {
        cur = { start: s, len: 1 }
        runs.push(cur)
      }
    }
    return runs
  }

  /** 该助理在该天的"已分配连续块"列表 */
  const blocksOf = (aId: number, day: number): Assignment[][] => {
    const bySec = new Map<number, Assignment>()
    for (const x of assignments) {
      if (x.assistantId === aId && x.dayOfWeek === day) bySec.set(Number(x.slotKey.slice(1)), x)
    }
    const secs = [...bySec.keys()].sort((x, y) => x - y)
    const blocks: Assignment[][] = []
    let cur: Assignment[] = []
    for (let i = 0; i < secs.length; i++) {
      const item = bySec.get(secs[i])!
      if (i > 0 && secs[i] === secs[i - 1] + 1) cur.push(item)
      else {
        if (cur.length) blocks.push(cur)
        cur = [item]
      }
    }
    if (cur.length) blocks.push(cur)
    return blocks
  }

  /** 能否把 a 的连续 len 节落在 (day, start) 上：时段在上班表内、无课、未排本人、未超人数上限 */
  const canPlaceBlock = (a: AssistantInput, day: number, start: number, len: number): boolean => {
    const ws = dayWorkSections.get(day)
    const cb = courseBusy.get(a.id)
    for (let s = start; s < start + len; s++) {
      if (!ws?.has(s)) return false
      if (cb?.has(`${day}|c${s}`)) return false
      const key = slotKeyOf(day, `c${s}`)
      if (slotMembers.get(key)?.has(a.id)) return false
      if ((slotCount.get(key) ?? 0) >= rules.maxPerSlot) return false
    }
    return true
  }

  /** 低层原子操作：按 (天, 节号) 指派 / 撤销（保持各累加量一致） */
  function assignAt(a: AssistantInput, day: number, sec: number, source: 'auto' | 'manual'): void {
    const key = slotKeyOf(day, `c${sec}`)
    slotCount.set(key, (slotCount.get(key) ?? 0) + 1)
    slotMembers.get(key)!.add(a.id)
    hours.set(a.id, (hours.get(a.id) ?? 0) + 1)
    busy.get(a.id)!.add(key)
    freeSlotCount.set(a.id, Math.max(0, (freeSlotCount.get(a.id) ?? 1) - 1))
    assignments.push({ dayOfWeek: day, slotKey: `c${sec}`, assistantId: a.id, source })
  }

  function removeAssignment(x: Assignment): void {
    const key = slotKeyOf(x.dayOfWeek, x.slotKey)
    slotCount.set(key, Math.max(0, (slotCount.get(key) ?? 1) - 1))
    slotMembers.get(key)?.delete(x.assistantId)
    hours.set(x.assistantId, Math.max(0, (hours.get(x.assistantId) ?? 1) - 1))
    freeSlotCount.set(x.assistantId, (freeSlotCount.get(x.assistantId) ?? 0) + 1)
    busy.get(x.assistantId)?.delete(key)
    const i = assignments.indexOf(x)
    if (i >= 0) assignments.splice(i, 1)
  }

  /** 策略①：为指定天新建一个连续块（优先已值班天数少者，使排班分散到更多天） */
  function fillDayByNewBlock(day: number): boolean {
    const minLen = Math.max(1, rules.minConsecutiveSections)
    const cands = assistants
      .map((a) => ({ a, remain: rules.maxSectionsPerAssistant - (hours.get(a.id) ?? 0) }))
      .filter((c) => c.remain >= minLen)
      .sort(
        (x, y) =>
          coveredDaysOf(x.a.id) - coveredDaysOf(y.a.id) ||
          y.remain - x.remain ||
          x.a.id - y.a.id,
      )
    for (const { a, remain } of cands) {
      for (const seg of freeSegmentsOf(a, day)) {
        // 从段首起取不超过剩余额度与段长的子块；取不满最少连续节数就换下一个候选
        for (let take = Math.min(seg.len, remain); take >= minLen; take--) {
          if (!canPlaceBlock(a, day, seg.start, take)) continue
          for (let s = seg.start; s < seg.start + take; s++) assignAt(a, day, s, 'auto')
          return true
        }
      }
    }
    return false
  }

  /**
   * 策略②：把某助理在别的天的**整个连续块**搬到 toDay 的空闲连续段上。
   * 仅动用冗余值班：源时段移出后仍须 ≥ minPerSlot，否则放弃该候选。
   * 择优选块：该助理已值班天数少者优先（把值班分散到更多天），再按块短者优先
   * （对人数分布扰动最小），最后按助理 id 保证输出确定性。
   */
  function moveBlockInto(toDay: number): boolean {
    const minLen = Math.max(1, rules.minConsecutiveSections)
    const chunks: Array<{ a: AssistantInput; block: Assignment[] }> = []
    for (const a of assistants) {
      for (const d of workdaysSorted) {
        if (d === toDay) continue
        for (const block of blocksOf(a.id, d)) {
          if (block.length >= minLen) chunks.push({ a, block })
        }
      }
    }
    chunks.sort(
      (x, y) =>
        coveredDaysOf(x.a.id) - coveredDaysOf(y.a.id) ||
        x.block.length - y.block.length ||
        x.a.id - y.a.id,
    )
    for (const { a, block } of chunks) {
      const len = block.length
      const sourceRedundant = block.every(
        (b) => (slotCount.get(slotKeyOf(b.dayOfWeek, b.slotKey)) ?? 0) - 1 >= rules.minPerSlot,
      )
      if (!sourceRedundant) continue
      for (const seg of freeSegmentsOf(a, toDay)) {
        for (let start = seg.start; start + len <= seg.start + seg.len; start++) {
          if (!canPlaceBlock(a, toDay, start, len)) continue
          for (const b of block) removeAssignment(b)
          for (let s = start; s < start + len; s++) assignAt(a, toDay, s, 'auto')
          return true
        }
      }
    }
    return false
  }

  /**
   * 兜底策略③：让位式搬移（仅用于"某天一个人都没有"的情形）。
   *
   * 背景：当工时上限已被用尽（例如 3 人 × 上限 6 节 = 18 人节，却要覆盖 40 个时段），
   * 既没有空闲额度可新建块、也没有任何"冗余"值班可搬（每个已排时段恰好 1 人）。
   * 此时"每个时段都有人"在数学上不可达，但"每天都有人"仍可达——策略②的零损伤
   * 闸门相当于禁止一切搬移，会导致空白天永远无法消除。故此处有意放开该闸门。
   *
   * 代价与边界（重要）：
   * - 被让出的源时段会从"已排"变为"未满足"，进入未满足时段清单交由手动调整兜底；
   *   这是"每天有人"与"每个时段都有人"不可兼得时的显式取舍，非约束被静默破坏。
   * - 硬闸门：源日让出后**必须仍有至少 1 条排班**，绝不把"空白天"转移到另一天。
   * - 课程占用、人数上限、最少连续节数、每人工时上限一律不得违反。
   * - 择优顺序：损伤最小（源时段跌出人数下限的个数）→ 块最短 → 源日值班最多
   *   （从最拥挤的天让出，最接近"平均"）→ 助理 id（保证确定性）。
   */
  function moveBlockIntoForce(toDay: number): boolean {
    const minLen = Math.max(1, rules.minConsecutiveSections)
    const cands: Array<{ a: AssistantInput; block: Assignment[]; damage: number; srcCount: number }> = []
    for (const a of assistants) {
      for (const d of workdaysSorted) {
        if (d === toDay) continue
        const srcCount = assignments.filter((x) => x.dayOfWeek === d).length
        for (const block of blocksOf(a.id, d)) {
          if (block.length < minLen) continue
          // 硬闸门：源日让出整块后不能变成"空白天"
          if (srcCount - block.length < 1) continue
          const damage = block.filter(
            (b) => (slotCount.get(slotKeyOf(b.dayOfWeek, b.slotKey)) ?? 0) - 1 < rules.minPerSlot,
          ).length
          cands.push({ a, block, damage, srcCount })
        }
      }
    }
    cands.sort(
      (x, y) =>
        x.damage - y.damage ||
        x.block.length - y.block.length ||
        y.srcCount - x.srcCount ||
        x.a.id - y.a.id,
    )
    for (const c of cands) {
      const len = c.block.length
      for (const seg of freeSegmentsOf(c.a, toDay)) {
        for (let start = seg.start; start + len <= seg.start + seg.len; start++) {
          if (!canPlaceBlock(c.a, toDay, start, len)) continue
          for (const b of c.block) removeAssignment(b)
          for (let s = start; s < start + len; s++) assignAt(c.a, toDay, s, 'auto')
          return true
        }
      }
    }
    return false
  }

  /**
   * 某天的上班时段是否已"符合要求"：每个节次时段都达到人数下限。
   * 下限取 max(1, minPerSlot)——规则的本意是"避免某天无人值班"，
   * 即使把同时段下限配成 0，"某天一个人都没有"仍应被视为不达标。
   */
  const dayTarget = Math.max(1, rules.minPerSlot)
  const dayMeetsTarget = (day: number): boolean =>
    slots
      .filter((s) => s.dayOfWeek === day)
      .every((s) => (slotCount.get(slotKeyOf(day, s.key)) ?? 0) >= dayTarget)

  /**
   * 每日均衡一趟：
   *   A 档（零损伤）——逐日补足到人数下限：新建连续块 → 冗余值班整块搬移；
   *   B 档（兜底让位）——仍有"整天无人"的工作日时，允许以个别源时段为代价整块搬入。
   */
  function balanceDailyPass(): boolean {
    let changed = false
    for (const day of workdaysSorted) {
      const daySlots = slots.filter((s) => s.dayOfWeek === day).length
      for (let guard = 0; guard < Math.max(1, daySlots); guard++) {
        if (dayMeetsTarget(day)) break
        if (fillDayByNewBlock(day) || moveBlockInto(day)) changed = true
        else break
      }
    }
    // B 档：A 档无法解决的空白天（例如工时上限已用尽、无冗余值班可搬）
    for (const day of workdaysSorted) {
      if (assignments.some((x) => x.dayOfWeek === day)) continue
      if (moveBlockIntoForce(day)) changed = true
    }
    return changed
  }

  if (rules.balanceDaily) {
    // 每趟至少补齐一个时段，最多趟数 = 工作日数 + 2（兜底上限，确保必然终止）
    const maxRounds = workdaysSorted.length + 2
    for (let round = 0; round < maxRounds; round++) {
      if (!balanceDailyPass()) break
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
        // 2026-09-13 修正：排班时段已单节化，"差一节到上限"即为不可再排；
        // 旧判据误用 minPerSlot 作单位，minPerSlot≥2 时会虚报"已达上限"
        atMax: secs + 1 > rules.maxSectionsPerAssistant,
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
  // 入口把关：非法规则（如 weekStart > weekEnd）会让周列表为空、静默产出 0 周结果
  assertRulesValid(rules)
  const weeks: number[] = []
  for (let w = rules.weekStart; w <= rules.weekEnd; w++) weeks.push(w)

  if (rules.uniformMode) {
    const once = scheduleOneWeek({ ...input, weekNo: rules.weekStart }, true)
    return weeks.map((weekNo) => ({ ...once, weekNo, replicated: true }))
  }
  return weeks.map((weekNo) => ({ ...scheduleOneWeek({ ...input, weekNo }), weekNo }))
}

export { scheduleOneWeek }

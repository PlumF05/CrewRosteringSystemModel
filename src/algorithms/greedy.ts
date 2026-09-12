/**
 * 贪心启发式排班算法（ADR-002 第三节选型与流程约定）。
 *
 * 流程：
 *   1. 计算可用性矩阵：助理 × (星期×时段)，课程占用的格子标记忙；
 *   2. 时段按"约束紧度"排序——可用候选人少的时段优先分配（先难后易，
 *      避免紧时段最后没人可用）；
 *   3. 每个时段内，候选人按"空闲程度"排序——可选时段最少的人优先
 *      （稀缺资源先用），平手时按已排节数升序（负载均衡）；
 *   4. 第二遍修复：低于最少工时的助理，在时段未满员处补位；
 *   5. 输出未满足时段清单（人数不足的），交由手动调整兜底（F04）。
 *
 * 纯函数约束：不修改输入、不碰数据库/UI、同输入必同输出（可重放）。
 * 复杂度 O(A×S)（A=助理数，S=时段数），50 人 × 35 时段为毫秒级。
 */
import { weekInRanges } from '../utils/weekParser'
import type {
  Assignment,
  AssistantInput,
  AssistantSummary,
  CourseInput,
  KeepEntry,
  ScheduleInput,
  ScheduleOutput,
  SchedulingRules,
  UnmetSlot,
} from './types'

const slotKeyOf = (day: number, key: string) => `${day}|${key}`

export function scheduleWeek(input: ScheduleInput): ScheduleOutput {
  const t0 = performance.now()
  const { weekNo, rules, assistants, courses, keep } = input

  // ---------- 1. 展开时段槽位 ----------
  const slots = [] as Array<{
    day: number
    key: string
    label: string
    sectionStart: number
    sectionEnd: number
  }>
  for (let day = 1; day <= 7; day++) {
    for (const t of rules.slotTemplates) {
      slots.push({ day, key: t.key, label: t.label, sectionStart: t.sectionStart, sectionEnd: t.sectionEnd })
    }
  }

  // ---------- 2. 可用性矩阵 ----------
  // busy[assistantId] = Set<"day|slotKey">，课程占用 → 忙
  const busy = new Map<number, Set<string>>()
  for (const a of assistants) busy.set(a.id, new Set())

  const isCourseActive = (c: CourseInput) => weekInRanges(weekNo, c.weekRanges)
  const overlaps = (c: CourseInput, s: { sectionStart: number; sectionEnd: number }) =>
    c.sectionStart !== null &&
    c.sectionEnd !== null &&
    c.sectionStart <= s.sectionEnd &&
    c.sectionEnd >= s.sectionStart

  for (const c of courses) {
    if (!isCourseActive(c)) continue
    const set = busy.get(c.assistantId)
    if (!set) continue
    for (const s of slots) {
      if (s.day !== c.dayOfWeek) continue
      // 数字节次按区间重叠判定；非数字节次（中课/晚课）保守按全天占用
      if (c.sectionStart === null || c.sectionEnd === null || overlaps(c, s)) {
        set.add(slotKeyOf(s.day, s.key))
      }
    }
  }

  // ---------- 3. keep 预占（F08 手动保留）：先占坑，容量与个人工时同步扣减 ----------
  const slotCount = new Map<string, number>()
  const slotMembers = new Map<string, Set<number>>()
  for (const s of slots) {
    slotCount.set(slotKeyOf(s.day, s.key), 0)
    slotMembers.set(slotKeyOf(s.day, s.key), new Set())
  }
  const hours = new Map<number, number>()
  for (const a of assistants) hours.set(a.id, 0)

  const assignments: Assignment[] = []
  const keptKeys = new Set<string>()
  for (const k of (keep ?? []) as KeepEntry[]) {
    const key = slotKeyOf(k.dayOfWeek, k.slotKey)
    if (!slotCount.has(key)) continue
    if (slotMembers.get(key)!.has(k.assistantId)) continue
    const hoursPerSlot = slotHours(rules, k.slotKey)
    if ((hours.get(k.assistantId) ?? 0) + hoursPerSlot > rules.maxSectionsPerAssistant) continue
    slotCount.set(key, slotCount.get(key)! + 1)
    slotMembers.get(key)!.add(k.assistantId)
    hours.set(k.assistantId, (hours.get(k.assistantId) ?? 0) + hoursPerSlot)
    assignments.push({ dayOfWeek: k.dayOfWeek, slotKey: k.slotKey, assistantId: k.assistantId, source: 'manual' })
    busy.get(k.assistantId)?.add(key)
    keptKeys.add(key)
  }

  const slotHoursOf = (key: string) => slotHours(rules, key)
  const freeAt = (a: AssistantInput, day: number, key: string) => !busy.get(a.id)!.has(slotKeyOf(day, key))

  // 每个助理的全部可选时段数（稀缺度）
  const freeSlotCount = new Map<number, number>()
  for (const a of assistants) {
    let n = 0
    for (const s of slots) if (freeAt(a, s.day, s.key)) n++
    freeSlotCount.set(a.id, n)
  }

  // ---------- 4. 主分配：时段按紧度排序，逐时段填人 ----------
  const byTightness = [...slots].sort((x, y) => {
    const cx = candidatesFor(x.day, x.key).length
    const cy = candidatesFor(y.day, y.key).length
    if (cx !== cy) return cx - cy
    return slotKeyOf(x.day, x.key).localeCompare(slotKeyOf(y.day, y.key))
  })

  function candidatesFor(day: number, key: string): AssistantInput[] {
    return assistants.filter(
      (a) =>
        freeAt(a, day, key) &&
        (hours.get(a.id) ?? 0) + slotHoursOf(key) <= rules.maxSectionsPerAssistant,
    )
  }

  for (const s of byTightness) {
    const key = slotKeyOf(s.day, s.key)
    if (keptKeys.has(key) && slotCount.get(key)! >= rules.maxPerSlot) continue
    let candidates = candidatesFor(s.day, s.key)
    // 稀缺者优先（可选时段少的人先安排），平手按已排节数升序，再按 id 保证确定性
    candidates = candidates.sort((x, y) => {
      const fx = freeSlotCount.get(x.id)!
      const fy = freeSlotCount.get(y.id)!
      if (fx !== fy) return fx - fy
      const hx = hours.get(x.id)!
      const hy = hours.get(y.id)!
      if (hx !== hy) return hx - hy
      return x.id - y.id
    })
    for (const a of candidates) {
      if (slotCount.get(key)! >= rules.maxPerSlot) break
      if (slotMembers.get(key)!.has(a.id)) continue
      assign(a, s.day, s.key, 'auto')
    }
  }

  function assign(a: AssistantInput, day: number, key: string, source: 'auto' | 'manual') {
    const k = slotKeyOf(day, key)
    slotCount.set(k, (slotCount.get(k) ?? 0) + 1)
    slotMembers.get(k)!.add(a.id)
    const h = slotHoursOf(key)
    hours.set(a.id, (hours.get(a.id) ?? 0) + h)
    busy.get(a.id)!.add(k)
    freeSlotCount.set(a.id, Math.max(0, (freeSlotCount.get(a.id) ?? 1) - 1))
    assignments.push({ dayOfWeek: day, slotKey: key, assistantId: a.id, source })
  }

  // ---------- 5. 第二遍：最少工时修复 ----------
  const belowMin = assistants.filter((a) => (hours.get(a.id) ?? 0) < rules.minSectionsPerAssistant)
  for (const a of belowMin) {
    // 优先补人最少的时段（同时段人数偏少更需要人）
    const order = [...slots].sort((x, y) => {
      const cx = slotCount.get(slotKeyOf(x.day, x.key))!
      const cy = slotCount.get(slotKeyOf(y.day, y.key))!
      if (cx !== cy) return cx - cy
      return slotKeyOf(x.day, x.key).localeCompare(slotKeyOf(y.day, y.key))
    })
    for (const s of order) {
      if ((hours.get(a.id) ?? 0) >= rules.minSectionsPerAssistant) break
      const key = slotKeyOf(s.day, s.key)
      if (slotMembers.get(key)!.has(a.id)) continue
      if (slotCount.get(key)! >= rules.maxPerSlot) continue
      if (!freeAt(a, s.day, s.key)) continue
      if ((hours.get(a.id) ?? 0) + slotHoursOf(s.key) > rules.maxSectionsPerAssistant) continue
      assign(a, s.day, s.key, 'auto')
    }
  }

  // ---------- 6. 汇总 ----------
  const unmetSlots: UnmetSlot[] = []
  for (const s of slots) {
    const key = slotKeyOf(s.day, s.key)
    const actual = slotCount.get(key)!
    if (actual < rules.minPerSlot) {
      unmetSlots.push({
        dayOfWeek: s.day,
        slotKey: s.key,
        short: rules.minPerSlot - actual,
        required: rules.minPerSlot,
        actual,
        reason: `星期${s.day} ${s.label}：可用助理不足`,
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
      (x, y) => x.dayOfWeek - y.dayOfWeek || x.slotKey.localeCompare(y.slotKey) || x.assistantId - y.assistantId,
    ),
    unmetSlots,
    summaries,
    elapsedMs: performance.now() - t0,
  }
}

function slotHours(rules: SchedulingRules, slotKey: string): number {
  const t = rules.slotTemplates.find((x) => x.key === slotKey)
  return t ? t.sectionEnd - t.sectionStart + 1 : 0
}

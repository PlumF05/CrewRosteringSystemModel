import { describe, expect, it } from 'vitest'
import { scheduleWeek } from './greedy'
import {
  DEFAULT_RULES,
  DEFAULT_SLOT_TEMPLATES,
  type CourseInput,
  type ScheduleInput,
  type SchedulingRules,
} from './types'

/**
 * 固定用例单测：全部输入为手工构造的纯数据，输出完全可预期。
 * 每个用例聚焦算法的一个决策点（容量/工时上限/可用性/周次/keep/无解）。
 */

const T12 = { key: '1-2', label: '第一节-第二节', sectionStart: 1, sectionEnd: 2 }
const A = (id: number, name = `助理${id}`) => ({ id, name, identity: 'undergrad' as const })

const baseRules = (over: Partial<SchedulingRules> = {}): SchedulingRules => ({
  ...DEFAULT_RULES,
  weekStart: 1,
  weekEnd: 1,
  minSectionsPerAssistant: 2,
  maxSectionsPerAssistant: 8,
  minPerSlot: 1,
  maxPerSlot: 1,
  slotTemplates: [T12],
  ...over,
})

const mkInput = (over: Partial<ScheduleInput> = {}): ScheduleInput => ({
  weekNo: 1,
  rules: baseRules(),
  assistants: [],
  courses: [],
  ...over,
})

const course = (assistantId: number, day: number, s: number, e: number, weeks: [number, number][] = [[1, 17]]): CourseInput => ({
  assistantId,
  dayOfWeek: day,
  sectionStart: s,
  sectionEnd: e,
  weekRanges: weeks,
})

/** 不变式校验：无论输入如何，输出必须满足容量与工时硬约束 */
function checkInvariants(input: ScheduleInput, out: ReturnType<typeof scheduleWeek>) {
  const counts = new Map<string, number>()
  for (const a of out.assignments) {
    const k = `${a.dayOfWeek}|${a.slotKey}`
    counts.set(k, (counts.get(k) ?? 0) + 1)
  }
  for (const [k, c] of counts) {
    expect(c).toBeLessThanOrEqual(input.rules.maxPerSlot)
  }
  for (const s of out.summaries) {
    expect(s.sections).toBeLessThanOrEqual(input.rules.maxSectionsPerAssistant)
  }
  // 忙的格子不允许有排班（按时段模板的真实节次区间判断重叠）
  for (const a of out.assignments) {
    const tmpl = input.rules.slotTemplates.find((t) => t.key === a.slotKey)!
    const busyCourse = input.courses.some(
      (c) =>
        c.assistantId === a.assistantId &&
        c.dayOfWeek === a.dayOfWeek &&
        c.weekRanges.some(([s, e]) => input.weekNo >= s && input.weekNo <= e) &&
        (c.sectionStart === null ||
          (c.sectionEnd !== null &&
            c.sectionStart <= tmpl.sectionEnd &&
            c.sectionEnd >= tmpl.sectionStart)),
    )
    expect(busyCourse).toBe(false)
  }
}

describe('scheduleWeek（贪心排班）', () => {
  it('单人在工时上限内尽量填满时段', () => {
    const out = scheduleWeek(mkInput({ assistants: [A(1)] }))
    // 7 天 × 2 节，上限 8 节 → 排 4 个时段
    expect(out.summaries[0].sections).toBe(8)
    expect(out.summaries[0].slots).toBe(4)
    expect(out.unmetSlots).toHaveLength(3) // 7 - 4 = 3 个时段缺人
    checkInvariants(mkInput({ assistants: [A(1)] }), out)
  })

  it('两人轮流值班且负载大体均衡（稀缺度优先）', () => {
    const out = scheduleWeek(mkInput({ assistants: [A(1), A(2)] }))
    const [s1, s2] = out.summaries
    expect(s1.slots).toBe(4)
    expect(s2.slots).toBe(3)
    expect(out.unmetSlots).toHaveLength(0)
    checkInvariants(mkInput({ assistants: [A(1), A(2)] }), out)
  })

  it('课程占用 → 该时段不排此人', () => {
    const input = mkInput({
      assistants: [A(1), A(2)],
      courses: [course(1, 1, 1, 2)], // 助理1 星期一第一节-第二节有课
    })
    const out = scheduleWeek(input)
    const day1 = out.assignments.filter((a) => a.dayOfWeek === 1)
    expect(day1).toHaveLength(1)
    expect(day1[0].assistantId).toBe(2)
    checkInvariants(input, out)
  })

  it('周次生效：课程只在其周次范围内占用', () => {
    const input = mkInput({
      assistants: [A(1), A(2)],
      courses: [course(1, 1, 1, 2, [[2, 3]])], // 仅第 2~3 周有课
    })
    const week1 = scheduleWeek({ ...input, weekNo: 1 })
    const week2 = scheduleWeek({ ...input, weekNo: 2 })
    // 第 1 周：两人都可排 → 星期一排的是助理 2（稀缺度优先同分则看已排节数）
    expect(week1.assignments.find((a) => a.dayOfWeek === 1)).toBeTruthy()
    // 第 2 周：助理 1 星期一忙 → 只能是助理 2
    expect(week2.assignments.find((a) => a.dayOfWeek === 1)!.assistantId).toBe(2)
    checkInvariants(input, week1)
    checkInvariants(input, week2)
  })

  it('非数字节次课程（中课/晚课）按全天占用保守处理', () => {
    const input = mkInput({
      assistants: [A(1), A(2)],
      courses: [{ assistantId: 1, dayOfWeek: 1, sectionStart: null, sectionEnd: null, weekRanges: [[1, 17]] }],
    })
    const out = scheduleWeek(input)
    const day1 = out.assignments.filter((a) => a.dayOfWeek === 1)
    expect(day1.map((a) => a.assistantId)).toEqual([2])
    checkInvariants(input, out)
  })

  it('最少工时修复：低于下限的助理在未满时段补位', () => {
    // 助理2 在第 1~4 天全忙 → 只有第 5~7 天可排；minSections=4（2 个时段）
    const input = mkInput({
      rules: baseRules({ minSectionsPerAssistant: 4 }),
      assistants: [A(1), A(2)],
      courses: [
        course(2, 1, 1, 13),
        course(2, 2, 1, 13),
        course(2, 3, 1, 13),
        course(2, 4, 1, 13),
      ],
    })
    const out = scheduleWeek(input)
    const s2 = out.summaries.find((s) => s.assistantId === 2)!
    expect(s2.sections).toBeGreaterThanOrEqual(4) // 修复后达到下限
    expect(s2.belowMin).toBe(false)
    checkInvariants(input, out)
  })

  it('keep 预占：手动安排被保留为 manual 且计入容量', () => {
    const input = mkInput({
      rules: baseRules({ maxPerSlot: 2 }),
      assistants: [A(1), A(2)],
      keep: [{ dayOfWeek: 1, slotKey: '1-2', assistantId: 2 }],
    })
    const out = scheduleWeek(input)
    const day1 = out.assignments.filter((a) => a.dayOfWeek === 1)
    expect(day1.find((a) => a.assistantId === 2)!.source).toBe('manual')
    // 容量 2 → 算法补 1 人
    expect(day1).toHaveLength(2)
    checkInvariants(input, out)
  })

  it('无解场景：没有助理时全部时段进入未满足清单', () => {
    const out = scheduleWeek(mkInput({ assistants: [] }))
    expect(out.assignments).toHaveLength(0)
    expect(out.unmetSlots).toHaveLength(7)
    expect(out.unmetSlots[0].short).toBe(1)
  })

  it('确定性：同输入两次运行输出完全一致', () => {
    const input = mkInput({
      assistants: [A(1), A(2), A(3)],
      courses: [course(2, 3, 1, 2)],
    })
    const r1 = scheduleWeek(input)
    const r2 = scheduleWeek(input)
    expect(JSON.stringify(r1.assignments)).toBe(JSON.stringify(r2.assignments))
  })

  it('性能：10 助理 × 17 周（默认 5 时段）毫秒级完成（SRS 4.1）', () => {
    const assistants = Array.from({ length: 10 }, (_, i) => A(i + 1))
    // 确定性伪随机课程：每人 6 门课，随机分布星期与周次
    let seed = 42
    const rand = (n: number) => (seed = (seed * 1103515245 + 12345) % 2147483648) % n
    const courses: CourseInput[] = []
    for (const a of assistants) {
      for (let i = 0; i < 6; i++) {
        const day = (rand(7) % 7) + 1
        const start = (rand(8) % 8) + 1
        courses.push({
          assistantId: a.id,
          dayOfWeek: day,
          sectionStart: start,
          sectionEnd: Math.min(13, start + 1 + rand(3)),
          weekRanges: [[1, 17]],
        })
      }
    }
    const rules: SchedulingRules = { ...DEFAULT_RULES, slotTemplates: DEFAULT_SLOT_TEMPLATES }
    let total = 0
    let week1Out = null as ReturnType<typeof scheduleWeek> | null
    for (let week = 1; week <= 17; week++) {
      const out = scheduleWeek(mkInput({ weekNo: week, rules, assistants, courses }))
      total += out.elapsedMs
      if (week === 1) week1Out = out
      checkInvariants(mkInput({ weekNo: week, rules, assistants, courses }), out)
    }
    // SRS 4.1：5 秒内完成一次完整排班——这里留 200ms/周的宽裕度
    expect(total / 17).toBeLessThan(200)
    expect(week1Out!.assignments.length).toBeGreaterThan(0)
  })
})

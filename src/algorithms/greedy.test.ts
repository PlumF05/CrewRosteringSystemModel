import { describe, expect, it } from 'vitest'
import { scheduleAll, scheduleOneWeek } from './greedy'
import {
  DEFAULT_RULES,
  type CourseInput,
  type ScheduleInput,
  type SchedulingRules,
} from './types'

/**
 * 固定用例单测：全部输入为手工构造的纯数据，输出完全可预期。
 * 覆盖：容量/工时硬约束、课程占用、周次、工作日×上班节次推导、
 * uniform 模式、课程类别过滤、keep 预占、无解、确定性、性能。
 */

const A = (id: number, name = `助理${id}`) => ({ id, name, identity: 'undergrad' as const })

/** 小规则：周一~周日 × 第1~2节（7 个时段，每段 2 节）——与旧版用例数字对齐 */
const baseRules = (over: Partial<SchedulingRules> = {}): SchedulingRules => ({
  ...DEFAULT_RULES,
  weekStart: 1,
  weekEnd: 1,
  minSectionsPerAssistant: 2,
  maxSectionsPerAssistant: 8,
  minPerSlot: 1,
  maxPerSlot: 1,
  workdays: [1, 2, 3, 4, 5, 6, 7],
  workSections: [{ start: 1, end: 2, label: '上午' }],
  uniformMode: false,
  countTheory: true,
  countExperiment: true,
  ...over,
})

const mkInput = (over: Partial<ScheduleInput> = {}): ScheduleInput => ({
  weekNo: 1,
  rules: baseRules(),
  assistants: [],
  courses: [],
  ...over,
})

const course = (
  assistantId: number,
  day: number,
  s: number,
  e: number,
  weeks: [number, number][] = [[1, 17]],
  kind: CourseInput['kind'] = 'theory',
): CourseInput => ({ assistantId, dayOfWeek: day, sectionStart: s, sectionEnd: e, weekRanges: weeks, kind })

/** 不变式校验：无论输入如何，输出必须满足容量与工时硬约束 + 不排忙格 */
function checkInvariants(input: ScheduleInput, out: ReturnType<typeof scheduleOneWeek>) {
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
  // 忙的格子不允许有排班（时段=单节，按时节号判断课程是否覆盖该节）
  for (const a of out.assignments) {
    const secNum = Number(a.slotKey.slice(1))
    const busyCourse = input.courses.some(
      (c) =>
        c.assistantId === a.assistantId &&
        c.dayOfWeek === a.dayOfWeek &&
        c.weekRanges.some(([s, e]) => input.weekNo >= s && input.weekNo <= e) &&
        (c.sectionStart === null ||
          (c.sectionEnd !== null && c.sectionStart <= secNum && c.sectionEnd >= secNum)),
    )
    expect(busyCourse).toBe(false)
  }
}

describe('scheduleOneWeek（贪心排班）', () => {
  it('单人在工时上限内尽量填满时段', () => {
    const input = mkInput({ assistants: [A(1)] })
    const out = scheduleOneWeek(input)
    // 7 天 × 2 个单节时段（c1/c2），上限 8 节 → 排 8 个时段
    expect(out.summaries[0].sections).toBe(8)
    expect(out.summaries[0].slots).toBe(8)
    expect(out.unmetSlots).toHaveLength(6)
    checkInvariants(input, out)
  })

  it('两人轮流值班且负载大体均衡（稀缺度优先）', () => {
    const input = mkInput({ assistants: [A(1), A(2)] })
    const out = scheduleOneWeek(input)
    expect(out.summaries[0].slots).toBe(7)
    expect(out.summaries[1].slots).toBe(7)
    expect(out.unmetSlots).toHaveLength(0)
    checkInvariants(input, out)
  })

  it('课程占用 → 该时段不排此人', () => {
    const input = mkInput({
      assistants: [A(1), A(2)],
      courses: [course(1, 1, 1, 2)],
    })
    const out = scheduleOneWeek(input)
    const day1 = out.assignments.filter((a) => a.dayOfWeek === 1)
    // 周一两个单节时段（c1/c2），助理 1 都被课占用 → 都排助理 2
    expect(day1.map((a) => a.assistantId)).toEqual([2, 2])
    checkInvariants(input, out)
  })

  it('周次生效：课程只在其周次范围内占用', () => {
    const input = mkInput({
      assistants: [A(1), A(2)],
      courses: [course(1, 1, 1, 2, [[2, 3]])],
    })
    const week1 = scheduleOneWeek({ ...input, weekNo: 1 })
    const week2 = scheduleOneWeek({ ...input, weekNo: 2 })
    expect(week1.assignments.find((a) => a.dayOfWeek === 1)).toBeTruthy()
    expect(week2.assignments.find((a) => a.dayOfWeek === 1)!.assistantId).toBe(2)
    checkInvariants(input, week1)
    checkInvariants(input, week2)
  })

  it('非数字节次课程（中课/晚课）按全天占用保守处理', () => {
    const input = mkInput({
      assistants: [A(1), A(2)],
      courses: [{ assistantId: 1, dayOfWeek: 1, sectionStart: null, sectionEnd: null, weekRanges: [[1, 17]] }],
    })
    const out = scheduleOneWeek(input)
    expect(out.assignments.filter((a) => a.dayOfWeek === 1).map((a) => a.assistantId)).toEqual([2, 2])
    checkInvariants(input, out)
  })

  it('keep 预占：手动安排被保留为 manual 且计入容量', () => {
    const input = mkInput({
      rules: baseRules({ maxPerSlot: 2 }),
      assistants: [A(1), A(2)],
      keep: [{ dayOfWeek: 1, slotKey: 'c1', assistantId: 2 }],
    })
    const out = scheduleOneWeek(input)
    const day1 = out.assignments.filter((a) => a.dayOfWeek === 1)
    expect(day1.find((a) => a.assistantId === 2)!.source).toBe('manual')
    // 周一两个单节时段（c1/c2），每时段容量 2 → 共 4 条
    expect(day1).toHaveLength(4)
    checkInvariants(input, out)
  })

  it('无解场景：没有助理时全部时段进入未满足清单', () => {
    const out = scheduleOneWeek(mkInput({ assistants: [] }))
    expect(out.assignments).toHaveLength(0)
    expect(out.unmetSlots).toHaveLength(14)
    expect(out.unmetSlots[0].short).toBe(1)
  })

  it('确定性：同输入两次运行输出完全一致', () => {
    const input = mkInput({
      assistants: [A(1), A(2), A(3)],
      courses: [course(2, 3, 1, 2)],
    })
    const r1 = scheduleOneWeek(input)
    const r2 = scheduleOneWeek(input)
    expect(JSON.stringify(r1.assignments)).toBe(JSON.stringify(r2.assignments))
  })
})

describe('新需求：工作日 × 上班节次推导时段', () => {
  it('默认工作日（周一~五）+ 默认上班节次 → 10 个时段，周末不排班', () => {
    const rules = baseRules({
      weekStart: 1,
      weekEnd: 1,
      workdays: [1, 2, 3, 4, 5],
      workSections: [
        { start: 1, end: 4, label: '上午' },
        { start: 8, end: 11, label: '下午' },
      ],
    })
    const out = scheduleOneWeek(mkInput({ rules, assistants: [A(1), A(2)] }))
    const days = new Set(out.assignments.map((a) => a.dayOfWeek))
    expect([...days].every((d) => d <= 5)).toBe(true)
    const keys = new Set(out.assignments.map((a) => a.slotKey))
    expect([...keys].every((k) => /^c([1-4]|8|9|1[01])$/.test(k))).toBe(true)
    // 时段键按节次显示
    expect(out.unmetSlots.every((u) => u.slotKey.startsWith('c'))).toBe(true)
  })

  it('上班节次之外的课程不产生占用（第 5~7 节不在 1~4/8~11 内）', () => {
    const rules = baseRules({
      workdays: [1],
      workSections: [{ start: 1, end: 4, label: '上午' }],
    })
    const input = mkInput({
      rules,
      assistants: [A(1), A(2)],
      courses: [course(1, 1, 5, 7)], // 下午之前的时间，不上班时段
    })
    const out = scheduleOneWeek(input)
    // 助理 1 不受该课影响，仍可被排
    expect(out.assignments.some((a) => a.assistantId === 1)).toBe(true)
  })
})

describe('新需求：课程类别过滤（本/实）', () => {
  it('关闭实验课占用 → 实验课不再挡人', () => {
    const expCourse = course(1, 1, 1, 2, [[1, 17]], 'experiment')
    const input = mkInput({
      assistants: [A(1), A(2)],
      courses: [expCourse],
    })
    // 开启：助理 1 星期一被实验课占用
    const withExp = scheduleOneWeek(input)
    expect(withExp.assignments.find((a) => a.dayOfWeek === 1)!.assistantId).toBe(2)
    // 关闭：助理 1 恢复可选
    const withoutExp = scheduleOneWeek({
      ...input,
      rules: baseRules({ countExperiment: false }),
    })
    expect(withoutExp.assignments.some((a) => a.dayOfWeek === 1 && a.assistantId === 1)).toBe(true)
  })

  it('关闭理论课占用 → 理论课不再挡人（实验课仍占用）', () => {
    const input = mkInput({
      rules: baseRules({ countTheory: false }),
      assistants: [A(1), A(2)],
      courses: [course(1, 1, 1, 2, [[1, 17]], 'theory'), course(1, 2, 1, 2, [[1, 17]], 'experiment')],
    })
    const out = scheduleOneWeek(input)
    expect(out.assignments.some((a) => a.dayOfWeek === 1 && a.assistantId === 1)).toBe(true)
    expect(out.assignments.find((a) => a.dayOfWeek === 2)!.assistantId).toBe(2)
  })

  it('旧数据无 kind 字段：按 note 回退判定（note 存在 = 实验课）', () => {
    const input = mkInput({
      rules: baseRules({ countExperiment: false }),
      assistants: [A(1), A(2)],
      courses: [
        { assistantId: 1, dayOfWeek: 1, sectionStart: 1, sectionEnd: 2, weekRanges: [[1, 17]] }, // 无 kind 无 note → theory，仍占用
        { assistantId: 2, dayOfWeek: 1, sectionStart: 1, sectionEnd: 2, weekRanges: [[1, 17]], kind: 'experiment' }, // 被过滤
      ],
    })
    const out = scheduleOneWeek(input)
    // 实验课被过滤 → 助理 2 可排；理论课仍占用 → 助理 1 不可排
    expect(out.assignments.find((a) => a.dayOfWeek === 1)!.assistantId).toBe(2)
  })
})

describe('新需求：一次性全周期排班与 uniform 模式', () => {
  it('各周独立模式：逐周按当周课程占用计算', () => {
    const input = {
      rules: baseRules({ weekStart: 1, weekEnd: 2 }),
      assistants: [A(1), A(2)],
      courses: [course(1, 1, 1, 2, [[2, 2]])], // 助理1 仅第 2 周周中有课
    }
    const all = scheduleAll(input)
    expect(all.map((w) => w.weekNo)).toEqual([1, 2])
    expect(all[0].assignments.some((a) => a.dayOfWeek === 1 && a.assistantId === 1)).toBe(true)
    expect(all[1].assignments.some((a) => a.dayOfWeek === 1 && a.assistantId === 1)).toBe(false)
  })

  it('uniform 模式：任一周有课即占用，各周排班完全相同', () => {
    const input = {
      rules: baseRules({ weekStart: 1, weekEnd: 3, uniformMode: true }),
      assistants: [A(1), A(2)],
      courses: [course(1, 1, 1, 2, [[2, 2]])], // 仅第 2 周有课
    }
    const all = scheduleAll(input)
    expect(all).toHaveLength(3)
    // 第 1 周也不给助理 1 排周一（虽然他第 1 周没课）——统一方案的代价与语义
    expect(all.every((w) => w.replicated)).toBe(true)
    expect(all.every((w) => !w.assignments.some((a) => a.dayOfWeek === 1 && a.assistantId === 1))).toBe(true)
    // 各周方案相同
    expect(JSON.stringify(all[0].assignments)).toBe(JSON.stringify(all[1].assignments))
    expect(JSON.stringify(all[1].assignments)).toBe(JSON.stringify(all[2].assignments))
  })
})

describe('性能（SRS 4.1）', () => {
  it('10 助理 × 17 周（默认工作日/节次）毫秒级完成', () => {
    const assistants = Array.from({ length: 10 }, (_, i) => A(i + 1))
    let seed = 42
    const rand = (n: number) => (seed = (seed * 1103515245 + 12345) % 2147483648) % n
    const courses: CourseInput[] = []
    for (const a of assistants) {
      for (let i = 0; i < 6; i++) {
        const day = (rand(5) % 5) + 1 // 只在工作日排课
        const start = rand(2) === 0 ? 1 : 8
        courses.push({
          assistantId: a.id,
          kind: rand(2) === 0 ? 'theory' : 'experiment',
          dayOfWeek: day,
          sectionStart: start,
          sectionEnd: start + 3,
          weekRanges: [[1, 17]],
        })
      }
    }
    const rules: SchedulingRules = { ...DEFAULT_RULES }
    const out = scheduleAll({ rules, assistants, courses })
    expect(out).toHaveLength(17)
    const total = out.reduce((s, w) => s + w.elapsedMs, 0)
    expect(total / 17).toBeLessThan(200)
    out.forEach((w) => checkInvariants({ ...{ rules, assistants, courses }, weekNo: w.weekNo }, w))
  })
})

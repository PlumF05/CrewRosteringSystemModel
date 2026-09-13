import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
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

describe('新需求：最少连续排班节次', () => {
  const rulesMin2 = baseRules({
    workdays: [1],
    workSections: [{ start: 8, end: 11, label: '下午' }],
    minSectionsPerAssistant: 2,
    maxSectionsPerAssistant: 8,
    minPerSlot: 1,
    maxPerSlot: 2,
    minConsecutiveSections: 2,
  })

  it('用户场景：第9~10节有课 + min=2 → 第8节和第11节都不排给他（孤立单节）', () => {
    const input = mkInput({
      rules: rulesMin2,
      assistants: [A(1), A(2)],
      courses: [course(1, 1, 9, 10)],
    })
    const out = scheduleOneWeek(input)
    // 助理 1 的可值班连续段只有 {8} 和 {11}，都短于 2 → 全天不可排
    expect(out.assignments.some((a) => a.assistantId === 1)).toBe(false)
    // 第 11 节由助理 2 值班（不会被孤立地排给助理 1）
    expect(out.assignments.filter((a) => a.slotKey === 'c11').every((a) => a.assistantId === 2)).toBe(true)
    checkInvariants(input, out)
  })

  it('只缺第10节 + min=2 → 第8~9节可连排，第11节不可排', () => {
    const input = mkInput({
      rules: rulesMin2,
      assistants: [A(1), A(2)],
      courses: [course(1, 1, 10, 10)],
    })
    const out = scheduleOneWeek(input)
    const a1Slots = out.assignments.filter((a) => a.assistantId === 1).map((a) => a.slotKey)
    expect(a1Slots).not.toContain('c11')
    expect(a1Slots.some((k) => k === 'c8' || k === 'c9')).toBe(true)
    checkInvariants(input, out)
  })

  it('min=3 + 两人竞争：连续块不足 3 节的孤立安排被自动撤销', () => {
    const input = mkInput({
      rules: baseRules({
        workdays: [1],
        workSections: [{ start: 8, end: 11, label: '下午' }],
        minSectionsPerAssistant: 2,
        maxPerSlot: 1,
        minConsecutiveSections: 3,
      }),
      assistants: [A(1), A(2)],
      courses: [course(1, 1, 10, 10)], // 助理1 第10节有课 → 其可用段 {8,9} 与 {11}
    })
    const out = scheduleOneWeek(input)
    // 助理1 拿到 {8,9}（连续 2 节仍 <3？不：其可值班段 {8,9} 长度 2 < 3 → 也应被守卫拒绝）
    const a1Slots = out.assignments.filter((a) => a.assistantId === 1).map((a) => a.slotKey)
    expect(a1Slots).not.toContain('c11')
    // 任何助理都不应有长度 <3 的连续块
    const byAD = new Map<string, number[]>()
    for (const a of out.assignments) {
      const k = `${a.assistantId}|${a.dayOfWeek}`
      byAD.set(k, [...(byAD.get(k) ?? []), Number(a.slotKey.slice(1))])
    }
    for (const [, secs] of byAD) {
      const sorted = secs.sort((x, y) => x - y)
      let len = 1
      for (let i = 1; i < sorted.length; i++) {
        if (sorted[i] === sorted[i - 1] + 1) len++
        else {
          expect(len).toBeGreaterThanOrEqual(3)
          len = 1
        }
      }
      expect(len).toBeGreaterThanOrEqual(3)
    }
  })

  it('min=1（默认）→ 无连续性限制，第 11 节可正常排', () => {
    const input = mkInput({
      rules: baseRules({
        workdays: [1],
        workSections: [{ start: 8, end: 11, label: '下午' }],
        maxPerSlot: 2,
      }),
      assistants: [A(1), A(2)],
      courses: [course(1, 1, 9, 10)],
    })
    const out = scheduleOneWeek(input)
    expect(out.assignments.some((a) => a.assistantId === 1 && a.slotKey === 'c11')).toBe(true)
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

describe('回归：三助理真实数据（缺陷案例——撤销孤立块后未再补位）', () => {
  // 夹具来自用户实测数据：3 人、min=6/max=6、最少连续 2 节、131 条课程。
  // 缺陷现象：庞士豪被撤销孤立块后停在 4 节（低于下限 6）且不再补位。
  const fixture = JSON.parse(
    readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '__fixtures__/regression-3assistants.json'), 'utf-8'),
  )

  it('撤销孤立块后应继续补位，庞士豪达到下限 6 节', () => {
    const out = scheduleAll({
      rules: fixture.rules,
      assistants: fixture.assistants,
      courses: fixture.courses,
    })
    const w1 = out.find((w) => w.weekNo === 1)!
    const psh = w1.summaries.find((s) => s.name === '庞士豪')!
    expect(psh.belowMin).toBe(false)
    expect(psh.sections).toBe(6)

    // 全体助理每天的连续块都必须 ≥ 2（手动项不存在于此数据）
    const byAD = new Map<string, number[]>()
    for (const a of w1.assignments) {
      const k = `${a.assistantId}|${a.dayOfWeek}`
      byAD.set(k, [...(byAD.get(k) ?? []), Number(a.slotKey.slice(1))])
    }
    for (const [, secs] of byAD) {
      const sorted = secs.sort((x, y) => x - y)
      let len = 1
      const check = () => expect(len).toBeGreaterThanOrEqual(2)
      for (let i = 1; i < sorted.length; i++) {
        if (sorted[i] === sorted[i - 1] + 1) len++
        else {
          check()
          len = 1
        }
      }
      check()
    }
  })
})

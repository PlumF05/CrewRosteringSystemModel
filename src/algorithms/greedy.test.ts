import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { scheduleAll, scheduleOneWeek } from './greedy'
import { sectionOrdinal, sectionOrdinalRange } from '../utils/sectionOrder'
import {
  DEFAULT_RULES,
  buildSlots,
  formatSectionLabel,
  normalizeRules,
  validateRules,
  type CourseInput,
  type ScheduleInput,
  type SchedulingRules,
} from './types'

/**
 * 固定用例单测：全部输入为手工构造的纯数据，输出完全可预期。
 * 覆盖：容量/工时硬约束、课程占用、周次、工作日×上班节次推导、
 * uniform 模式、课程类别过滤、keep 预占、无解、确定性、性能、每日均衡。
 */

const A = (id: number, name = `助理${id}`) => ({ id, name, identity: 'undergrad' as const })

/**
 * 小规则：周一~周日 × 第1~2节（7 个时段，每段 2 节）——与旧版用例数字对齐。
 * 注意：显式关闭 balanceDaily，使既有用例保持"纯贪心主分配"的原始语义基线；
 * 每日均衡由下方独立 describe 专项覆盖（2026-09-13 增补）。
 */
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
  balanceDaily: false,
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
): CourseInput => ({
  assistantId,
  dayOfWeek: day,
  // 2026-09-13：算法入参改为节次原文（内部换算节次序号），不再直接吃数字节号
  sectionText: s === e ? `第${s}节` : `第${s}节-第${e}节`,
  weekRanges: weeks,
  kind,
})

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
    // 按**该助理生效的上限**校验：设了个性化上限的助理可以高于（也可低于）全局上限
    expect(s.sections).toBeLessThanOrEqual(s.maxSections)
  }
  // 忙的格子不允许有排班（时段=单节；课程与时段都换算到"节次序号"后判重叠）
  for (const a of out.assignments) {
    const secNum = Number(a.slotKey.slice(1))
    const ord = sectionOrdinal(String(secNum))
    const busyCourse = input.courses.some((c) => {
      if (c.assistantId !== a.assistantId || c.dayOfWeek !== a.dayOfWeek) return false
      if (!c.weekRanges.some(([s, e]) => input.weekNo >= s && input.weekNo <= e)) return false
      const range = sectionOrdinalRange(c.sectionText)
      // 与算法一致：节次无法识别时保守视为占用
      if (range === null || ord === null) return true
      return range.start <= ord && range.end >= ord
    })
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

  it('节次原文无法识别时按整天占用保守处理（宁可少排，不在课上排班）', () => {
    const input = mkInput({
      assistants: [A(1), A(2)],
      courses: [{ assistantId: 1, dayOfWeek: 1, sectionText: '待定', weekRanges: [[1, 17]] }],
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
  it('默认工作日（周一~五）+ 上班节次（上午 1~4、下午 6~9）→ 周末不排班', () => {
    const rules = baseRules({
      weekStart: 1,
      weekEnd: 1,
      workdays: [1, 2, 3, 4, 5],
      workSections: [
        { start: 1, end: 4, label: '上午' },
        { start: 6, end: 9, label: '下午' },
      ],
    })
    const out = scheduleOneWeek(mkInput({ rules, assistants: [A(1), A(2)] }))
    const days = new Set(out.assignments.map((a) => a.dayOfWeek))
    expect([...days].every((d) => d <= 5)).toBe(true)
    const keys = new Set(out.assignments.map((a) => a.slotKey))
    expect([...keys].every((k) => /^c([1-4]|6|7|8|9)$/.test(k))).toBe(true)
    // 时段键按节次显示
    expect(out.unmetSlots.every((u) => u.slotKey.startsWith('c'))).toBe(true)
  })

  it('上班节次之外的课程不产生占用（课程落在第 5~7 节，不在上班节次 1~4 内）', () => {
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
        { assistantId: 1, dayOfWeek: 1, sectionText: '第一节-第二节', weekRanges: [[1, 17]] }, // 无 kind 无 note → theory，仍占用
        { assistantId: 2, dayOfWeek: 1, sectionText: '第一节-第二节', weekRanges: [[1, 17]], kind: 'experiment' }, // 被过滤
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
        const start = rand(2) === 0 ? 1 : 6
        courses.push({
          assistantId: a.id,
          kind: rand(2) === 0 ? 'theory' : 'experiment',
          dayOfWeek: day,
          sectionText: `第${start}节-第${start + 3}节`,
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
  // 2026-09-13 重建：补齐"节次原文"，并把 rules 的下午节次对齐为课程表编号 6~9。
  const fixture = JSON.parse(
    readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '__fixtures__/regression-3assistants.json'), 'utf-8'),
  )

  it('撤销孤立块后应继续补位，示例学生C达到下限 6 节', () => {
    const out = scheduleAll({
      rules: fixture.rules,
      assistants: fixture.assistants,
      courses: fixture.courses,
    })
    const w1 = out.find((w) => w.weekNo === 1)!
    const psh = w1.summaries.find((s) => s.name === '示例学生C')!
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

  // 该项直接对应缺陷投诉"在有课时仍然排班"：使用真实课程表数据（131 条，含中课/晚课），
  // 逐周校验每一条排班都不得落在该助理有课的节次上（含节次序号换算与命名节次）。
  it('全周期真实数据：任何一周都不得把助理排在其有课的节次上', () => {
    const input = {
      rules: { ...fixture.rules, balanceDaily: true },
      assistants: fixture.assistants,
      courses: fixture.courses,
    }
    const out = scheduleAll(input)
    expect(out).toHaveLength(17)
    for (const w of out) {
      expect(w.assignments.length).toBeGreaterThan(0)
      checkInvariants({ ...input, weekNo: w.weekNo }, w)
    }
  })

  /**
   * 编号修正后（2026-09-13）：第 1 周自然覆盖全部工作日——旧编号下"周五整天无人"本身就是
   * 节次错配的产物（课程表第6节被当成排班第6节，占用判定错位导致分布畸形）。
   * 每日均衡规则在其余周次仍能进一步消除"整天无人"，且不牺牲排班总量与每人工时。
   * 已知边界：本夹具 3 人 × 上限 6 节 = 18 人节却要覆盖 40 个时段，"每时段都有人"不可达。
   */
  it('编号修正后每周均有人值班；每日均衡进一步减少"整天无人"且不增加未满足时段', () => {
    const base = { assistants: fixture.assistants, courses: fixture.courses }
    const off = scheduleAll({ ...base, rules: { ...fixture.rules, balanceDaily: false } })
    const on = scheduleAll({ ...base, rules: { ...fixture.rules, balanceDaily: true } })
    const w1off = off.find((w) => w.weekNo === 1)!
    const w1on = on.find((w) => w.weekNo === 1)!

    /** 全周期"整天无人"的工作日计数 */
    const emptyDayCount = (out: typeof off): number => {
      let n = 0
      for (const w of out) {
        for (const d of [1, 2, 3, 4, 5]) if (!w.assignments.some((x) => x.dayOfWeek === d)) n++
      }
      return n
    }

    // 第 1 周：周一~周五都有人（无需均衡介入）
    for (const d of [1, 2, 3, 4, 5]) {
      expect(w1off.assignments.some((x) => x.dayOfWeek === d)).toBe(true)
    }
    // 每日均衡不劣化：空白天次与未满足时段均不增加（实测 13→3、401→378）
    expect(emptyDayCount(on)).toBeLessThanOrEqual(emptyDayCount(off))
    expect(on.reduce((s, w) => s + w.unmetSlots.length, 0)).toBeLessThanOrEqual(
      off.reduce((s, w) => s + w.unmetSlots.length, 0),
    )
    // 只是搬移：排班总量与每人工时守恒
    expect(w1on.assignments.length).toBe(w1off.assignments.length)
    expect(w1on.summaries.map((s) => s.sections)).toEqual(w1off.summaries.map((s) => s.sections))

    checkInvariants({ weekNo: 1, rules: { ...fixture.rules, balanceDaily: true }, ...base }, w1on)

    // 确定性：全部排序都有 id 级 tie-break，无随机与时间依赖
    const on2 = scheduleAll({ ...base, rules: { ...fixture.rules, balanceDaily: true } })
    expect(JSON.stringify(on2.map((w) => w.assignments))).toBe(JSON.stringify(on.map((w) => w.assignments)))
  })
})

describe('每日均衡排班（2026-09-13 增补，规则 balanceDaily）', () => {
  /** 某天是否"达标"：该天所有节次时段都达到人数下限（下限 = max(1, minPerSlot)） */
  const dayOk = (out: ReturnType<typeof scheduleOneWeek>, day: number) =>
    !out.unmetSlots.some((u) => u.dayOfWeek === day)
  const okDays = (out: ReturnType<typeof scheduleOneWeek>, days: number[]) =>
    days.filter((d) => dayOk(out, d))
  const sectionsByName = (out: ReturnType<typeof scheduleOneWeek>) =>
    new Map(out.summaries.map((s) => [s.name, s.sections]))

  it('用户场景：周一~周四已排妥而周五无人 → 从冗余值班整块搬移补上周五', () => {
    const rules = baseRules({
      workdays: [1, 5],
      workSections: [{ start: 1, end: 1, label: '上午' }],
      minSectionsPerAssistant: 1,
      maxSectionsPerAssistant: 1,
      minPerSlot: 1,
      maxPerSlot: 2,
      minConsecutiveSections: 1,
      balanceDaily: true,
    })
    const assistants = [A(1), A(2)]

    // 关闭均衡：容量被周一吃光，周五整天无人
    const off = scheduleOneWeek(mkInput({ rules: { ...rules, balanceDaily: false }, assistants }))
    expect(off.assignments).toHaveLength(2)
    expect(off.assignments.every((x) => x.dayOfWeek === 1)).toBe(true)
    expect(off.unmetSlots).toHaveLength(1)
    expect(dayOk(off, 5)).toBe(false)

    // 开启均衡：把周一的一条冗余值班整块搬到周五
    const on = scheduleOneWeek(mkInput({ rules, assistants }))
    expect(on.unmetSlots).toHaveLength(0)
    expect(dayOk(on, 5)).toBe(true)
    expect(on.assignments.some((x) => x.dayOfWeek === 5)).toBe(true)
    // 仅搬移不新增：总数与每人节数都不变
    expect(on.assignments).toHaveLength(2)
    expect([...sectionsByName(on).values()]).toEqual([1, 1])
    checkInvariants(mkInput({ rules, assistants }), on)
  })

  it('最少连续 2 节时按"连续块"整体搬移，不产生孤立单节', () => {
    const rules = baseRules({
      workdays: [1, 5],
      workSections: [{ start: 1, end: 2, label: '上午' }],
      minConsecutiveSections: 2,
      minSectionsPerAssistant: 2,
      maxSectionsPerAssistant: 2,
      minPerSlot: 1,
      maxPerSlot: 2,
      balanceDaily: true,
    })
    const assistants = [A(1), A(2)]

    const off = scheduleOneWeek(mkInput({ rules: { ...rules, balanceDaily: false }, assistants }))
    expect(dayOk(off, 5)).toBe(false)
    expect(off.assignments.every((x) => x.dayOfWeek === 1)).toBe(true)

    const on = scheduleOneWeek(mkInput({ rules, assistants }))
    expect(on.unmetSlots).toHaveLength(0)
    expect(dayOk(on, 5)).toBe(true)
    // 每天恰好一人、每人 2 节（必须是整块 2 节一起搬，单节搬会违反连续性）
    for (const day of [1, 5]) {
      expect(on.assignments.filter((x) => x.dayOfWeek === day)).toHaveLength(2)
    }
    const daysPerAssistant = new Map<number, Set<number>>()
    for (const x of on.assignments) {
      if (!daysPerAssistant.has(x.assistantId)) daysPerAssistant.set(x.assistantId, new Set())
      daysPerAssistant.get(x.assistantId)!.add(x.dayOfWeek)
    }
    // 两人各自负责一整天，且各自每天恰好连续 2 节
    expect([...daysPerAssistant.values()].map((s) => s.size)).toEqual([1, 1])
    checkInvariants(mkInput({ rules, assistants }), on)
  })

  it('让位式搬移的硬闸门：绝不把"空白天"转移给别的日期', () => {
    const rules = baseRules({
      workdays: [1, 5],
      workSections: [{ start: 1, end: 2, label: '上午' }],
      minConsecutiveSections: 2,
      minSectionsPerAssistant: 0,
      maxSectionsPerAssistant: 2,
      minPerSlot: 1,
      maxPerSlot: 2,
      balanceDaily: true,
    })
    const assistants = [A(1)]
    const out = scheduleOneWeek(mkInput({ rules, assistants }))
    // 唯一助理 2 节额度已全部用在第 1 天；若把它搬到第 5 天，第 1 天就会变成空白天，
    // 属于"把问题转移出去"，必须被 B 档闸门拒绝 —— 宁可周五无人也不制造新的空白天。
    expect(out.assignments.every((x) => x.dayOfWeek === 1)).toBe(true)
    expect(dayOk(out, 1)).toBe(true)
    expect(dayOk(out, 5)).toBe(false)
    expect(out.unmetSlots).toHaveLength(2)
    checkInvariants(mkInput({ rules, assistants }), out)
  })

  it('均衡开启后达标天数增加、排班总量守恒，且输出确定可重放', () => {
    const rules = baseRules({
      workdays: [1, 2, 3, 4, 5],
      workSections: [{ start: 1, end: 1, label: '上午' }],
      minSectionsPerAssistant: 1,
      maxSectionsPerAssistant: 1,
      minPerSlot: 1,
      maxPerSlot: 2,
      minConsecutiveSections: 1,
      balanceDaily: true,
    })
    const assistants = [A(1), A(2)]
    const days = [1, 2, 3, 4, 5]

    const off = scheduleOneWeek(mkInput({ rules: { ...rules, balanceDaily: false }, assistants }))
    const on = scheduleOneWeek(mkInput({ rules, assistants }))

    // 关闭时仅周一有人（其余 4 天均无）；开启后至少把周一的一条值班分给周二
    expect(okDays(off, days)).toEqual([1])
    expect(okDays(on, days)).toEqual([1, 2])
    expect(on.assignments).toHaveLength(off.assignments.length)
    expect([...sectionsByName(on).values()]).toEqual([1, 1])
    checkInvariants(mkInput({ rules, assistants }), on)

    // 确定性：同输入两次运行结果完全一致（均衡阶段不含随机与时间依赖）
    const again = scheduleOneWeek(mkInput({ rules, assistants }))
    expect(JSON.stringify(again.assignments)).toBe(JSON.stringify(on.assignments))
    expect(JSON.stringify(again.unmetSlots)).toBe(JSON.stringify(on.unmetSlots))
  })

  it('规则兼容：新装默认开启；旧配置缺字段时回填为 true，也可显式关闭', () => {
    expect(DEFAULT_RULES.balanceDaily).toBe(true)
    // 旧版 config 表里没有 balanceDaily 字段 → normalizeRules 回填默认（开启）
    expect(normalizeRules({ weekStart: 1, weekEnd: 17 }).balanceDaily).toBe(true)
    // 非法值同样回填
    expect(normalizeRules({ balanceDaily: 'yes' as unknown as boolean }).balanceDaily).toBe(true)
    // 显式关闭必须保留
    expect(normalizeRules({ balanceDaily: false }).balanceDaily).toBe(false)
  })
})

describe('节次上课时间标注（2026-09-13 增补）', () => {
  it('buildSlots 的 label 在节次后附带上课时间', () => {
    const slots = buildSlots(
      baseRules({
        workdays: [1],
        workSections: [
          { start: 1, end: 4, label: '上午' },
          { start: 6, end: 9, label: '下午' },
        ],
      }),
    )
    expect(slots.map((s) => s.label)).toEqual([
      '上午 第1节 8:00~8:45',
      '上午 第2节 8:50~9:35',
      '上午 第3节 9:55~10:40',
      '上午 第4节 10:45~11:30',
      '下午 第6节 14:00~14:45',
      '下午 第7节 14:50~15:35',
      '下午 第8节 15:40~16:25',
      '下午 第9节 16:45~17:30',
    ])
    // 时段键不受影响（仍是 c{节号}），保证已落库数据可继续解读
    expect(slots.map((s) => s.key)).toEqual([
      'c1', 'c2', 'c3', 'c4', 'c6', 'c7', 'c8', 'c9',
    ])
  })

  it('未登记时间的节次退化为「上午 第5节」，不留空占位', () => {
    expect(formatSectionLabel('上午', 5)).toBe('上午 第5节')
    expect(formatSectionLabel('加时', 13)).toBe('加时 第13节')
  })

  it('未满足时段的原因文案也带上课时间（管理员可直接对照）', () => {
    const out = scheduleOneWeek(mkInput({ rules: baseRules({ workdays: [1] }), assistants: [] }))
    expect(out.unmetSlots[0].reason).toContain('8:00~8:45')
  })
})

describe('节次编号对齐与占用判定（2026-09-13 缺陷修复）', () => {
  /**
   * 缺陷现象（用户实测）：课程表把下午第一节编为"第6节"，排班表却编为"第8节"，
   * 同一节真实课程在两表中编号相差 2。算法按节号比较区间时会漏判占用，
   * 例如课程"第六节-第八节"只与排班"第8节"相交，于是"第9、10节"被当成空闲，
   * 结果**在学生上课时间排班**。
   *
   * 修复：排班表下午节次对齐为课程表编号 6~9；占用判定统一按"节次序号"比较
   * （数字节次与中课/晚课混排，序号轴见 utils/sectionOrder）。
   */
  const pmRules = (over: Partial<SchedulingRules> = {}): SchedulingRules =>
    baseRules({
      workdays: [1],
      workSections: [{ start: 6, end: 9, label: '下午' }],
      minSectionsPerAssistant: 0,
      maxSectionsPerAssistant: 4,
      minPerSlot: 1,
      maxPerSlot: 1,
      ...over,
    })

  /** 单助理 + 一条课程 → 返回其被排到的节次键（即"空闲"的上班时段） */
  const freeSlots = (sectionText: string): string[] =>
    scheduleOneWeek(
      mkInput({
        rules: pmRules(),
        assistants: [A(1)],
        courses: [{ assistantId: 1, dayOfWeek: 1, sectionText, weekRanges: [[1, 17]] }],
      }),
    ).assignments.map((x) => x.slotKey)

  it('回归：课程"第六节-第七节"（下午前两节）→ 只在排班表第8、9节可排', () => {
    expect(freeSlots('第六节-第七节')).toEqual(['c8', 'c9'])
  })

  it('回归：课程"第六节-第八节"→ 第6、7、8节被占用，仅第9节可排', () => {
    expect(freeSlots('第六节-第八节')).toEqual(['c9'])
  })

  it('回归：课程"第九节-第十节"→ 第9节被占用（第10节在上班时段之外）', () => {
    expect(freeSlots('第九节-第十节')).toEqual(['c6', 'c7', 'c8'])
  })

  it('中课按序号精确定位：中课1-中课2 位于午间，不影响上午上班时段', () => {
    const out = scheduleOneWeek(
      mkInput({
        rules: baseRules({
          workdays: [1],
          workSections: [{ start: 1, end: 2, label: '上午' }],
          minSectionsPerAssistant: 0,
          maxPerSlot: 1,
          minPerSlot: 1,
        }),
        assistants: [A(1)],
        courses: [{ assistantId: 1, dayOfWeek: 1, sectionText: '中课1-中课2', weekRanges: [[1, 17]] }],
      }),
    )
    expect(out.assignments.map((x) => x.slotKey)).toEqual(['c1', 'c2'])
  })

  it('跨命名节次的课程：中课1-第七节 → 占用排班表第6、7节', () => {
    expect(freeSlots('中课1-第七节')).toEqual(['c8', 'c9'])
  })

  it('晚课在下午之后，不占用下午上班时段', () => {
    expect(freeSlots('晚课')).toEqual(['c6', 'c7', 'c8', 'c9'])
  })

  it('默认上班节次与课程表编号一致（上午 1~4、下午 6~9）', () => {
    expect(DEFAULT_RULES.workSections).toEqual([
      { start: 1, end: 4, label: '上午' },
      { start: 6, end: 9, label: '下午' },
    ])
  })

  it('存量配置迁移：旧默认"下午 8~11"自动对齐为"下午 6~9"，自定义节次不受影响', () => {
    const legacy = normalizeRules({
      workSections: [
        { start: 1, end: 4, label: '上午' },
        { start: 8, end: 11, label: '下午' },
      ],
    })
    expect(legacy.workSections).toEqual([
      { start: 1, end: 4, label: '上午' },
      { start: 6, end: 9, label: '下午' },
    ])
    const custom = normalizeRules({ workSections: [{ start: 3, end: 5, label: '加时' }] })
    expect(custom.workSections).toEqual([{ start: 3, end: 5, label: '加时' }])
  })
})

describe('规则一致性校验（2026-09-13 增补）', () => {
  const messages = (rules: SchedulingRules) => validateRules(rules).map((i) => i.message)

  it('合法规则无告警', () => {
    expect(validateRules(baseRules())).toEqual([])
  })

  it('覆盖已知非法组合（此前均静默产出空结果）', () => {
    expect(messages(baseRules({ weekStart: 5, weekEnd: 2 }))).toEqual([
      '排班周期不合法（起 ≤ 止，且从第 1 周起）',
    ])
    expect(messages(baseRules({ minPerSlot: 5, maxPerSlot: 1 }))).toEqual([
      '同时段最少人数不能大于最多人数',
    ])
    expect(messages(baseRules({ minSectionsPerAssistant: 20, maxSectionsPerAssistant: 4 }))).toEqual([
      '每人最少工时不能大于最多工时',
    ])
    expect(messages(baseRules({ workdays: [] }))).toEqual(['至少选择一个工作日'])
    expect(messages(baseRules({ workSections: [] }))).toEqual(['至少设置一个上班节次区间'])
  })

  it('上班节次区间重叠被拦截（相邻/包含/交叉）', () => {
    const cases: Array<[number, number, number, number]> = [
      [1, 4, 4, 8], // 相邻相交
      [1, 4, 2, 3], // 包含
      [2, 3, 1, 4], // 包含（反序）
      [1, 2, 2, 3], // 交叉
    ]
    for (const [s1, e1, s2, e2] of cases) {
      const issues = validateRules(
        baseRules({ workSections: [{ start: s1, end: e1, label: '甲' }, { start: s2, end: e2, label: '乙' }] }),
      )
      expect(issues.some((i) => i.message.includes('重叠'))).toBe(true)
    }
    // 不重叠（默认值）不告警
    expect(validateRules(baseRules())).toEqual([])
  })

  it('非法规则让算法直接抛出明确错误，而不是静默产出空结果', () => {
    expect(() => scheduleOneWeek(mkInput({ rules: baseRules({ weekStart: 5, weekEnd: 2 }) }))).toThrow(
      /排班规则不合法/,
    )
    expect(() => scheduleAll(mkInput({ rules: baseRules({ weekStart: 5, weekEnd: 2 }) }))).toThrow(/排班规则不合法/)
  })

  it('防御层：重叠区间下 buildSlots 仍保证时段键唯一', () => {
    const slots = buildSlots(
      baseRules({
        workdays: [1],
        workSections: [
          { start: 1, end: 4, label: '上午' },
          { start: 4, end: 8, label: '下午' },
        ],
      }),
    )
    const keys = slots.map((s) => s.key)
    expect(new Set(keys).size).toBe(keys.length)
  })
})

describe('汇总字段 AssistantSummary（2026-09-13 修正 atMax 判据）', () => {
  it('时段已单节化：还差 1 节到上限时 atMax 应为 false（不再受 minPerSlot 影响）', () => {
    const rules = baseRules({
      workdays: [1],
      workSections: [{ start: 1, end: 4, label: '上午' }],
      minSectionsPerAssistant: 0,
      maxSectionsPerAssistant: 4,
      minPerSlot: 2, // 旧判据在此会误判：3 + 2 > 4
      maxPerSlot: 2,
    })
    const out = scheduleOneWeek(mkInput({ rules, assistants: [A(1)] }))
    const s = out.summaries[0]
    expect(s.sections).toBe(4)
    expect(s.atMax).toBe(true)
    // 已排 3 节（上限 4）→ 仍可再排 1 节，不应虚报
    const rules2 = baseRules({
      workdays: [1],
      workSections: [{ start: 1, end: 4, label: '上午' }],
      minSectionsPerAssistant: 3,
      maxSectionsPerAssistant: 4,
      minPerSlot: 2,
      maxPerSlot: 2,
    })
    const out2 = scheduleOneWeek(mkInput({ rules: rules2, assistants: [A(1)] }))
    expect(out2.summaries[0].sections).toBe(4)
    // 低于上限的用例（min=2, max=4, 只排 2 节）
    const rules3 = baseRules({
      workdays: [1],
      workSections: [{ start: 1, end: 2, label: '上午' }],
      minSectionsPerAssistant: 2,
      maxSectionsPerAssistant: 4,
      minPerSlot: 2,
      maxPerSlot: 2,
    })
    const out3 = scheduleOneWeek(mkInput({ rules: rules3, assistants: [A(1)] }))
    expect(out3.summaries[0].sections).toBe(2)
    expect(out3.summaries[0].atMax).toBe(false)
  })
})

describe('个性化值班节数（2026-09-13 增补）', () => {
  it('覆盖上限：某助理最多 1 节，其余时段由他人接管', () => {
    const rules = baseRules({
      workdays: [1],
      workSections: [{ start: 1, end: 2, label: '上午' }],
      minSectionsPerAssistant: 0,
      maxSectionsPerAssistant: 8,
      minPerSlot: 1,
      maxPerSlot: 1,
    })
    const input = mkInput({
      rules,
      assistants: [{ ...A(1), minSections: 0, maxSections: 1 }, A(2)],
    })
    const out = scheduleOneWeek(input)
    const byA = (id: number) => out.assignments.filter((x) => x.assistantId === id).length
    expect(byA(1)).toBe(1) // 个性化上限生效（全局上限是 8）
    expect(byA(2)).toBe(1) // 剩余时段由他人接管
    const s1 = out.summaries.find((s) => s.assistantId === 1)!
    expect(s1.maxSections).toBe(1)
    expect(s1.atMax).toBe(true)
    checkInvariants(input, out)
  })

  it('覆盖下限：全局下限 0 时，某助理仍被要求至少 2 节', () => {
    const rules = baseRules({
      workdays: [1],
      workSections: [{ start: 1, end: 2, label: '上午' }],
      minSectionsPerAssistant: 0,
      maxSectionsPerAssistant: 8,
      minPerSlot: 1,
      maxPerSlot: 2, // 容量放宽为 2，使 a1 有机会补足到其个性化下限
    })
    const input = mkInput({
      rules,
      assistants: [{ ...A(1), minSections: 2 }, A(2)],
    })
    const out = scheduleOneWeek(input)
    const s1 = out.summaries.find((s) => s.assistantId === 1)!
    expect(s1.sections).toBe(2) // 下限覆盖生效
    expect(s1.minSections).toBe(2)
    expect(s1.belowMin).toBe(false)
    const s2 = out.summaries.find((s) => s.assistantId === 2)!
    expect(s2.minSections).toBe(0) // 未设置者跟随全局
    expect(s2.belowMin).toBe(false)
    checkInvariants(input, out)
  })

  it('个性化覆盖不合法（最少 > 最多）→ 抛出明确错误', () => {
    expect(() =>
      scheduleOneWeek(
        mkInput({ assistants: [{ ...A(1), minSections: 5, maxSections: 2 }] }),
      ),
    ).toThrow(/排班规则不合法/)
  })

  it('两名助理分别设置不同上下限，互不影响', () => {
    const rules = baseRules({
      workdays: [1],
      workSections: [{ start: 1, end: 4, label: '上午' }],
      minSectionsPerAssistant: 0,
      maxSectionsPerAssistant: 8,
      minPerSlot: 1,
      maxPerSlot: 1,
    })
    const input = mkInput({
      rules,
      assistants: [{ ...A(1), minSections: 1, maxSections: 1 }, { ...A(2), minSections: 3, maxSections: 3 }],
    })
    const out = scheduleOneWeek(input)
    const secs = (id: number) => out.summaries.find((s) => s.assistantId === id)!.sections
    expect(secs(1)).toBe(1)
    expect(secs(2)).toBe(3)
    checkInvariants(input, out)
  })
  // 缺陷回归（2026-09-18）：每日均衡阶段"新建连续块"的剩余额度误用**全局上限**计算，
  // 使设了较小个性化上限的助理被多排。修复前实测：全局上限 3、个人上限 1、
  // 3 个工作日 × 每日 3 节 → 助理#2 被排 3 节，超出其上限 1 节。
  // 成因：canPlaceBlock 只校验节次/课程占用/同时段人数，不校验个人工时，
  // 故该 remain 是本阶段唯一的工时闸门。
  it('每日均衡补空时段时不得突破个性化上限（缺陷回归）', () => {
    const rules = baseRules({
      workdays: [1, 2, 3],
      workSections: [{ start: 1, end: 3, label: '上午' }],
      minSectionsPerAssistant: 0,
      maxSectionsPerAssistant: 3,
      minPerSlot: 1,
      maxPerSlot: 1,
      minConsecutiveSections: 1,
      balanceDaily: true,
    })
    const input = mkInput({
      rules,
      assistants: [A(1), { ...A(2), maxSections: 1 }],
    })
    const out = scheduleOneWeek(input)
    const s2 = out.summaries.find((s) => s.assistantId === 2)!
    expect(s2.maxSections).toBe(1)
    expect(s2.sections).toBe(1) // 修复前为 3
    checkInvariants(input, out)
  })

  // 反向保护：个性化上限**大于**全局上限时应能真正用满，防止"把上限一律夹到全局值"的过度纠正。
  it('个性化上限大于全局上限时仍能突破全局值（防过度纠正）', () => {
    const rules = baseRules({
      workdays: [1, 2, 3],
      workSections: [{ start: 1, end: 3, label: '上午' }],
      minSectionsPerAssistant: 0,
      maxSectionsPerAssistant: 2,
      minPerSlot: 1,
      maxPerSlot: 1,
      minConsecutiveSections: 1,
      balanceDaily: true,
    })
    const input = mkInput({
      rules,
      assistants: [A(1), { ...A(2), maxSections: 5 }],
    })
    const out = scheduleOneWeek(input)
    const s2 = out.summaries.find((s) => s.assistantId === 2)!
    expect(s2.maxSections).toBe(5)
    expect(s2.sections).toBeGreaterThan(2) // 用满个人额度（实测 5），高于全局上限 2
    expect(s2.sections).toBeLessThanOrEqual(5)
    checkInvariants(input, out)
  })
})

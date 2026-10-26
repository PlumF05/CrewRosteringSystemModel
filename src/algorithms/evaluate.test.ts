/**
 * 独立评价器测试（S1 / FE-03 基座）。
 *
 * 分三组：
 * 1. 判定语义——每种硬违规/软缺口各一个最小场景，含 P01/P02/P05/P08 形态；
 * 2. 锁定语义——在位、被搬走、锁定有课、锁定爆容量、周次越界；
 * 3. 集成——恢复的脱敏夹具跑 scheduleAll，17 周结果必须全部通过独立评价。
 */
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  evaluateSchedule,
  evaluateAllWeeks,
  type ContinuityException,
  type LockEntry,
} from './evaluate'
import { DEFAULT_RULES, type Assignment, type AssistantInput, type CourseInput, type SchedulingRules } from './types'
import { scheduleAll } from './greedy'

const R = (over: Partial<SchedulingRules> = {}): SchedulingRules => ({ ...DEFAULT_RULES, ...over })

const P = (id: number, name = `示例学生${id}`, over: Partial<AssistantInput> = {}): AssistantInput => ({
  id,
  name,
  identity: 'undergrad',
  ...over,
})

/** day 星期 / key 节号键（如 'c3'） */
const A = (assistantId: number, day: number, key: string, source: Assignment['source'] = 'auto'): Assignment => ({
  assistantId,
  dayOfWeek: day,
  slotKey: key,
  source,
})

const C = (assistantId: number, day: number, sectionText: string, weekRanges: [number, number][] = [[1, 17]], kind: CourseInput['kind'] = 'theory'): CourseInput => ({
  assistantId,
  dayOfWeek: day,
  sectionText,
  weekRanges,
  kind,
})

describe('判定语义：硬违规', () => {
  it('课程冲突：序号重叠即违规（第三节-第四节 vs c3）', () => {
    const r = evaluateSchedule({
      rules: R(),
      assistants: [P(1)],
      courses: [C(1, 2, '第三节-第四节')],
      weekNo: 1,
      assignments: [A(1, 2, 'c3')],
    })
    expect(r.legal).toBe(false)
    expect(r.violations.filter((v) => v.type === 'course-conflict')).toHaveLength(1)
  })

  it('课程类别开关：不计实验课时实验课不算冲突', () => {
    const r = evaluateSchedule({
      rules: R({ countExperiment: false }),
      assistants: [P(1)],
      courses: [C(1, 2, '第三节-第四节', [[1, 17]], 'experiment')],
      weekNo: 1,
      assignments: [A(1, 2, 'c3')],
    })
    expect(r.violations.filter((v) => v.type === 'course-conflict')).toHaveLength(0)
  })

  it('uniformMode：任一周有课即占用本周', () => {
    const r = evaluateSchedule({
      rules: R({ uniformMode: true }),
      assistants: [P(1)],
      courses: [C(1, 2, '第一节-第一节', [[9, 9]])], // 仅第 9 周有课
      weekNo: 1,
      assignments: [A(1, 2, 'c1')],
    })
    expect(r.violations.filter((v) => v.type === 'course-conflict')).toHaveLength(1)
  })

  it('非 uniformMode：课程未生效周不算冲突', () => {
    const r = evaluateSchedule({
      rules: R(),
      assistants: [P(1)],
      courses: [C(1, 2, '第一节-第一节', [[9, 9]])],
      weekNo: 1,
      assignments: [A(1, 2, 'c1')],
    })
    expect(r.legal).toBe(true)
  })

  it('重复安排 / 未知助理 / 非法时段', () => {
    const r = evaluateSchedule({
      rules: R(),
      assistants: [P(1)],
      courses: [],
      weekNo: 1,
      assignments: [A(1, 1, 'c1'), A(1, 1, 'c1'), A(99, 1, 'c2'), A(1, 6, 'c1'), A(1, 1, 'c11')],
    })
    const types = r.violations.map((v) => v.type)
    expect(types).toContain('duplicate')
    expect(types).toContain('unknown-assistant')
    expect(types).toContain('invalid-slot') // 星期6 非工作日；c11 不在默认上班节次
    expect(r.legal).toBe(false)
  })

  it('时段超上限 / 个人超上限（含个性化覆盖）', () => {
    const r = evaluateSchedule({
      rules: R({ maxPerSlot: 1, maxSectionsPerAssistant: 2, workSections: [{ start: 1, end: 4, label: '上午' }] }),
      assistants: [P(1, '甲', { maxSections: 1 }), P(2, '乙', { maxSections: 1 })],
      courses: [],
      weekNo: 1,
      assignments: [A(1, 1, 'c1'), A(2, 1, 'c1'), A(2, 1, 'c2')], // c1 两人超上限；乙 2 节超个人覆盖上限 1
    })
    expect(r.violations.filter((v) => v.type === 'slot-over-capacity')).toHaveLength(1)
    expect(r.violations.filter((v) => v.type === 'personal-over-max')).toHaveLength(1)
    expect(r.violations.find((v) => v.type === 'personal-over-max')?.assistantId).toBe(2)
  })

  it('连续性：auto 孤立单节违规（P08 形态）；合法连续段通过', () => {
    const rules = R({ minConsecutiveSections: 2, workSections: [{ start: 1, end: 4, label: '上午' }] })
    const ok = evaluateSchedule({
      rules,
      assistants: [P(1)],
      courses: [],
      weekNo: 1,
      assignments: [A(1, 1, 'c1'), A(1, 1, 'c2')],
    })
    expect(ok.violations.filter((v) => v.type === 'continuity-broken')).toHaveLength(0)

    const bad = evaluateSchedule({
      rules,
      assistants: [P(1), P(2)],
      courses: [],
      weekNo: 1,
      assignments: [A(1, 1, 'c1'), A(1, 1, 'c2'), A(1, 1, 'c3'), A(2, 1, 'c4')], // 乙孤立第4节
    })
    const broken = bad.violations.filter((v) => v.type === 'continuity-broken')
    expect(broken).toHaveLength(1)
    expect(broken[0].assistantId).toBe(2)
  })

  it('连续性：不跨午休——c4 与 c6 相邻安排不算连续', () => {
    const r = evaluateSchedule({
      rules: R({ minConsecutiveSections: 2 }), // 默认 上午1~4 下午6~9
      assistants: [P(1)],
      courses: [],
      weekNo: 1,
      assignments: [A(1, 1, 'c4'), A(1, 1, 'c6')],
    })
    // 两段各自孤立 → 2 个违规
    expect(r.violations.filter((v) => v.type === 'continuity-broken')).toHaveLength(2)
  })

  it('手动短段：带例外与原因允许，无例外违规', () => {
    const rules = R({ minConsecutiveSections: 2, workSections: [{ start: 1, end: 4, label: '上午' }] })
    const exceptions: ContinuityException[] = [
      { assistantId: 1, dayOfWeek: 1, slotKey: 'c2', reason: '老师指定补位' },
    ]
    const withEx = evaluateSchedule({
      rules,
      assistants: [P(1)],
      courses: [],
      weekNo: 1,
      assignments: [A(1, 1, 'c2', 'manual')],
      continuityExceptions: exceptions,
    })
    expect(withEx.violations.filter((v) => v.type === 'continuity-broken')).toHaveLength(0)

    const noEx = evaluateSchedule({
      rules,
      assistants: [P(1)],
      courses: [],
      weekNo: 1,
      assignments: [A(1, 1, 'c2', 'manual')],
    })
    expect(noEx.violations.filter((v) => v.type === 'continuity-broken')).toHaveLength(1)
    // auto 短段即使登记例外也不豁免（例外只对手动来源生效）
    const autoEx = evaluateSchedule({
      rules,
      assistants: [P(1)],
      courses: [],
      weekNo: 1,
      assignments: [A(1, 1, 'c2', 'auto')],
      continuityExceptions: exceptions,
    })
    expect(autoEx.violations.filter((v) => v.type === 'continuity-broken')).toHaveLength(1)
  })
})

describe('判定语义：软缺口（不算违法）', () => {
  it('时段缺员与个人低于下限是缺口，legal 仍为 true', () => {
    const r = evaluateSchedule({
      rules: R({ minPerSlot: 1, minSectionsPerAssistant: 2, workSections: [{ start: 1, end: 4, label: '上午' }], minConsecutiveSections: 1 }),
      assistants: [P(1)],
      courses: [],
      weekNo: 1,
      assignments: [A(1, 1, 'c1')], // 其余 19 个时段无人；甲只有 1 节 < 2
    })
    expect(r.legal).toBe(true)
    expect(r.gaps.filter((g) => g.type === 'slot-understaffed').length).toBeGreaterThan(0)
    expect(r.gaps.filter((g) => g.type === 'assistant-below-min')).toHaveLength(1)
  })

  it('未知节次课程：产出待核对缺口，既不判安全也不误判冲突（P05）', () => {
    const r = evaluateSchedule({
      rules: R(),
      assistants: [P(1)],
      courses: [C(1, 2, '神秘节次')],
      weekNo: 1,
      assignments: [A(1, 2, 'c1')],
    })
    expect(r.violations.filter((v) => v.type === 'course-conflict')).toHaveLength(0)
    const review = r.gaps.filter((g) => g.type === 'needs-review')
    expect(review).toHaveLength(1)
    expect(review[0].evidence).toBe('神秘节次')
  })

  it('指标：覆盖矩阵/值班日/每人节数正确', () => {
    const r = evaluateSchedule({
      rules: R({ workSections: [{ start: 1, end: 4, label: '上午' }], minConsecutiveSections: 1 }),
      assistants: [P(1), P(2)],
      courses: [],
      weekNo: 1,
      assignments: [A(1, 1, 'c1'), A(1, 1, 'c2'), A(2, 3, 'c1'), A(2, 3, 'c2')],
    })
    expect(r.metrics.totalAssignments).toBe(4)
    expect(r.metrics.coverage).toHaveLength(20) // 5 天 × 4 节
    expect(r.metrics.coveredDays).toEqual([1, 3])
    expect(r.metrics.emptyDays).toEqual([2, 4, 5])
    expect(r.metrics.sectionsByAssistant.get(1)).toBe(2)
    expect(r.metrics.sectionsByAssistant.get(2)).toBe(2)
  })
})

describe('锁定语义（P01/P02/P04 校验面）', () => {
  const rules = R({ maxPerSlot: 1, workSections: [{ start: 1, end: 4, label: '上午' }] })

  it('合法锁定在位 → 通过', () => {
    const locks: LockEntry[] = [{ weekNo: 1, dayOfWeek: 1, slotKey: 'c1', assistantId: 1 }]
    const r = evaluateSchedule({
      rules,
      assistants: [P(1)],
      courses: [],
      weekNo: 1,
      assignments: [A(1, 1, 'c1', 'manual')],
      locks,
    })
    expect(r.legal).toBe(true)
  })

  it('锁定被搬走 → lock-broken（P03/P04 的判定基础）', () => {
    const locks: LockEntry[] = [{ weekNo: 1, dayOfWeek: 1, slotKey: 'c1', assistantId: 1 }]
    const r = evaluateSchedule({
      rules,
      assistants: [P(1)],
      courses: [],
      weekNo: 1,
      assignments: [A(1, 1, 'c2', 'manual')], // 被移到 c2
      locks,
    })
    expect(r.violations.filter((v) => v.type === 'lock-broken')).toHaveLength(1)
  })

  it('锁定本身有课 → course-conflict，不因“锁定”豁免（P01）', () => {
    const locks: LockEntry[] = [{ weekNo: 1, dayOfWeek: 2, slotKey: 'c1', assistantId: 1 }]
    const r = evaluateSchedule({
      rules,
      assistants: [P(1)],
      courses: [C(1, 2, '第一节-第一节')],
      weekNo: 1,
      assignments: [A(1, 2, 'c1', 'manual')],
      locks,
    })
    expect(r.violations.filter((v) => v.type === 'course-conflict')).toHaveLength(1)
  })

  it('两个锁定挤爆时段容量 → slot-over-capacity（P02）', () => {
    const locks: LockEntry[] = [
      { weekNo: 1, dayOfWeek: 1, slotKey: 'c1', assistantId: 1 },
      { weekNo: 1, dayOfWeek: 1, slotKey: 'c1', assistantId: 2 },
    ]
    const r = evaluateSchedule({
      rules,
      assistants: [P(1), P(2)],
      courses: [],
      weekNo: 1,
      assignments: [A(1, 1, 'c1', 'manual'), A(2, 1, 'c1', 'manual')],
      locks,
    })
    expect(r.violations.filter((v) => v.type === 'slot-over-capacity')).toHaveLength(1)
  })

  it('锁定周次不属于本周 → 不参与本周在位校验；周期外 → lock-outside-week', () => {
    const r = evaluateSchedule({
      rules,
      assistants: [P(1)],
      courses: [],
      weekNo: 1,
      assignments: [],
      locks: [
        { weekNo: 2, dayOfWeek: 1, slotKey: 'c1', assistantId: 1 }, // 他周的锁，本周不算被破坏
        { weekNo: 99, dayOfWeek: 1, slotKey: 'c2', assistantId: 1 }, // 周期外
      ],
    })
    expect(r.violations.filter((v) => v.type === 'lock-broken')).toHaveLength(0)
    expect(r.violations.filter((v) => v.type === 'lock-outside-week')).toHaveLength(1)
  })
})

describe('集成：求解器输出必须通过独立评价', () => {
  const fixture = JSON.parse(
    readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '__fixtures__/regression-3assistants.json'), 'utf-8'),
  )

  it('脱敏夹具 17 周输出全部合法（无课程冲突/超限/连续段破坏）', () => {
    const out = scheduleAll({
      rules: fixture.rules,
      assistants: fixture.assistants,
      courses: fixture.courses,
    })
    const { legal, reports } = evaluateAllWeeks(
      out.map((w) => ({
        rules: fixture.rules,
        assistants: fixture.assistants,
        courses: fixture.courses,
        weekNo: w.weekNo,
        assignments: w.assignments,
      })),
    )
    expect(legal).toBe(true)
    // 每周缺口如实存在（18 人节 vs 40 时段），但不允许掩盖为违规
    for (const r of reports) {
      expect(r.gaps.filter((g) => g.type === 'slot-understaffed').length).toBeGreaterThan(0)
    }
  })

  it('P08 审计场景：修复轮不再残留 auto 孤立单节（缺口如实报告）', () => {
    // 审计 P08：一天 4 节、两人目标/上限 3、时段上限 1、最少连续 2——
    // 旧版终态为 甲 1~3 节 + 乙孤立第 4 节（violates min-consecutive）。
    const rules = R({
      weekEnd: 1,
      workdays: [1],
      workSections: [{ start: 1, end: 4, label: '上午' }],
      minSectionsPerAssistant: 3,
      maxSectionsPerAssistant: 3,
      minPerSlot: 1,
      maxPerSlot: 1,
      minConsecutiveSections: 2,
    })
    const assistants = [P(1, '甲'), P(2, '乙')]
    const out = scheduleAll({ rules, assistants, courses: [] })
    const r = evaluateSchedule({
      rules,
      assistants,
      courses: [],
      weekNo: 1,
      assignments: out[0].assignments,
    })
    // 硬性要求：不允许靠孤立单节"达标"
    expect(r.legal).toBe(true)
    expect(r.violations.filter((v) => v.type === 'continuity-broken')).toHaveLength(0)
    // 4 时段 × 上限 1 = 4 人节 < 2 人 × 3 节目标 ⇒ 必有缺口被如实报告
    expect(r.gaps.filter((g) => g.type === 'slot-understaffed').length + r.gaps.filter((g) => g.type === 'assistant-below-min').length).toBeGreaterThan(0)
  })
})

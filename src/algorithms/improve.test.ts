/**
 * 有界局部改良测试（S4 第二片 / FE-14，2026-10-26）。
 *
 * FE-14：有界改良不劣于合法基线、保留最佳解；小实例/固定 seed 验证，不虚称最优。
 */
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { improveWeek } from './improve'
import { scheduleAll } from './greedy'
import { evaluateSchedule } from './evaluate'
import { DEFAULT_RULES, type SchedulingRules } from './types'

const rules = (over: Partial<SchedulingRules> = {}): SchedulingRules => ({
  ...DEFAULT_RULES,
  weekStart: 1,
  weekEnd: 2,
  workdays: [1, 2, 3, 4, 5],
  workSections: [{ start: 1, end: 2, label: '上午' }],
  minSectionsPerAssistant: 1,
  maxSectionsPerAssistant: 8,
  minPerSlot: 1,
  maxPerSlot: 1,
  minConsecutiveSections: 1,
  balanceDaily: true,
  ...over,
})

describe('有界局部改良（FE-14）', () => {
  it('不劣于基线：分数字典序 ≤ 基线，且终态合法', () => {
    const r = rules()
    const input = {
      rules: r,
      assistants: [1, 2, 3].map((i) => ({ id: i, name: `助理${i}`, identity: 'undergrad' as const })),
      courses: [],
    }
    const weeks = scheduleAll(input)
    for (const w of weeks) {
      const res = improveWeek(input, w)
      const s = res.finalScore
      const b = res.baselineScore
      expect(
        s.emptyDays <= b.emptyDays &&
          (s.emptyDays < b.emptyDays ||
            (s.unmetSlots <= b.unmetSlots &&
              (s.unmetSlots < b.unmetSlots ||
                (s.belowMinSum <= b.belowMinSum &&
                  (s.belowMinSum < b.belowMinSum || s.fairnessVariance <= b.fairnessVariance))))),
      ).toBe(true)
      const rep = evaluateSchedule({ ...input, weekNo: w.weekNo, assignments: res.week.assignments })
      expect(rep.legal).toBe(true)
    }
  })

  it('可改良场景（手工次优合法基线）：补位同时消缺口与个人不足', () => {
    // 10 个时段（5 天 × 2 节）、下限 1、上限 8：手工基线只排了 甲@周一c1 ——
    // 9 个缺口 + 甲差 0（下限 1 已达）；再排 乙@周一c2 后仍 8 缺口。
    // 改良应持续补位（乙/甲 都可加），缺口单调下降且终态合法。
    const r = rules({ minSectionsPerAssistant: 1, maxSectionsPerAssistant: 8, maxPerSlot: 1 })
    const input = {
      rules: r,
      assistants: [
        { id: 1, name: '甲', identity: 'undergrad' as const },
        { id: 2, name: '乙', identity: 'undergrad' as const },
      ],
      courses: [],
    }
    const baseline = {
      weekNo: 1,
      assignments: [{ dayOfWeek: 1, slotKey: 'c1', assistantId: 1, source: 'auto' as const }],
      unmetSlots: [],
      summaries: [],
      rejectedKeeps: [],
      elapsedMs: 0,
    }
    const res = improveWeek(input, baseline)
    expect(res.improved).toBe(true)
    expect(res.applied).toBeGreaterThan(0)
    expect(res.finalScore.unmetSlots).toBeLessThan(res.baselineScore.unmetSlots)
    expect(res.week.assignments.length).toBeGreaterThan(1)
    const rep = evaluateSchedule({ ...input, weekNo: 1, assignments: res.week.assignments })
    expect(rep.legal).toBe(true)
  })

  it('让位搬移：唯一空闲者受限时，从高负载者转移一格给低于下限者', () => {
    // 乙只在周二 c2 空闲且低于下限 2；甲高于下限且在周二 c2 —— 让位后乙达标
    const r = rules({ minSectionsPerAssistant: 2, maxPerSlot: 1, workdays: [1, 2] })
    const input = {
      rules: r,
      assistants: [
        { id: 1, name: '甲', identity: 'undergrad' as const, maxSections: 4 },
        { id: 2, name: '乙', identity: 'undergrad' as const, maxSections: 2 },
      ],
      courses: [
        { assistantId: 2, dayOfWeek: 1, sectionText: '第一节-第二节', weekRanges: [[1, 2]] as [number, number][] },
        { assistantId: 2, dayOfWeek: 2, sectionText: '第一节-第一节', weekRanges: [[1, 2]] as [number, number][] },
      ],
    }
    // 手工基线：甲占满全部 4 格（合法：甲上限 4），乙 0 节（低于下限 2，但乙只有周二c2可排）
    const baseline = {
      weekNo: 1,
      assignments: [
        { dayOfWeek: 1, slotKey: 'c1', assistantId: 1, source: 'auto' as const },
        { dayOfWeek: 1, slotKey: 'c2', assistantId: 1, source: 'auto' as const },
        { dayOfWeek: 2, slotKey: 'c1', assistantId: 1, source: 'auto' as const },
        { dayOfWeek: 2, slotKey: 'c2', assistantId: 1, source: 'auto' as const },
      ],
      unmetSlots: [],
      summaries: [],
      rejectedKeeps: [],
      elapsedMs: 0,
    }
    const res = improveWeek(input, baseline)
    expect(res.improved).toBe(true)
    expect(res.week.assignments.some((a) => a.assistantId === 2 && a.dayOfWeek === 2 && a.slotKey === 'c2')).toBe(true)
    expect(res.week.summaries.find((s) => s.assistantId === 2)?.sections).toBe(1) // 可达上限即改善（差 1 → 0 差? 下限2不可达，如实报告）
    const rep = evaluateSchedule({ ...input, weekNo: 1, assignments: res.week.assignments })
    expect(rep.legal).toBe(true)
  })

  it('预算为零：不改动、improved=false、如实记录', () => {
    const r = rules()
    const input = {
      rules: r,
      assistants: [{ id: 1, name: '甲', identity: 'undergrad' as const }],
      courses: [],
    }
    const w = scheduleAll(input)[0]
    const res = improveWeek(input, w, { maxOperations: 0 })
    expect(res.improved).toBe(false)
    expect(res.attempts).toBe(0)
    expect(res.week.assignments).toEqual(w.assignments)
  })

  it('确定性：同输入同 seed 同预算，两次结果完全一致', () => {
    const r = rules()
    const input = {
      rules: r,
      assistants: [1, 2, 3, 4].map((i) => ({ id: i, name: `助理${i}`, identity: 'undergrad' as const })),
      courses: [
        { assistantId: 2, dayOfWeek: 3, sectionText: '第一节-第一节', weekRanges: [[1, 2]] as [number, number][] },
      ],
    }
    const w = scheduleAll(input)[0]
    const a = improveWeek(input, w, { seed: 7 })
    const b = improveWeek(input, w, { seed: 7 })
    expect(a.week.assignments).toEqual(b.week.assignments)
    expect(a.attempts).toBe(b.attempts)
    expect(a.applied).toBe(b.applied)
    expect(a.stopReason).toBe(b.stopReason)
  })

  it('脱敏夹具：全周期改良保持合法且不劣于基线（含连续段）', () => {
    const fixture = JSON.parse(
      readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '__fixtures__/regression-3assistants.json'), 'utf-8'),
    )
    const input = {
      rules: { ...fixture.rules, balanceDaily: true },
      assistants: fixture.assistants,
      courses: fixture.courses,
    }
    const weeks = scheduleAll(input)
    for (const w of weeks) {
      const res = improveWeek(input, w)
      const rep = evaluateSchedule({ ...input, weekNo: w.weekNo, assignments: res.week.assignments })
      expect(rep.legal).toBe(true)
      expect(res.finalScore.unmetSlots).toBeLessThanOrEqual(res.baselineScore.unmetSlots)
      expect(res.finalScore.belowMinSum).toBeLessThanOrEqual(res.baselineScore.belowMinSum)
    }
  })
})

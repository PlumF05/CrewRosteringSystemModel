/**
 * 增量重排测试（S4 第一片 / F08 / FE-13，2026-10-26）。
 *
 * 覆盖：零改动快路径、输入变化时的最小扰动（非法基准行被拒并给原因、其余原位保留）、
 * 目标范围外周保持基准、锁定与来源语义、uniform 模式拒绝、差异结构与原因。
 */
import { describe, expect, it } from 'vitest'
import { incrementalSchedule, type BaselineRow } from './incremental'
import { scheduleAll } from './greedy'
import { DEFAULT_RULES, type CourseInput, type SchedulingRules } from './types'

const A = (id: number, name = `助理${id}`) => ({ id, name, identity: 'undergrad' as const })

const rules = (over: Partial<SchedulingRules> = {}): SchedulingRules => ({
  ...DEFAULT_RULES,
  weekStart: 1,
  weekEnd: 3,
  workdays: [1, 2, 3, 4, 5],
  workSections: [{ start: 1, end: 2, label: '上午' }],
  minSectionsPerAssistant: 1,
  maxSectionsPerAssistant: 8,
  minPerSlot: 1,
  maxPerSlot: 1,
  minConsecutiveSections: 1,
  balanceDaily: false,
  ...over,
})

const course = (
  assistantId: number,
  day: number,
  s: number,
  e: number,
  weeks: [number, number][] = [[1, 3]],
): CourseInput => ({
  assistantId,
  dayOfWeek: day,
  sectionText: s === e ? `第${s}节` : `第${s}节-第${e}节`,
  weekRanges: weeks,
})

/** 用全量生成构造一份"已写入基准" */
function makeBaseline(input: Parameters<typeof scheduleAll>[0], patch: (r: BaselineRow) => BaselineRow = (r) => r): BaselineRow[] {
  return scheduleAll(input).flatMap((w) =>
    w.assignments.map((a) =>
      patch({
        weekNo: w.weekNo,
        dayOfWeek: a.dayOfWeek,
        slotKey: a.slotKey,
        assistantId: a.assistantId,
        source: a.source,
      }),
    ),
  )
}

describe('增量重排（FE-13）', () => {
  it('零改动：输入未变且基准合法 → 原样返回，diff 为空', () => {
    const input = { rules: rules(), assistants: [A(1), A(2)], courses: [] }
    const baseline = makeBaseline(input)
    const r = incrementalSchedule(input, baseline, { inputsUnchanged: true })
    expect(r.zeroChange).toBe(true)
    expect(r.diff).toHaveLength(0)
    expect(r.weeks.flatMap((w) => w.assignments)).toHaveLength(baseline.length)
    // 与基准逐行一致
    for (const w of r.weeks) {
      const before = baseline.filter((b) => b.weekNo === w.weekNo)
      expect(w.assignments.map((a) => `${a.dayOfWeek}|${a.slotKey}|${a.assistantId}`).sort()).toEqual(
        before.map((b) => `${b.dayOfWeek}|${b.slotKey}|${b.assistantId}`).sort(),
      )
    }
  })

  it('输入变化：新课程只影响冲突行（被替换+原因），其余基准行原位保留', () => {
    const base = { rules: rules(), assistants: [A(1), A(2), A(3)], courses: [] }
    const baseline = makeBaseline(base)
    // 助理 1 在第 1 周周一的安排位置
    const w1monday1 = baseline.find((b) => b.weekNo === 1 && b.dayOfWeek === 1 && b.assistantId === 1)
    expect(w1monday1).toBeTruthy()
    const slotNo = Number(w1monday1!.slotKey.slice(1))
    // 输入变化：助理 1 第 1~3 周周一此时段新增课程
    const changed = {
      ...base,
      courses: [course(1, 1, slotNo, slotNo)],
    }
    const r = incrementalSchedule(changed, baseline, { inputsUnchanged: false })
    expect(r.zeroChange).toBe(false)
    // 该位置不再是助理 1
    const solvedW1 = r.weeks.find((w) => w.weekNo === 1)!
    expect(
      solvedW1.assignments.some(
        (a) => a.dayOfWeek === 1 && a.slotKey === w1monday1!.slotKey && a.assistantId === 1,
      ),
    ).toBe(false)
    // 差异包含该行的 removed/replaced 且原因指向课程冲突（拒绝明细）
    const entry = r.diff.find(
      (d) => d.weekNo === 1 && d.dayOfWeek === 1 && d.slotKey === w1monday1!.slotKey && d.type !== 'added',
    )
    expect(entry).toBeTruthy()
    expect(entry!.reason).toContain('有课')
    // 其余基准行绝大部分保留（扰动远小于全量重排的不确定度——这里验证非冲突行保持）
    const keptCount = r.diff.filter((d) => d.type === 'kept').length
    expect(keptCount).toBeGreaterThan(baseline.length - 6)
  })

  it('目标范围外周保持基准原样（不重新求解）', () => {
    const base = { rules: rules(), assistants: [A(1), A(2)], courses: [] }
    const baseline = makeBaseline(base)
    // 第 1 周内人为"破坏"一个安排的输入（不影响第 2、3 周判定用 courses 的周次）
    const changed = { ...base, courses: [course(1, 1, 1, 2, [[1, 1]])] } // 仅第 1 周周一全时段有课
    const r = incrementalSchedule(changed, baseline, {
      inputsUnchanged: false,
      targetWeeks: [1, 1],
    })
    // 第 2、3 周输出 = 基准（逐行一致）
    for (const w of [2, 3]) {
      const before = baseline.filter((b) => b.weekNo === w)
      const out = r.weeks.find((x) => x.weekNo === w)!
      expect(out.assignments.map((a) => `${a.dayOfWeek}|${a.slotKey}|${a.assistantId}`).sort()).toEqual(
        before.map((b) => `${b.dayOfWeek}|${b.slotKey}|${b.assistantId}`).sort(),
      )
    }
    // 差异只描述目标周
    expect(r.diff.every((d) => d.weekNo === 1)).toBe(true)
  })

  it('锁定不动：合法锁定原位保留且来源为 manual；非法锁定给明细不入方案', () => {
    const base = { rules: rules(), assistants: [A(1), A(2)], courses: [] }
    const baseline = makeBaseline(base).map((r) =>
      r.weekNo === 2 && r.dayOfWeek === 2 ? { ...r, locked: true, source: 'manual' as const } : r,
    )
    const r = incrementalSchedule(base, baseline, { inputsUnchanged: false, targetWeeks: [2, 2] })
    const lockedRows = baseline.filter((b) => b.weekNo === 2 && b.locked)
    for (const l of lockedRows) {
      const out = r.weeks.find((w) => w.weekNo === 2)!
      const found = out.assignments.find(
        (a) => a.dayOfWeek === l.dayOfWeek && a.slotKey === l.slotKey && a.assistantId === l.assistantId,
      )
      expect(found).toBeTruthy()
      expect(found!.source).toBe('manual') // 锁定保持手动来源
    }
    // 非法锁定：给锁定的人加课 → 拒绝明细 + 不出现在结果
    const changed = { ...base, courses: [course(1, 2, 1, 2, [[2, 2]])] }
    const r2 = incrementalSchedule(changed, baseline, { inputsUnchanged: false, targetWeeks: [2, 2] })
    expect(r2.rejectedKeeps.some((k) => k.reason.includes('有课'))).toBe(true)
    const w2 = r2.weeks.find((w) => w.weekNo === 2)!
    expect(
      w2.assignments.some((a) => a.dayOfWeek === 2 && a.assistantId === 1),
    ).toBe(false)
  })

  it('自动行优先保留：来源仍记 auto（不冒充手动）', () => {
    const base = { rules: rules(), assistants: [A(1), A(2)], courses: [] }
    const baseline = makeBaseline(base)
    const r = incrementalSchedule(base, baseline, { inputsUnchanged: false })
    const out = r.weeks.flatMap((w) => w.assignments)
    // 无输入变化但走重算路径（inputsUnchanged=false 模拟版本变化）——合法基准行应原位保留且来源不变
    const kept = r.diff.filter((d) => d.type === 'kept').length
    expect(kept).toBe(baseline.length)
    expect(out.every((a) => a.source === 'auto')).toBe(true)
  })

  it('uniform 模式明确拒绝增量', () => {
    const base = { rules: rules({ uniformMode: true }), assistants: [A(1)], courses: [] }
    expect(() => incrementalSchedule(base, [], { inputsUnchanged: false })).toThrow('各周独立')
  })

  it('目标范围非法被拒', () => {
    const base = { rules: rules(), assistants: [A(1)], courses: [] }
    expect(() =>
      incrementalSchedule(base, [], { inputsUnchanged: false, targetWeeks: [2, 1] }),
    ).toThrow('范围不合法')
  })
})

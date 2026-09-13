import { beforeEach, describe, expect, it } from 'vitest'
import 'fake-indexeddb/auto'
import { DEFAULT_RULES, type SchedulingRules } from '../algorithms/types'
import { findDutyConflicts } from './dutyConflict'
import { db } from '../db/database'
import { dutyScheduleRepo } from '../db/repositories'

/**
 * 导入课程表后的冲突检测测试（SRS F06 第 3 条，2026-09-13 增补）。
 */

const rules: SchedulingRules = { ...DEFAULT_RULES }

const course = (over: Partial<Parameters<typeof findDutyConflicts>[0]['courses'][number]> = {}) => ({
  assistantId: 1,
  kind: 'theory' as const,
  dayOfWeek: 1,
  courseName: '软件工程',
  sectionText: '第一节-第二节',
  weekRanges: [[1, 17]] as [number, number][],
  ...over,
})

const duty = (over: Partial<Parameters<typeof findDutyConflicts>[0]['duties'][number]> = {}) => ({
  id: undefined as number | undefined,
  weekNo: 1,
  dayOfWeek: 1,
  timeSlot: 'c1',
  assistantId: 1,
  ...over,
})

beforeEach(async () => {
  await db.close()
  await db.delete()
  await db.open()
})

describe('findDutyConflicts（导入课程表后的冲突检测）', () => {
  it('排班落在有课节次 → 检出并给出课程信息', () => {
    const out = findDutyConflicts({ rules, assistantId: 1, courses: [course()], duties: [duty()] })
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ weekNo: 1, dayOfWeek: 1, timeSlot: 'c1', courseName: '软件工程' })
  })

  it('节次不重叠 → 不算冲突', () => {
    const out = findDutyConflicts({
      rules,
      assistantId: 1,
      courses: [course({ sectionText: '第一节-第二节' })],
      duties: [duty({ timeSlot: 'c6' })],
    })
    expect(out).toHaveLength(0)
  })

  it('周次不覆盖 → 不算冲突', () => {
    const out = findDutyConflicts({
      rules,
      assistantId: 1,
      courses: [course({ weekRanges: [[10, 17]] })],
      duties: [duty({ weekNo: 1 })],
    })
    expect(out).toHaveLength(0)
  })

  it('实验课被规则过滤 → 不算冲突', () => {
    const out = findDutyConflicts({
      rules: { ...rules, countExperiment: false },
      assistantId: 1,
      courses: [course({ kind: 'experiment', sectionText: '中课1-中课2' })],
      duties: [duty({ timeSlot: 'c6' })],
    })
    expect(out).toHaveLength(0)
  })

  it('命名节次按序号参与判定：课程"中课1-第七节"覆盖下午第6、7节', () => {
    const out = findDutyConflicts({
      rules,
      assistantId: 1,
      courses: [course({ sectionText: '中课1-第七节' })],
      duties: [duty({ timeSlot: 'c6' }), duty({ id: 2, timeSlot: 'c7' }), duty({ id: 3, timeSlot: 'c8' })],
    })
    // 第6、7节冲突，第8节（序号 10）在区间 {6,9} 之外
    expect(out.map((c) => c.timeSlot)).toEqual(['c6', 'c7'])
    expect(out[0].id).toBeUndefined()
  })

  it('多周排班逐周判定，结果按 周/节次 排序', () => {
    const out = findDutyConflicts({
      rules,
      assistantId: 1,
      courses: [course()],
      duties: [
        duty({ id: 5, weekNo: 3, dayOfWeek: 1, timeSlot: 'c2' }),
        duty({ id: 4, weekNo: 2, dayOfWeek: 1, timeSlot: 'c1' }),
      ],
    })
    expect(out.map((c) => c.weekNo)).toEqual([2, 3])
    expect(out[0].id).toBe(4)
  })

  it('与真实仓储联动：按主键删除冲突排班后不再检出', async () => {
    await dutyScheduleRepo.replaceWeek(1, [
      { weekNo: 1, dayOfWeek: 1, timeSlot: 'c1', assistantId: 1 },
      { weekNo: 1, dayOfWeek: 1, timeSlot: 'c2', assistantId: 1 },
    ])
    const rows = await dutyScheduleRepo.listByWeek(1)
    const out = findDutyConflicts({
      rules,
      assistantId: 1,
      courses: [course()],
      duties: rows.map((r) => ({ id: r.id, weekNo: r.weekNo, dayOfWeek: r.dayOfWeek, timeSlot: r.timeSlot, assistantId: r.assistantId })),
    })
    expect(out).toHaveLength(2)
    const ids = out.map((c) => c.id).filter((x): x is number => x !== undefined)
    await dutyScheduleRepo.removeMany(ids)
    expect(await dutyScheduleRepo.listByWeek(1)).toHaveLength(0)
  })
})

describe('dutyScheduleRepo.removeMany', () => {
  it('空数组不抛错、不改动数据', async () => {
    await dutyScheduleRepo.add({ weekNo: 1, dayOfWeek: 1, timeSlot: 'c1', assistantId: 1 })
    await dutyScheduleRepo.removeMany([])
    expect((await dutyScheduleRepo.all()).length).toBe(1)
  })
})

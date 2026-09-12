import { describe, expect, it } from 'vitest'
import { diffWeekSchedule } from './scheduleDiff'
import type { DiffRow } from './scheduleDiff'

const r = (day: number, sec: number, assistantId: number): DiffRow => ({
  dayOfWeek: day,
  timeSlot: `c${sec}`,
  assistantId,
})

describe('diffWeekSchedule（F08 重排差异对比）', () => {
  it('无变化：新旧一致 → 全部 unchanged', () => {
    const rows = [r(1, 1, 1), r(1, 2, 2), r(2, 1, 1)]
    const d = diffWeekSchedule(rows, rows.map((x) => ({ ...x })))
    expect(d.added).toHaveLength(0)
    expect(d.removed).toHaveLength(0)
    expect(d.unchanged).toHaveLength(3)
  })

  it('新增/移除/保持 三分类', () => {
    const oldRows = [r(1, 1, 1), r(1, 2, 2), r(2, 1, 3)]
    const newRows = [r(1, 1, 1), r(1, 2, 3), r(3, 1, 2)]
    const d = diffWeekSchedule(oldRows, newRows)
    // 保持：1-1-张三
    expect(d.unchanged.map((e) => `${e.dayOfWeek}|${e.timeSlot}|${e.assistantId}`)).toEqual(['1|c1|1'])
    // 移除：1-2-李四、2-1-助理3
    expect(d.removed.map((e) => `${e.dayOfWeek}|${e.timeSlot}|${e.assistantId}`)).toEqual([
      '1|c2|2',
      '2|c1|3',
    ])
    // 新增：1-2-助理3、3-1-李四
    expect(d.added.map((e) => `${e.dayOfWeek}|${e.timeSlot}|${e.assistantId}`)).toEqual([
      '1|c2|3',
      '3|c1|2',
    ])
  })

  it('同一时段换人 = 一次移除 + 一次新增', () => {
    const d = diffWeekSchedule([r(1, 1, 1)], [r(1, 1, 2)])
    expect(d.removed).toHaveLength(1)
    expect(d.added).toHaveLength(1)
    expect(d.unchanged).toHaveLength(0)
  })

  it('从空到有：全部为新增', () => {
    const d = diffWeekSchedule([], [r(1, 1, 1), r(1, 2, 2)])
    expect(d.added).toHaveLength(2)
    expect(d.removed).toHaveLength(0)
  })

  it('从有到空：全部为移除', () => {
    const d = diffWeekSchedule([r(1, 1, 1)], [])
    expect(d.added).toHaveLength(0)
    expect(d.removed).toHaveLength(1)
  })

  it('排序：按 星期→节次→助理', () => {
    const d = diffWeekSchedule([], [r(2, 1, 1), r(1, 2, 2), r(1, 1, 3), r(1, 1, 1)])
    expect(d.added.map((e) => `${e.dayOfWeek}${e.timeSlot}#${e.assistantId}`)).toEqual([
      '1c1#1',
      '1c1#3',
      '1c2#2',
      '2c1#1',
    ])
  })
})

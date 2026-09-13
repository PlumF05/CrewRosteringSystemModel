import { describe, expect, it } from 'vitest'
import { DEFAULT_RULES, type SchedulingRules } from '../algorithms/types'
import { collectGridDays, collectGridKeys } from './scheduleGrid'

/**
 * 排班网格骨架测试（2026-09-13 增补）。
 * 对应缺陷：网格行列此前完全由"当前规则"推导，管理员改完上班节次后直接看旧排班/导出，
 * 已写入的数据会整体"隐身"（所有格子显示 —）。
 */

const rules: SchedulingRules = {
  ...DEFAULT_RULES,
  weekStart: 1,
  weekEnd: 1,
  workdays: [1, 2],
  workSections: [{ start: 1, end: 2, label: '上午' }],
}

describe('collectGridKeys（行 = 节次，规则 ∪ 数据）', () => {
  it('规则内节次带上课时间', () => {
    const keys = collectGridKeys(rules, [])
    expect(keys.map((k) => k.key)).toEqual(['c1', 'c2'])
    expect(keys[0].label).toBe('上午 第1节 8:00~8:45')
    expect(keys[0].fromRules).toBe(true)
  })

  it('数据独有的节次也会显示（无时间标注），不再隐身', () => {
    const keys = collectGridKeys(rules, [{ timeSlot: 'c6' }])
    expect(keys.map((k) => k.key)).toEqual(['c1', 'c2', 'c6'])
    // 数据独有节次的上课时间是全局属性，仍会标注
    expect(keys[2].label).toBe('第6节 14:00~14:45')
    expect(keys[2].fromRules).toBe(false)
  })

  it('键格式异常的行原样保留在末尾，不静默丢数据', () => {
    const keys = collectGridKeys(rules, [{ timeSlot: 'legacy-key' }])
    expect(keys.map((k) => k.key)).toEqual(['c1', 'c2', 'legacy-key'])
    expect(keys[2].label).toBe('legacy-key')
  })

  it('按节次升序输出，重复只保留一份', () => {
    const keys = collectGridKeys(rules, [{ timeSlot: 'c2' }, { timeSlot: 'c1' }])
    expect(keys.map((k) => k.key)).toEqual(['c1', 'c2'])
  })
})

describe('collectGridDays（列 = 工作日，规则 ∪ 数据）', () => {
  it('数据中出现的工作日也会显示，且整体升序', () => {
    expect(collectGridDays(rules, [{ dayOfWeek: 5 }, { dayOfWeek: 1 }])).toEqual([1, 2, 5])
  })

  it('无数据时与规则一致', () => {
    expect(collectGridDays(rules, [])).toEqual([1, 2])
  })
})

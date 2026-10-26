/**
 * 规则校验与归一化测试（S1，2026-10-26）。
 *
 * P06：负数/小数上下限、星期 0/8、小数节次等"能构造出来但排不了班"的规则
 *      必须被 validateRules 逐字段拦下（基线实测曾全部静默通过）。
 * P07：存量"下午 8~11 节"配置不再被 normalizeRules 静默改写为 6~9——
 *      歧义数据原样保留，由 rulesDataWarnings 标记"待核对"。
 */
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_RULES,
  normalizeRules,
  rulesDataWarnings,
  validateRules,
  type SchedulingRules,
} from './types'

const R = (over: Partial<SchedulingRules>): SchedulingRules => ({ ...DEFAULT_RULES, ...over })

describe('P06：严格规则校验', () => {
  it('默认规则通过', () => {
    expect(validateRules(DEFAULT_RULES)).toEqual([])
  })

  it('负数/小数/越界的个人上下限被拦截', () => {
    expect(validateRules(R({ minSectionsPerAssistant: -1 })).map((i) => i.field)).toContain('minSectionsPerAssistant')
    expect(validateRules(R({ maxSectionsPerAssistant: 2.5 })).map((i) => i.field)).toContain('maxSectionsPerAssistant')
    expect(validateRules(R({ maxSectionsPerAssistant: 0 })).map((i) => i.field)).toContain('maxSectionsPerAssistant')
    expect(validateRules(R({ minSectionsPerAssistant: 5, maxSectionsPerAssistant: 3 })).map((i) => i.field)).toContain(
      'maxSectionsPerAssistant',
    )
  })

  it('同时段人数：负数/小数/倒置被拦截', () => {
    expect(validateRules(R({ minPerSlot: -1 })).map((i) => i.field)).toContain('minPerSlot')
    expect(validateRules(R({ maxPerSlot: 1.5 })).map((i) => i.field)).toContain('maxPerSlot')
    expect(validateRules(R({ minPerSlot: 3, maxPerSlot: 2 })).map((i) => i.field)).toContain('maxPerSlot')
  })

  it('星期 0 / 8 / 小数工作日被拦截（基线实测曾通过）', () => {
    expect(validateRules(R({ workdays: [0, 1, 2] })).map((i) => i.field)).toContain('workdays')
    expect(validateRules(R({ workdays: [1, 8] })).map((i) => i.field)).toContain('workdays')
    expect(validateRules(R({ workdays: [1.5] })).map((i) => i.field)).toContain('workdays')
    expect(validateRules(R({ workdays: [6, 7] })).map((i) => i.field)).not.toContain('workdays') // 周末合法
  })

  it('小数节次端点被拦截（基线实测曾通过）', () => {
    expect(validateRules(R({ workSections: [{ start: 1.5, end: 4, label: '上午' }] })).map((i) => i.field)).toContain(
      'workSections',
    )
    expect(validateRules(R({ workSections: [{ start: 1, end: 4.5, label: '上午' }] })).map((i) => i.field)).toContain(
      'workSections',
    )
  })

  it('最少连续节数与排班周期的整数/范围校验', () => {
    expect(validateRules(R({ minConsecutiveSections: 0 })).map((i) => i.field)).toContain('minConsecutiveSections')
    expect(validateRules(R({ minConsecutiveSections: 2.5 })).map((i) => i.field)).toContain('minConsecutiveSections')
    expect(validateRules(R({ weekStart: 1.5 })).map((i) => i.field)).toContain('weekStart')
    expect(validateRules(R({ weekStart: 5, weekEnd: 3 })).map((i) => i.field)).toContain('weekStart')
  })
})

describe('P07：8~11 歧义配置不静默改写', () => {
  const legacy = { workSections: [{ start: 8, end: 11, label: '下午' }] }

  it('normalizeRules 保留 8~11 原值（旧版会改成 6~9）', () => {
    const r = normalizeRules(legacy)
    expect(r.workSections).toEqual([{ start: 8, end: 11, label: '下午' }])
  })

  it('rulesDataWarnings 对 8~11 给出待核对提示', () => {
    const w = rulesDataWarnings(legacy)
    expect(w).toHaveLength(1)
    expect(w[0]).toContain('8~11')
  })

  it('标准 6~9 与空配置不产生警告', () => {
    expect(rulesDataWarnings({ workSections: [{ start: 6, end: 9, label: '下午' }] })).toEqual([])
    expect(rulesDataWarnings(null)).toEqual([])
  })

  it('默认 6~9 之外的正常自定义不被警告', () => {
    expect(rulesDataWarnings({ workSections: [{ start: 1, end: 5, label: '上午' }] })).toEqual([])
  })

  it('normalizeRules 其余兼容行为不变（补默认值/丢弃 slotTemplates）', () => {
    const r = normalizeRules({ weekStart: 2, slotTemplates: [] } as Partial<SchedulingRules>)
    expect(r.weekStart).toBe(2)
    expect(r.weekEnd).toBe(DEFAULT_RULES.weekEnd)
    expect((r as unknown as Record<string, unknown>).slotTemplates).toBeUndefined()
  })
})

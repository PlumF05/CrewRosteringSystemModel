import { describe, expect, it } from 'vitest'
import {
  formatWeekRanges,
  parseWeekList,
  WeekParseError,
  weekInRanges,
} from './weekParser'

describe('parseWeekList（周次解析，R06 高风险环节）', () => {
  it('单周 "10周"', () => {
    expect(parseWeekList('10周')).toEqual([[10, 10]])
  })

  it('连续区间 "1-4周"', () => {
    expect(parseWeekList('1-4周')).toEqual([[1, 4]])
  })

  it('多区间逗号分隔 "1-4周,6-9周"', () => {
    expect(parseWeekList('1-4周,6-9周')).toEqual([
      [1, 4],
      [6, 9],
    ])
  })

  it('全角逗号 "1-4周，6-9周"', () => {
    expect(parseWeekList('1-4周，6-9周')).toEqual([
      [1, 4],
      [6, 9],
    ])
  })

  it('首尾空白', () => {
    expect(parseWeekList('  5-17周  ')).toEqual([[5, 17]])
  })

  it('省略"周"字 "1-4"', () => {
    expect(parseWeekList('1-4')).toEqual([[1, 4]])
  })

  it('非法输入抛 WeekParseError', () => {
    expect(() => parseWeekList('abc周')).toThrowError(WeekParseError)
    expect(() => parseWeekList('周')).toThrowError(WeekParseError)
    expect(() => parseWeekList('')).toThrowError(WeekParseError)
    expect(() => parseWeekList('0周')).toThrowError(WeekParseError)   // 周次从 1 开始
    expect(() => parseWeekList('4-1周')).toThrowError(WeekParseError) // 起止颠倒
    expect(() => parseWeekList('1-99周')).toThrowError(WeekParseError) // 超出学期范围
  })
})

describe('formatWeekRanges', () => {
  it('单周与区间混合', () => {
    expect(formatWeekRanges([[10, 10], [1, 4]])).toBe('10周,1-4周')
  })
})

describe('weekInRanges（阶段 4 排班的周次判断基础）', () => {
  const ranges: [number, number][] = [[1, 4], [6, 9]]
  it('区间内为 true', () => {
    expect(weekInRanges(1, ranges)).toBe(true)
    expect(weekInRanges(4, ranges)).toBe(true)
    expect(weekInRanges(7, ranges)).toBe(true)
  })
  it('区间外为 false', () => {
    expect(weekInRanges(5, ranges)).toBe(false)
    expect(weekInRanges(10, ranges)).toBe(false)
    expect(weekInRanges(17, ranges)).toBe(false)
  })
})

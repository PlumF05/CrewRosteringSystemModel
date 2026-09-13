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
    expect(() => parseWeekList('1-4周单周双周')).toThrowError(WeekParseError)
    expect(() => parseWeekList('单周')).toThrowError(WeekParseError)
  })

  it('单周/双周变体（2026-09-13 增补，SRS 附录 A 要求）', () => {
    expect(parseWeekList('5-17周单周')).toEqual([
      [5, 5], [7, 7], [9, 9], [11, 11], [13, 13], [15, 15], [17, 17],
    ])
    expect(parseWeekList('5-17周双周')).toEqual([[6, 6], [8, 8], [10, 10], [12, 12], [14, 14], [16, 16]])
    expect(parseWeekList('1-17周(单)')).toEqual([
      [1, 1], [3, 3], [5, 5], [7, 7], [9, 9], [11, 11], [13, 13], [15, 15], [17, 17],
    ])
    expect(parseWeekList('1-4周单')).toEqual([[1, 1], [3, 3]])
    // 与既有区间写法混排
    expect(parseWeekList('1-4周,6-9周双')).toEqual([[1, 4], [6, 6], [8, 8]])
    // 说明：刻意不支持"第5-17周"这类带"第"前缀的写法——学院课表的信息行均为"1-4周"风格，
    // 严格匹配可避免把非周次文本误判为周次；解析失败会进入 problems 提示，不会被静默丢弃。
  })
})

describe('formatWeekRanges', () => {
  it('单周与区间混合', () => {
    expect(formatWeekRanges([[10, 10], [1, 4]])).toBe('10周,1-4周')
  })

  it('等差步长 2 的单周序列折叠为"区间(单/双)"，保持周次列简洁', () => {
    expect(formatWeekRanges(parseWeekList('5-17周单周'))).toBe('5-17周(单)')
    expect(formatWeekRanges(parseWeekList('6-16周双周'))).toBe('6-16周(双)')
    // 不足 3 个单周不折叠
    expect(formatWeekRanges(parseWeekList('5-7周单周'))).toBe('5周,7周')
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

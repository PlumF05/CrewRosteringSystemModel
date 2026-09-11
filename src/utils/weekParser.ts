/**
 * 周次文本解析（纯函数）。
 *
 * 学院课程表中的周次写法（实测样例 timeTableForStu12.xlsx）：
 *   "10周"            → [[10,10]]
 *   "1-4周"           → [[1,4]]
 *   "1-4周,6-9周"     → [[1,4],[6,9]]   （多个区间以逗号分隔）
 *   "5-17周"          → [[5,17]]
 *
 * 设计为纯函数（无副作用、不碰 DOM/数据库），因此可以穷举边界做单元测试——
 * 这是阶段 3 风险最高（R06）的解析环节，独立出来重点测试。
 */

export type WeekRange = [number, number]

export class WeekParseError extends Error {
  constructor(text: string) {
    super(`无法解析周次："${text}"`)
    this.name = 'WeekParseError'
  }
}

/** 解析单个区间，如 "10周" / "1-4周" / "3-4"（允许省略"周"） */
function parseOne(item: string): WeekRange {
  const m = item.match(/^(\d+)(?:\s*[-~—]\s*(\d+))?周?$/)
  if (!m) throw new WeekParseError(item)
  const start = Number(m[1])
  const end = m[2] !== undefined ? Number(m[2]) : start
  if (start < 1 || end < start || end > 30) throw new WeekParseError(item)
  return [start, end]
}

/** 解析逗号分隔的周次列表；全角逗号自动归一化 */
export function parseWeekList(text: string): WeekRange[] {
  const normalized = text.replace(/，/g, ',').trim()
  if (!normalized) throw new WeekParseError(text)
  return normalized
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map(parseOne)
}

/** 供界面展示："1-4周,6-9周" 风格 */
export function formatWeekRanges(ranges: WeekRange[]): string {
  return ranges.map(([s, e]) => (s === e ? `${s}周` : `${s}-${e}周`)).join(',')
}

/** 某周是否在区间列表内（阶段 4 排班算法判断"该周是否有课"的基础运算） */
export function weekInRanges(week: number, ranges: WeekRange[]): boolean {
  return ranges.some(([s, e]) => week >= s && week <= e)
}

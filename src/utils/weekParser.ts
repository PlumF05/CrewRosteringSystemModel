/**
 * 周次文本解析（纯函数）。
 *
 * 学院课程表中的周次写法（实测样例 timeTableForStu12.xlsx）：
 *   "10周"            → [[10,10]]
 *   "1-4周"           → [[1,4]]
 *   "1-4周,6-9周"     → [[1,4],[6,9]]   （多个区间以逗号分隔）
 *   "5-17周"          → [[5,17]]
 *
 * 2026-09-13 增补：支持**单周/双周**变体（SRS 附录 A 明确要求，此前会整条课程解析失败）：
 *   "5-17周单周"  → [[5,5],[7,7],[9,9],[11,11],[13,13],[15,15],[17,17]]
 *   "5-17周双周"  → [[6,6],[8,8],[10,10],[12,12],[14,14],[16,16]]
 *   "1-17周(单)"  / "1-4周单" 等写法同样支持
 * 实现策略是**展开为单周区间**：不改动数据模型与占用判定，直接复用既有的
 * weekInRanges 区间逻辑；显示侧由 formatWeekRanges 把等差步长 2 的序列折叠回
 * "5-17周(单)"，保证周次列不至于过长。
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

/**
 * 单个周次记号：
 *   数字（可省略"周"）+ 可选的单/双周后缀。
 * 兼容 "1-4周" / "1-4" / "10周" / "5-17周单周" / "1-17周(单)" / "1-4周双" 等写法。
 * 返回**展开后**的周次区间列表（单/双周展开为逐周）。
 */
function parseOne(item: string): WeekRange[] {
  const PARITY_RE = /^(\d+)(?:\s*[-~—]\s*(\d+))?\s*周?\s*(?:[（(]?\s*(单|双)\s*[）)]?\s*周?)?$/
  const m = item.trim().match(PARITY_RE)
  if (!m) throw new WeekParseError(item)
  const start = Number(m[1])
  const end = m[2] !== undefined ? Number(m[2]) : start
  if (start < 1 || end < start || end > 30) throw new WeekParseError(item)
  const parity = m[3]
  if (!parity) return [[start, end]]
  // 单周取奇数周、双周取偶数周，展开为逐周区间
  const wantOdd = parity === '单'
  const out: WeekRange[] = []
  for (let w = start; w <= end; w++) {
    if (w % 2 === (wantOdd ? 1 : 0)) out.push([w, w])
  }
  return out
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
    .flat()
}

/**
 * 供界面展示："1-4周,6-9周" 风格。
 * 2026-09-13 增强：连续同奇偶的单周（步长 2、数量 ≥ 3）折叠为 "5-17周(单)"，
 * 使单/双周课程在周次列里不至于展开成一长串。
 */
export function formatWeekRanges(ranges: WeekRange[]): string {
  const parts: string[] = []
  let i = 0
  while (i < ranges.length) {
    const [s, e] = ranges[i]
    if (s === e) {
      // 尝试折叠：同奇偶、步长 2、数量 ≥ 3 的单周序列
      let last = s
      let j = i + 1
      while (j < ranges.length && ranges[j][0] === ranges[j][1] && ranges[j][0] === last + 2) {
        last = ranges[j][0]
        j++
      }
      if (j - i >= 3) {
        parts.push(`${s}-${last}周(${s % 2 === 1 ? '单' : '双'})`)
        i = j
        continue
      }
    }
    parts.push(s === e ? `${s}周` : `${s}-${e}周`)
    i++
  }
  return parts.join(',')
}

/** 某周是否在区间列表内（阶段 4 排班算法判断"该周是否有课"的基础运算） */
export function weekInRanges(week: number, ranges: WeekRange[]): boolean {
  return ranges.some(([s, e]) => week >= s && week <= e)
}

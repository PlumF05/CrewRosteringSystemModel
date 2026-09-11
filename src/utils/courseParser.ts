/**
 * 课程表解析器：把学院标准课程表 xlsx（见 SRS 附录 A 的实测格式定义）
 * 翻译为结构化的 ParsedCourse 列表。
 *
 * 解析策略（对照真实样例 timeTableForStu12.xlsx 归纳）：
 * 1. 定位表头行（含 "节次/星期"），从表头行识别 7 个星期列（星期1~星期7/日）；
 * 2. 表头以下，按 A 列的时段标签（如 "第一节-第二节"）划分时段块；
 * 3. 每个时段块 × 星期列 = 一个课程单元格（通常是合并单元格，取合并展开后的值）；
 * 4. 单元格文本按空行拆成多个课程条目，每条目两行：
 *      第 1 行：（本|研|实）课程号-课程名[班次]（或实验课：批次号-课程名-项目-第N批次）
 *      第 2 行：周次列表,星期N,节次范围,地点,
 * 5. "上课时间暂未确定的课程" 区与无法解析的单元格 → 进入 problems，不静默丢弃。
 */
import * as XLSX from 'xlsx'
import { parseWeekList, WeekParseError, type WeekRange } from './weekParser'

export interface ParsedCourse {
  courseNo: string
  courseName: string
  className?: string
  note?: string
  weekRanges: WeekRange[]
  dayOfWeek: number
  /** 节次原文，如 "第三节-中课2" */
  sectionText: string
  sectionStart: number | null
  sectionEnd: number | null
  location?: string
  sourceText: string
}

export interface ParseProblem {
  /** 出问题的单元格坐标（SheetJS A1 风格），可能缺省 */
  cell?: string
  text: string
  reason: string
}

export interface TimetableParseResult {
  studentName: string
  studentNo: string
  semester: string
  /** 网格中出现的时段标签（供排班配置的时段定义参考） */
  slotLabels: string[]
  courses: ParsedCourse[]
  problems: ParseProblem[]
}

export class TimetableParseError extends Error {}

/** 中文节数字映射（第一节=1 … 第十三节=13，覆盖样例即可） */
const CN_NUM: Record<string, number> = {
  一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10,
}

function cnSectionToNumber(token: string): number | null {
  if (/^\d+$/.test(token)) return Number(token)
  if (CN_NUM[token]) return CN_NUM[token]
  if (token === '十') return 10
  const m = token.match(/^十(.)$/)
  if (m && CN_NUM[m[1]]) return 10 + CN_NUM[m[1]]
  const m2 = token.match(/^(.)十$/)
  if (m2 && CN_NUM[m2[1]]) return CN_NUM[m2[1]] * 10
  return null // 中课 / 晚课 等非数字标签
}

/** "第三节-中课2" → { sectionStart: 3, sectionEnd: null }；"中课1-中课2" → 两侧均 null */
function parseSectionText(text: string): { sectionStart: number | null; sectionEnd: number | null } {
  const parts = text.split('-').map((s) => s.replace(/^第/, '').replace(/节$/, '').trim())
  return { sectionStart: cnSectionToNumber(parts[0] ?? ''), sectionEnd: cnSectionToNumber(parts[1] ?? '') }
}

const DAY_RE = /^星期([一二三四五六七日1-7])$/
const DAY_ALIASES: Record<string, number> = {
  一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 日: 7,
  '1': 1, '2': 2, '3': 3, '4': 4, '5': 5, '6': 6, '7': 7,
}
const TAG_RE = /^[（(](.+?)[)）](.+)$/

/** 解析信息行：周次列表,星期N,节次,地点 */
function parseInfoLine(
  text: string,
  source: string,
): Omit<ParsedCourse, 'courseNo' | 'courseName' | 'className' | 'note' | 'sourceText'> {
  const parts = text.replace(/，/g, ',').split(',').map((s) => s.trim()).filter((s) => s.length > 0)
  const dayIdx = parts.findIndex((p) => DAY_RE.test(p))
  if (dayIdx < 0) throw new Error(`缺少星期信息：${source}`)
  const dayToken = DAY_RE.exec(parts[dayIdx])![1]
  const dayOfWeek = DAY_ALIASES[dayToken]
  // 星期之前的所有部分都是周次
  const weekRanges: WeekRange[] = []
  for (const p of parts.slice(0, dayIdx)) weekRanges.push(...parseWeekList(p))
  // 星期之后：节次部分 = 含"节/中课/晚课"的部分
  const rest = parts.slice(dayIdx + 1)
  const secIdx = rest.findIndex((p) => /节|中课|晚课/.test(p))
  if (secIdx < 0) throw new Error(`缺少节次信息：${source}`)
  const sectionText = rest[secIdx]
  const location = rest.slice(secIdx + 1).find((p) => p.length > 0)
  return { weekRanges, dayOfWeek, sectionText, ...parseSectionText(sectionText), location }
}

/** 解析条目首行：（本）课程号-课程名[班次] / （实）批次号-课程名-实验项目-第N批次 */
function parseTitleLine(line: string): Pick<ParsedCourse, 'courseNo' | 'courseName' | 'className' | 'note'> {
  const m = line.match(TAG_RE)
  if (!m) throw new Error(`课程条目格式不正确（缺少（本/研/实）前缀）：${line}`)
  const tag = m[1]
  const rest = m[2].trim()
  if (tag === '实') {
    // （实）20261-07741-数据库系统综合实验-索引和完整性语言-第1批次
    const segs = rest.split('-').map((s) => s.trim())
    if (segs.length < 3) throw new Error(`实验课条目格式不正确：${line}`)
    const courseNo = segs.slice(0, 2).join('-')
    const courseName = segs[2]
    return { courseNo, courseName, note: segs.slice(3).join('-') }
  }
  // （本|研）10125121047-软件工程[02]
  const m2 = rest.match(/^(\d+)-(.+?)(?:\[(.+)\])?$/)
  if (!m2) throw new Error(`课程条目格式不正确：${line}`)
  return { courseNo: m2[1], courseName: m2[2], className: m2[3] }
}

function isTitleLine(line: string): boolean {
  return TAG_RE.test(line)
}

/** 单元格文本 → 课程条目数组（按 （本/研/实） 开头拆分多条目） */
function parseCellText(text: string, cell: string, problems: ParseProblem[]): ParsedCourse[] {
  const lines = text.split(/\r?\n/).map((s) => s.trim()).filter((s) => s.length > 0)
  const courses: ParsedCourse[] = []
  let current: { title: string; info?: string } | null = null
  const flush = () => {
    if (!current) return
    try {
      const title = parseTitleLine(current.title)
      if (!current.info) throw new Error('缺少周次/时间行')
      const info = parseInfoLine(current.info, current.title)
      courses.push({ ...title, ...info, sourceText: text })
    } catch (e) {
      if (e instanceof WeekParseError) {
        problems.push({ cell, text: current.title, reason: (e as Error).message })
      } else {
        problems.push({ cell, text: current.title, reason: (e as Error).message })
      }
    }
    current = null
  }
  for (const line of lines) {
    if (isTitleLine(line)) {
      flush()
      current = { title: line }
    } else if (current) {
      current.info = current.info ? `${current.info},${line}` : line
    }
  }
  flush()
  return courses
}

export function parseTimetableWorkbook(data: Uint8Array | ArrayBuffer): TimetableParseResult {
  const wb = XLSX.read(data, { type: 'array' })
  const ws = wb.Sheets[wb.SheetNames[0]]
  if (!ws) throw new TimetableParseError('工作簿中没有工作表')

  const range = ws['!ref']
  if (!range) throw new TimetableParseError('工作表为空')
  const merges = ws['!merges'] ?? []

  // 合并单元格展开：值取区域左上角
  const valueAt = (r: number, c: number): string | undefined => {
    const cell = ws[XLSX.utils.encode_cell({ r, c })]
    const v = cell?.v
    return v === undefined || v === null ? undefined : String(v)
  }
  const expanded = (r: number, c: number): string | undefined => {
    const direct = valueAt(r, c)
    if (direct !== undefined && direct !== '') return direct
    for (const m of merges) {
      if (r >= m.s.r && r <= m.e.r && c >= m.s.c && c <= m.e.c) {
        const v = valueAt(m.s.r, m.s.c)
        if (v !== undefined && v !== '') return v
      }
    }
    return undefined
  }

  const problems: ParseProblem[] = []

  // 1. 定位表头行：包含 "节次/星期"
  let headerRow = -1
  const dims = XLSX.utils.decode_range(range)
  for (let r = dims.s.r; r <= Math.min(dims.e.r, 30); r++) {
    for (let c = dims.s.c; c <= dims.e.c; c++) {
      if (expanded(r, c)?.includes('节次/星期')) { headerRow = r; break }
    }
    if (headerRow >= 0) break
  }
  if (headerRow < 0) throw new TimetableParseError('找不到表头行（节次/星期）——请确认这是学院标准课程表')

  // 2. 星期列映射
  const dayCols = new Map<number, number>() // col -> dayOfWeek
  for (let c = dims.s.c; c <= dims.e.c; c++) {
    const v = expanded(headerRow, c)
    if (!v) continue
    const m = DAY_RE.exec(v.trim())
    if (m) dayCols.set(c, DAY_ALIASES[m[1]])
  }
  if (dayCols.size === 0) throw new TimetableParseError('表头行中找不到星期一~星期日列')

  // 3. 学生与学期信息（表头行之前）
  let studentName = ''
  let studentNo = ''
  let semester = ''
  for (let r = dims.s.r; r < headerRow; r++) {
    for (let c = dims.s.c; c <= dims.e.c; c++) {
      const v = expanded(r, c)
      if (!v) continue
      const sm = v.match(/学生\s*[：:]\s*(.+?)[（(](\d+)[）)]/)
      if (sm) { studentName = sm[1].trim(); studentNo = sm[2] }
      const sem = v.match(/(\d{4}-\d{4}-\d)/)
      if (sem && !semester) semester = sem[1]
    }
  }
  if (!studentNo) problems.push({ text: '未在表头区找到"学生：姓名(学号)"信息', reason: '缺少学生标识，导入时需手动选择归属助理' })

  // 4. 未确定时间的课程区（表头之前，"上课时间暂未确定的课程"之后）
  //    注意：标签与课程内容在同一行（如 A4=标签、D4:I4=内容），不能整行 continue；
  //    内容是横向合并单元格，按列展开会重复命中，故按文本去重
  const undeterminedSet = new Set<string>()
  let inUndetermined = false
  for (let r = dims.s.r; r < headerRow; r++) {
    const a = expanded(r, dims.s.c) ?? ''
    if (a.includes('调课信息')) { inUndetermined = false; continue }
    if (a.includes('上课时间暂未确定')) inUndetermined = true
    if (!inUndetermined) continue
    for (let c = dims.s.c + 1; c <= dims.e.c; c++) {
      const v = expanded(r, c)
      if (v && v.trim() && !v.includes('上课时间暂未确定')) undeterminedSet.add(v.trim())
    }
  }
  const undetermined = [...undeterminedSet]
  for (const u of undetermined) {
    problems.push({ text: u, reason: '该课程上课时间暂未确定，未计入空闲时间计算，请人工确认' })
  }

  // 5. 时段块：表头以下按 A 列标签切分
  const slotLabels: string[] = []
  const blocks: Array<{ startRow: number; endRow: number; label: string }> = []
  for (let r = headerRow + 1; r <= dims.e.r; r++) {
    const label = valueAt(r, 0) ?? valueAt(r, 1)
    if (label && label.trim() && !slotLabels.includes(label.trim())) {
      slotLabels.push(label.trim())
      blocks.push({ startRow: r, endRow: r, label: label.trim() })
    } else if (blocks.length > 0 && !(valueAt(r, 0)?.trim())) {
      blocks[blocks.length - 1].endRow = r
    }
  }
  // 用合并信息扩展块边界（A 列合并的 max_row 即块尾）
  for (const m of merges) {
    if (m.s.c === 0) {
      const label = valueAt(m.s.r, 0)
      const block = blocks.find((b) => b.label === label?.trim())
      if (block) block.endRow = Math.max(block.endRow, m.e.r)
    }
  }

  // 6. 遍历 块 × 星期列，解析课程单元格
  const courses: ParsedCourse[] = []
  const seen = new Set<string>()
  for (const block of blocks) {
    for (const [col] of dayCols) {
      // 块内该列可能有多个独立单元格（合并被拆分的情况），去重后逐个解析
      const cellTexts = new Map<string, string>()
      for (let r = block.startRow; r <= block.endRow; r++) {
        // 找到 (r, col) 所属合并区域的左上角值
        const m = merges.find((mm) => r >= mm.s.r && r <= mm.e.r && col >= mm.s.c && col <= mm.e.c)
        const anchorR = m ? m.s.r : r
        const anchorC = m ? m.s.c : col
        const v = valueAt(anchorR, anchorC)
        if (v && v.trim()) cellTexts.set(`${anchorR}:${anchorC}`, v)
      }
      for (const [key, text] of cellTexts) {
        const parsed = parseCellText(text, key, problems)
        for (const p of parsed) {
          const dedupeKey = `${p.courseNo}|${p.courseName}|${p.dayOfWeek}|${p.sectionText}|${p.location ?? ''}|${JSON.stringify(p.weekRanges)}`
          if (!seen.has(dedupeKey)) {
            seen.add(dedupeKey)
            courses.push(p)
          }
        }
      }
    }
  }

  return { studentName, studentNo, semester, slotLabels, courses, problems }
}

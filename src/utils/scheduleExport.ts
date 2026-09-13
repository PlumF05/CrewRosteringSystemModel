/**
 * 排班表导出（SRS F05 导出侧，2026-09-13 修订）：生成带版式的 xlsx。
 *
 * 结构：
 *   Sheet1「排班表」：标题（合并、加粗）+ 周次/生成时间行 + 按节次的网格
 *                    （行=节次并标注上课时间，列=工作日）
 *                    格子文案 = 值班人姓名；开启"含电话"时姓名与电话**上下两行**显示
 *   Sheet2「值班明细」：逐条列出 周次/星期/节次（含时间）/姓名/电话（仅开启"含电话"时导出）
 *
 * 个人信息口径（2026-09-13 修订）：导出**只携带"电话号码"这一项**个人信息，
 * 不写入学号、QQ 或任何其他个人信息；电话在导出时默认自动填充，可在导出前关闭。
 *
 * 依赖说明（2026-09-13）：由 SheetJS 社区版切换到其直系分支 `xlsx-js-style`。
 * 原因：社区版**无法写入任何单元格样式**（实测 styles.xml 中既无 alignment 也无 wrapText，
 * 单元格不带 s 属性），因而无法实现"姓名/电话 上下排列"与版式美化。该分支基于同一
 * SheetJS 0.18.5，读写 API 完全兼容，仅额外支持 `cell.s`（字体/边框/对齐/填充）。
 *
 * 兼容性：产物为标准 xlsx，Microsoft Excel 与 WPS 均可正常打开。
 */
import * as XLSX from 'xlsx-js-style'
import { SECTION_TIME, formatSectionLabel, type SchedulingRules } from '../algorithms/types'
import { collectGridDays, collectGridKeys, DAY_LABELS } from './scheduleGrid'
import { weekInRanges } from './weekParser'
import { sectionOrdinal, sectionOrdinalRange } from './sectionOrder'

export interface ExportInput {
  weekNo: number
  rules: SchedulingRules
  /** 排班行（最小字段集） */
  rows: Array<{ dayOfWeek: number; timeSlot: string; assistantId: number }>
  nameById: Map<number, string>
  /** 助理联系电话——**唯一**被导出的个人信息项；缺省表示未登记 */
  phoneById: Map<number, string>
  /** 生成时间文案，缺省为当前时间 */
  generatedAt?: string
  /**
   * 是否把联系电话自动填入排班表（调用方默认传 true）。
   * true = 格子为「姓名 / 电话」上下两行并附「值班明细」表；
   * false = 格子仅姓名、不生成「值班明细」表（用于对联系方式敏感的场合）。
   */
  includePhone: boolean
}

/** 统一细边框，让打印出来的表格有网格感 */
const BORDER: XLSX.CellStyle['border'] = {
  top: { style: 'thin', color: { rgb: 'BFBFBF' } },
  bottom: { style: 'thin', color: { rgb: 'BFBFBF' } },
  left: { style: 'thin', color: { rgb: 'BFBFBF' } },
  right: { style: 'thin', color: { rgb: 'BFBFBF' } },
}
const solid = (rgb: string): XLSX.CellStyle['fill'] => ({
  patternType: 'solid',
  fgColor: { rgb },
})

/** 版式定义：集中在此便于统一调整观感 */
const STYLE = {
  title: {
    font: { bold: true, sz: 14 },
    alignment: { horizontal: 'center', vertical: 'center' },
  } as XLSX.CellStyle,
  meta: {
    font: { sz: 10, color: { rgb: '808080' } },
    alignment: { horizontal: 'center', vertical: 'center' },
  } as XLSX.CellStyle,
  header: {
    font: { bold: true, sz: 11 },
    fill: solid('F2F5FA'),
    alignment: { horizontal: 'center', vertical: 'center', wrapText: true },
    border: BORDER,
  } as XLSX.CellStyle,
  slot: {
    font: { bold: true, sz: 11 },
    fill: solid('FAFAFA'),
    alignment: { horizontal: 'center', vertical: 'center', wrapText: true },
    border: BORDER,
  } as XLSX.CellStyle,
  cell: {
    alignment: { horizontal: 'center', vertical: 'center', wrapText: true },
    border: BORDER,
  } as XLSX.CellStyle,
  empty: {
    font: { color: { rgb: 'C0C4CC' } },
    alignment: { horizontal: 'center', vertical: 'center' },
    border: BORDER,
  } as XLSX.CellStyle,
}

export function buildScheduleWorkbook(input: ExportInput): XLSX.WorkBook {
  const { weekNo, rules, rows, nameById, phoneById, includePhone } = input
  const generatedAt = input.generatedAt ?? new Date().toLocaleString('zh-CN')

  /**
   * 格子文案：
   *   含电话 → 姓名与电话**上下两行**（Excel 靠 alignment.wrapText 生效）
   *   不含电话 → 只显示姓名；未登记电话时也不留空行
   */
  const labelOf = (assistantId: number): string => {
    const name = nameById.get(assistantId) ?? `#${assistantId}`
    if (!includePhone) return name
    const phone = (phoneById.get(assistantId) ?? '').trim()
    return phone ? `${name}\n${phone}` : name
  }

  // ----- 网格骨架：行 = 节次、列 = 工作日，取「当前规则 ∪ 已写入数据」的并集 -----
  //（只按当前规则推导时，管理员改完上班节次直接导出，已排数据会整体"隐身"成 —）
  const workdays = collectGridDays(rules, rows)
  const gridKeys = collectGridKeys(rules, rows)
  const cellMap = new Map<string, string[]>() // "day|c{n}" -> labels
  for (const r of rows) {
    const key = `${r.dayOfWeek}|${r.timeSlot}`
    const list = cellMap.get(key) ?? []
    list.push(labelOf(r.assistantId))
    cellMap.set(key, list)
  }

  // ----- Sheet1：排班表网格 -----
  const header = ['时段（节次）', ...workdays.map((d) => DAY_LABELS[d])]
  const gridAoa: (string | number)[][] = []
  const titleRow = 0
  const metaRow = 1
  const totalCols = header.length
  gridAoa.push([`行政办助理排班表（第 ${weekNo} 周）`])
  gridAoa.push([`生成时间：${generatedAt}　｜　排班周期：第 ${rules.weekStart}~${rules.weekEnd} 周`])
  gridAoa.push(header)
  for (const g of gridKeys) {
    // 行标题带上课时间（如「上午 第1节 8:00~8:45」）；数据独有的节次只显示节号
    const row: (string | number)[] = [g.label]
    for (const day of workdays) {
      // 含电话时同一时段多人也按行堆叠（每人两行），否则用顿号并列
      const labels = cellMap.get(`${day}|${g.key}`) ?? []
      row.push(labels.length ? labels.join(includePhone ? '\n' : '、') : '—')
    }
    gridAoa.push(row)
  }
  const ws1 = XLSX.utils.aoa_to_sheet(gridAoa)

  // 逐格赋予版式：标题 / 元信息 / 表头 / 行标题 / 数据格 / 空占位
  for (let r = 0; r < gridAoa.length; r++) {
    for (let c = 0; c < gridAoa[r].length; c++) {
      const cell = ws1[XLSX.utils.encode_cell({ r, c })]
      if (!cell) continue
      if (r === titleRow) cell.s = STYLE.title
      else if (r === metaRow) cell.s = STYLE.meta
      else if (r === 2) cell.s = STYLE.header
      else if (c === 0) cell.s = STYLE.slot
      else cell.s = cell.v === '—' ? STYLE.empty : STYLE.cell
    }
  }

  ws1['!merges'] = [
    { s: { r: titleRow, c: 0 }, e: { r: titleRow, c: totalCols - 1 } },
    { s: { r: metaRow, c: 0 }, e: { r: metaRow, c: totalCols - 1 } },
  ]
  // 列宽：首列要容纳「上午 第1节 8:00~8:45」；含电话时日期列需容纳 11 位号码
  ws1['!cols'] = [{ wch: 24 }, ...workdays.map(() => ({ wch: includePhone ? 18 : 12 }))]
  // 仅固定标题两行的高度；数据行留空高度，交由 Excel 按换行内容自动撑开
  ws1['!rows'] = [{ hpt: 26 }, { hpt: 18 }]

  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, ws1, '排班表')

  // ----- Sheet2：值班明细（仅电话这一项个人信息；仅在开启"含电话"时导出） -----
  if (includePhone) {
    const detailAoa: (string | number)[][] = [['周次', '星期', '节次', '姓名', '电话']]
    const sorted = [...rows].sort(
      (x, y) =>
        x.dayOfWeek - y.dayOfWeek ||
        Number(x.timeSlot.slice(1)) - Number(y.timeSlot.slice(1)) ||
        x.assistantId - y.assistantId,
    )
    for (const r of sorted) {
      const sec = Number(r.timeSlot.slice(1))
      detailAoa.push([
        weekNo,
        DAY_LABELS[r.dayOfWeek] ?? String(r.dayOfWeek),
        // 节次同样带上课时间
        formatSectionLabel('', sec).trim(),
        nameById.get(r.assistantId) ?? `#${r.assistantId}`,
        (phoneById.get(r.assistantId) ?? '').trim(),
      ])
    }
    const ws2 = XLSX.utils.aoa_to_sheet(detailAoa)
    for (let r = 0; r < detailAoa.length; r++) {
      for (let c = 0; c < detailAoa[r].length; c++) {
        const cell = ws2[XLSX.utils.encode_cell({ r, c })]
        if (!cell) continue
        const base = r === 0 ? STYLE.header : STYLE.cell
        // 姓名/电话列靠左更易读，其余居中
        cell.s = c >= 3 && r > 0 ? { ...base, alignment: { ...base.alignment, horizontal: 'left' } } : base
      }
    }
    ws2['!cols'] = [{ wch: 8 }, { wch: 10 }, { wch: 20 }, { wch: 12 }, { wch: 16 }]
    XLSX.utils.book_append_sheet(wb, ws2, '值班明细')
  }

  return wb
}

/** 生成 xlsx 二进制（Tauri 桌面端：配合 saveXlsx 写入用户选择的路径；浏览器端请用 exportScheduleFile） */
export function buildScheduleFileBuffer(input: ExportInput): Uint8Array {
  const wb = buildScheduleWorkbook(input)
  return new Uint8Array(XLSX.write(wb, { bookType: 'xlsx', type: 'array' }) as ArrayBuffer)
}

/** 生成并触发浏览器下载（浏览器环境回退；Tauri 环境请改走 fileAccess.saveXlsx） */
export function exportScheduleFile(input: ExportInput, fileName: string): void {
  const wb = buildScheduleWorkbook(input)
  XLSX.writeFile(wb, fileName)
}

/** 导出文件名：排班表-第N周-YYYYMMDD.xlsx */
export function scheduleFileName(weekNo: number, now = new Date()): string {
  const y = now.getFullYear()
  const m = String(now.getMonth() + 1).padStart(2, '0')
  const d = String(now.getDate()).padStart(2, '0')
  return `排班表-第${weekNo}周-${y}${m}${d}.xlsx`
}

/** 供测试用：某节次的上课时间文案（未登记时间返回空串） */
export function sectionTimeText(section: number): string {
  return SECTION_TIME[section] ?? ''
}

/** 供测试/校验用：某助理在某周是否真的空闲（与算法占用规则完全一致，含节次序号换算） */
export function isAssistantFree(
  courses: Array<{
    assistantId: number
    kind?: 'theory' | 'experiment'
    dayOfWeek: number
    /** 节次原文（如 "第三节-中课2"、"第六节-第八节"） */
    sectionText: string
    weekRanges: [number, number][]
  }>,
  assistantId: number,
  weekNo: number,
  day: number,
  section: number,
  countTheory: boolean,
  countExperiment: boolean,
): boolean {
  const ord = sectionOrdinal(String(section))
  for (const c of courses) {
    if (c.assistantId !== assistantId || c.dayOfWeek !== day) continue
    const isExp = (c.kind ?? 'theory') === 'experiment'
    if (isExp ? !countExperiment : !countTheory) continue
    if (!weekInRanges(weekNo, c.weekRanges)) continue
    const range = sectionOrdinalRange(c.sectionText)
    // 节次无法识别 → 与算法一致，保守视为整天占用（宁可少排，不在课上排班）
    if (range === null || ord === null) return false
    if (range.start <= ord && range.end >= ord) return false
  }
  return true
}

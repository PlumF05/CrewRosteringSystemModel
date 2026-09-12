/**
 * 排班表导出（SRS F05 导出侧）：生成格式化 xlsx。
 *
 * 结构：
 *   Sheet1「排班表」：标题（合并）+ 周次/生成时间行 + 按节次的网格（行=节次，列=工作日）
 *   Sheet2「值班明细」：逐条列出 周次/星期/节次/姓名/学号/电话/QQ（SRS 要求含联系方式）
 *
 * 说明：社区版 SheetJS 不支持单元格加粗/填充色样式，故以合并单元格 + 列宽保证可读性，
 * 兼容 Microsoft Excel 与 WPS（风险 R04 相关：导出前不修改任何数据，纯只读）。
 */
import * as XLSX from 'xlsx'
import type { SchedulingRules } from '../algorithms/types'
import { weekInRanges } from './weekParser'

export interface ExportContact {
  studentNo: string
  phone?: string
  qq?: string
}

export interface ExportInput {
  weekNo: number
  rules: SchedulingRules
  /** 排班行（最小字段集） */
  rows: Array<{ dayOfWeek: number; timeSlot: string; assistantId: number }>
  nameById: Map<number, string>
  contactsById: Map<number, ExportContact>
  /** 生成时间文案，缺省为当前时间 */
  generatedAt?: string
  /**
   * 是否包含助理个人信息（学号/电话/QQ）。
   * true = "排班表" + "值班明细"（含联系方式）双表；false = 仅"排班表"网格。
   */
  includePersonalInfo: boolean
}

const DAY_LABELS: Record<number, string> = {
  1: '星期一', 2: '星期二', 3: '星期三', 4: '星期四', 5: '星期五', 6: '星期六', 7: '星期日',
}

export function buildScheduleWorkbook(input: ExportInput): XLSX.WorkBook {
  const { weekNo, rules, rows, nameById, contactsById, includePersonalInfo } = input
  const generatedAt = input.generatedAt ?? new Date().toLocaleString('zh-CN')

  // ----- 网格数据：行 = 节次（升序），列 = 工作日 -----
  const workdays = [...rules.workdays].sort((a, b) => a - b)
  const sections: number[] = []
  for (const sec of rules.workSections) {
    for (let s = sec.start; s <= sec.end; s++) sections.push(s)
  }
  const cellMap = new Map<string, string[]>() // "day|c{n}" -> names
  for (const r of rows) {
    const key = `${r.dayOfWeek}|${r.timeSlot}`
    const list = cellMap.get(key) ?? []
    list.push(nameById.get(r.assistantId) ?? `#${r.assistantId}`)
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
  for (const sec of sections) {
    const periodLabel = rules.workSections.find((w) => sec >= w.start && sec <= w.end)?.label ?? ''
    const row: (string | number)[] = [`${periodLabel} 第${sec}节`]
    for (const day of workdays) {
      row.push((cellMap.get(`${day}|c${sec}`) ?? []).join('、') || '—')
    }
    gridAoa.push(row)
  }
  const ws1 = XLSX.utils.aoa_to_sheet(gridAoa)
  ws1['!merges'] = [
    { s: { r: titleRow, c: 0 }, e: { r: titleRow, c: totalCols - 1 } },
    { s: { r: metaRow, c: 0 }, e: { r: metaRow, c: totalCols - 1 } },
  ]
  ws1['!cols'] = [{ wch: 16 }, ...workdays.map(() => ({ wch: 14 }))]

  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, ws1, '排班表')

  // ----- Sheet2：值班明细（含联系方式；仅在包含个人信息时导出） -----
  if (includePersonalInfo) {
    const detailAoa: (string | number)[][] = [
      ['周次', '星期', '节次', '姓名', '学号', '电话', 'QQ'],
    ]
    const sorted = [...rows].sort(
      (x, y) =>
        x.dayOfWeek - y.dayOfWeek ||
        Number(x.timeSlot.slice(1)) - Number(y.timeSlot.slice(1)) ||
        x.assistantId - y.assistantId,
    )
    for (const r of sorted) {
      const sec = Number(r.timeSlot.slice(1))
      const contact = contactsById.get(r.assistantId)
      detailAoa.push([
        weekNo,
        DAY_LABELS[r.dayOfWeek] ?? String(r.dayOfWeek),
        `第${sec}节`,
        nameById.get(r.assistantId) ?? `#${r.assistantId}`,
        contact?.studentNo ?? '',
        contact?.phone ?? '',
        contact?.qq ?? '',
      ])
    }
    const ws2 = XLSX.utils.aoa_to_sheet(detailAoa)
    ws2['!cols'] = [{ wch: 8 }, { wch: 10 }, { wch: 10 }, { wch: 12 }, { wch: 14 }, { wch: 14 }, { wch: 14 }]
    XLSX.utils.book_append_sheet(wb, ws2, '值班明细')
  }

  return wb
}

/** 生成并触发浏览器下载（Tauri 阶段将替换为保存对话框路径） */
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

/** 供测试/校验用：某助理在某周是否真的空闲（与算法占用规则一致） */
export function isAssistantFree(
  courses: Array<{
    assistantId: number
    kind?: 'theory' | 'experiment'
    dayOfWeek: number
    sectionStart: number | null
    sectionEnd: number | null
    weekRanges: [number, number][]
  }>,
  assistantId: number,
  weekNo: number,
  day: number,
  section: number,
  countTheory: boolean,
  countExperiment: boolean,
): boolean {
  for (const c of courses) {
    if (c.assistantId !== assistantId || c.dayOfWeek !== day) continue
    const isExp = (c.kind ?? 'theory') === 'experiment'
    if (isExp ? !countExperiment : !countTheory) continue
    if (!weekInRanges(weekNo, c.weekRanges)) continue
    if (c.sectionStart === null || (c.sectionEnd !== null && c.sectionStart <= section && c.sectionEnd >= section))
      return false
  }
  return true
}

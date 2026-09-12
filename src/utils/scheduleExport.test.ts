import { describe, expect, it } from 'vitest'
import * as XLSX from 'xlsx'
import {
  buildScheduleWorkbook,
  exportScheduleFile,
  isAssistantFree,
  scheduleFileName,
} from './scheduleExport'
import { DEFAULT_RULES, type SchedulingRules } from '../algorithms/types'

/**
 * 导出功能测试：构建工作簿后**读回**断言（与真实 Excel 读文件同一条 SheetJS 路径），
 * 保证写出的文件结构正确，而不是只检查内存对象。
 */

const rules: SchedulingRules = {
  ...DEFAULT_RULES,
  weekStart: 1,
  weekEnd: 1,
  workdays: [1, 5],
  workSections: [{ start: 1, end: 2, label: '上午' }],
}

const input = {
  weekNo: 3,
  rules,
  rows: [
    { dayOfWeek: 1, timeSlot: 'c1', assistantId: 1 },
    { dayOfWeek: 1, timeSlot: 'c2', assistantId: 2 },
    { dayOfWeek: 5, timeSlot: 'c1', assistantId: 2 },
  ],
  nameById: new Map([
    [1, '张三'],
    [2, '李四'],
  ]),
  contactsById: new Map([
    [1, { studentNo: '1001', phone: '13800000001', qq: '111' }],
    [2, { studentNo: '1002', phone: '13800000002', qq: '222' }],
  ]),
  generatedAt: '2026/09/11 16:00:00',
}

function readBack(): XLSX.WorkBook {
  const wb = buildScheduleWorkbook(input)
  const buf = XLSX.write(wb, { type: 'array', bookType: 'xlsx' })
  return XLSX.read(buf, { type: 'array' })
}

describe('buildScheduleWorkbook（导出并读回校验）', () => {
  it('包含两个工作表：排班表 + 值班明细', () => {
    const wb = readBack()
    expect(wb.SheetNames).toEqual(['排班表', '值班明细'])
  })

  it('排班表 Sheet：标题/周次/表头/网格内容', () => {
    const wb = readBack()
    const ws = wb.Sheets['排班表']
    expect(ws['A1'].v).toBe('行政办助理排班表（第 3 周）')
    expect(ws['A2'].v).toContain('生成时间：2026/09/11 16:00:00')
    expect(ws['A2'].v).toContain('排班周期：第 1~1 周')
    expect(ws['A3'].v).toBe('时段（节次）')
    expect(ws['B3'].v).toBe('星期一')
    expect(ws['C3'].v).toBe('星期五')
    // 节次行：第1节 星期一=张三，星期五=李四
    const row4 = 3 // 0-based：第 4 行
    expect(ws[XLSX.utils.encode_cell({ r: row4, c: 0 })].v).toBe('上午 第1节')
    expect(ws[XLSX.utils.encode_cell({ r: row4, c: 1 })].v).toBe('张三')
    expect(ws[XLSX.utils.encode_cell({ r: row4, c: 2 })].v).toBe('李四')
    // 第2节：星期一=李四（d1c2），星期五无人
    expect(ws[XLSX.utils.encode_cell({ r: 4, c: 1 })].v).toBe('李四')
    expect(ws[XLSX.utils.encode_cell({ r: 4, c: 2 })].v).toBe('—')
  })

  it('标题行有合并单元格（横跨全部列）', () => {
    const wb = readBack()
    const ws = wb.Sheets['排班表']
    expect(ws['!merges']).toHaveLength(2)
    expect(ws['!merges'][0].e.c).toBe(2) // 3 列（时段+2 天）
  })

  it('值班明细 Sheet：逐条含联系方式', () => {
    const wb = readBack()
    const ws = wb.Sheets['值班明细']
    expect(ws['A1'].v).toBe('周次')
    // 数据按 星期/节次/助理 排序：d1c1 张三 → d1c2 李四 → d5c1 李四
    expect(ws['C2'].v).toBe('第1节')
    expect(ws['D2'].v).toBe('张三')
    expect(ws['E2'].v).toBe('1001')
    expect(ws['F2'].v).toBe('13800000001')
    expect(ws['D3'].v).toBe('李四')
    expect(ws['G3'].v).toBe('222')
    expect(ws['A4'].v).toBe(3)
  })

  it('文件名格式：排班表-第N周-YYYYMMDD.xlsx', () => {
    expect(scheduleFileName(3, new Date(2026, 8, 11))).toBe('排班表-第3周-20260911.xlsx')
  })

  it('exportScheduleFile 不抛错（真实写出路径）', () => {
    expect(() => exportScheduleFile(input, 'test-export.xlsx')).not.toThrow()
  })
})

describe('isAssistantFree（导出/校验共用的占用判定）', () => {
  const courses: Parameters<typeof isAssistantFree>[0] = [
    { assistantId: 1, kind: 'theory', dayOfWeek: 1, sectionStart: 1, sectionEnd: 2, weekRanges: [[1, 17]] },
    { assistantId: 1, kind: 'experiment', dayOfWeek: 2, sectionStart: 1, sectionEnd: 2, weekRanges: [[10, 17]] },
  ]

  it('有课则不空闲', () => {
    expect(isAssistantFree(courses, 1, 1, 1, 1, true, true)).toBe(false)
  })

  it('周次不覆盖 → 空闲', () => {
    expect(isAssistantFree(courses, 1, 1, 2, 1, true, true)).toBe(true) // 实验课 10 周才开始
    expect(isAssistantFree(courses, 1, 2, 1, 5, true, true)).toBe(true) // 理论课只占 1~2 节
  })

  it('类别过滤：关闭实验课 → 实验课不再挡人', () => {
    expect(isAssistantFree(courses, 1, 12, 2, 1, true, true)).toBe(false) // 开启：12 周实验课挡人
    expect(isAssistantFree(courses, 1, 12, 2, 1, true, false)).toBe(true) // 关闭：不挡
  })

  it('节次不重叠 → 空闲', () => {
    expect(isAssistantFree(courses, 1, 1, 3, 3, true, true)).toBe(true)
  })
})

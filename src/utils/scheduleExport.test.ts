import { describe, expect, it } from 'vitest'
import { inflateRawSync } from 'node:zlib'
import * as XLSX from 'xlsx-js-style'
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
 *
 * 2026-09-13 修订：
 * - 个人信息口径收紧为"只含电话"，增加"学号/QQ 不得出现"的全量断言；
 * - 新增节次上课时间标注与"姓名/电话 上下两行"的断言，后者直接解压产物读取
 *   xl/styles.xml 校验 wrapText（样式是社区版 SheetJS 写不出的，必须字节级锁定）。
 */

const rules: SchedulingRules = {
  ...DEFAULT_RULES,
  weekStart: 1,
  weekEnd: 1,
  workdays: [1, 5],
  workSections: [{ start: 1, end: 2, label: '上午' }],
}

/** 覆盖上午 1~4 节与下午 6~9 节，用于校验节次时间标注 */
const fullRules: SchedulingRules = {
  ...DEFAULT_RULES,
  weekStart: 1,
  weekEnd: 1,
  workdays: [1],
  workSections: [
    { start: 1, end: 4, label: '上午' },
    { start: 6, end: 9, label: '下午' },
  ],
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
    [2, '示例学生A'],
  ]),
  phoneById: new Map([
    [1, '13800000001'],
    [2, '13800000002'],
  ]),
  generatedAt: '2026/09/11 16:00:00',
  includePhone: true,
}

function workbook(over: Partial<typeof input> = {}): XLSX.WorkBook {
  return buildScheduleWorkbook({ ...input, ...over })
}

function readBack(over: Partial<typeof input> = {}): XLSX.WorkBook {
  const buf = XLSX.write(workbook(over), { type: 'array', bookType: 'xlsx' })
  return XLSX.read(buf, { type: 'array' })
}

/** 把整个工作簿的单元格文本摊平，用于"不得出现某类信息"的全量断言 */
function allCellTexts(wb: XLSX.WorkBook): string[] {
  const out: string[] = []
  for (const name of wb.SheetNames) {
    const ws = wb.Sheets[name]
    for (const addr of Object.keys(ws)) {
      if (addr.startsWith('!')) continue
      const v = ws[addr].v
      if (v !== undefined && v !== null) out.push(String(v))
    }
  }
  return out
}

/** 直接从 xlsx（zip）字节中取出某个条目的文本——用于校验真实产物里的样式 XML */
function readZipEntry(buf: ArrayBufferLike, name: string): string {
  const bytes = new Uint8Array(buf)
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let eocd = -1
  for (let i = bytes.length - 22; i >= 0; i--) {
    if (dv.getUint32(i, true) === 0x06054b50) {
      eocd = i
      break
    }
  }
  if (eocd < 0) throw new Error('EOCD not found')
  const count = dv.getUint16(eocd + 10, true)
  let off = dv.getUint32(eocd + 16, true)
  const dec = new TextDecoder()
  for (let i = 0; i < count; i++) {
    if (dv.getUint32(off, true) !== 0x02014b50) throw new Error('bad central directory header')
    const method = dv.getUint16(off + 10, true)
    const compSize = dv.getUint32(off + 20, true)
    const nameLen = dv.getUint16(off + 28, true)
    const extraLen = dv.getUint16(off + 30, true)
    const commentLen = dv.getUint16(off + 32, true)
    const localOff = dv.getUint32(off + 42, true)
    const entryName = dec.decode(bytes.subarray(off + 46, off + 46 + nameLen))
    if (entryName === name) {
      const lNameLen = dv.getUint16(localOff + 26, true)
      const lExtraLen = dv.getUint16(localOff + 28, true)
      const start = localOff + 30 + lNameLen + lExtraLen
      const raw = bytes.subarray(start, start + compSize)
      return dec.decode(method === 0 ? raw : inflateRawSync(raw))
    }
    off += 46 + nameLen + extraLen + commentLen
  }
  throw new Error(`zip entry not found: ${name}`)
}

describe('buildScheduleWorkbook（导出并读回校验）', () => {
  it('包含两个工作表：排班表 + 值班明细', () => {
    const wb = readBack()
    expect(wb.SheetNames).toEqual(['排班表', '值班明细'])
  })

  it('排班表 Sheet：标题/周次/表头/网格内容（电话默认自动填入，姓名与电话上下两行）', () => {
    const wb = readBack()
    const ws = wb.Sheets['排班表']
    expect(ws['A1'].v).toBe('行政办助理排班表（第 3 周）')
    expect(ws['A2'].v).toContain('生成时间：2026/09/11 16:00:00')
    expect(ws['A2'].v).toContain('排班周期：第 1~1 周')
    expect(ws['A3'].v).toBe('时段（节次）')
    expect(ws['B3'].v).toBe('星期一')
    expect(ws['C3'].v).toBe('星期五')
    // 第1节：星期一=张三（姓名/电话换行），星期五=示例学生A
    const at = (r: number, c: number) => ws[XLSX.utils.encode_cell({ r, c })].v
    expect(at(3, 1)).toBe('张三\n13800000001')
    expect(at(3, 2)).toBe('示例学生A\n13800000002')
    // 第2节：星期一=示例学生A，星期五无人
    expect(at(4, 1)).toBe('示例学生A\n13800000002')
    expect(at(4, 2)).toBe('—')
  })

  it('排班表行标题标注每节上课时间（上午 1~4 节 / 下午 6~9 节）', () => {
    const ws = workbook({ rules: fullRules, rows: [] }).Sheets['排班表']
    const labels: string[] = []
    for (let r = 3; r < 3 + 8; r++) labels.push(String(ws[XLSX.utils.encode_cell({ r, c: 0 })].v))
    expect(labels).toEqual([
      '上午 第1节 8:00~8:45',
      '上午 第2节 8:50~9:35',
      '上午 第3节 9:55~10:40',
      '上午 第4节 10:45~11:30',
      '下午 第6节 14:00~14:45',
      '下午 第7节 14:50~15:35',
      '下午 第8节 15:40~16:25',
      '下午 第9节 16:45~17:30',
    ])
  })

  it('姓名与电话为上下两行：单元格内是换行符，且样式开启自动换行', () => {
    const ws = workbook().Sheets['排班表']
    const cell = ws['B4']
    expect(cell.v).toBe('张三\n13800000001')
    expect(cell.s?.alignment?.wrapText).toBe(true)
    expect(cell.s?.alignment?.vertical).toBe('center')
  })

  it('真实产物字节：xl/styles.xml 确实写入了 wrapText（社区版 SheetJS 做不到）', () => {
    const buf = XLSX.write(workbook(), { type: 'array', bookType: 'xlsx' })
    const styles = readZipEntry(buf, 'xl/styles.xml')
    expect(styles).toContain('wrapText="true"')
    expect(styles).toContain('<cellXfs')
    // 单元格必须引用到带 alignment 的样式索引，否则换行不会生效
    const sheet = readZipEntry(buf, 'xl/worksheets/sheet1.xml')
    expect(sheet).toMatch(/<c r="B4" s="\d+"/)
  })

  it('同一时段多人：含电话时按行堆叠，不含电话时用顿号并列', () => {
    const twoRows = [
      { dayOfWeek: 1, timeSlot: 'c1', assistantId: 1 },
      { dayOfWeek: 1, timeSlot: 'c1', assistantId: 2 },
    ]
    const withPhone = workbook({ rows: twoRows, includePhone: true }).Sheets['排班表']['B4'].v
    expect(withPhone).toBe('张三\n13800000001\n示例学生A\n13800000002')
    const withoutPhone = workbook({ rows: twoRows, includePhone: false }).Sheets['排班表']['B4'].v
    expect(withoutPhone).toBe('张三、示例学生A')
  })

  it('未登记电话的助理：只显示姓名，不产生空行', () => {
    const ws = workbook({ phoneById: new Map([[2, '13800000002']]) }).Sheets['排班表']
    expect(ws['B4'].v).toBe('张三')
    expect(ws['C4'].v).toBe('示例学生A\n13800000002')
  })

  it('标题行有合并单元格（横跨全部列）', () => {
    const ws = workbook().Sheets['排班表']
    expect(ws['!merges']).toHaveLength(2)
    expect(ws['!merges'][0].e.c).toBe(2) // 3 列（时段+2 天）
  })

  it('值班明细 Sheet：节次带上课时间、逐条含电话（仅此一项个人信息）', () => {
    const ws = readBack().Sheets['值班明细']
    expect(ws['A1'].v).toBe('周次')
    // 表头只有 5 列：周次/星期/节次/姓名/电话
    expect(Object.keys(ws).filter((k) => /^[A-Z]+1$/.test(k))).toEqual(['A1', 'B1', 'C1', 'D1', 'E1'])
    expect(ws['E1'].v).toBe('电话')
    // 数据按 星期/节次/助理 排序：d1c1 张三 → d1c2 示例学生A → d5c1 示例学生A
    expect(ws['C2'].v).toBe('第1节 8:00~8:45')
    expect(ws['D2'].v).toBe('张三')
    expect(ws['E2'].v).toBe('13800000001')
    expect(ws['D3'].v).toBe('示例学生A')
    expect(ws['E3'].v).toBe('13800000002')
    expect(ws['A4'].v).toBe(3)
  })

  it('导出的文件中不得出现学号或 QQ 等任何其他个人信息', () => {
    // 学号 1001/1002 与 QQ 111/222 都是"其他个人信息"，一律不得写入文件
    const texts = allCellTexts(readBack())
    for (const forbidden of ['1001', '1002', '111', '222']) {
      expect(texts.some((t) => t.includes(forbidden))).toBe(false)
    }
    // 电话必须存在（默认自动填充）
    expect(texts.some((t) => t.includes('13800000001'))).toBe(true)
  })

  it('文件名格式：排班表-第N周-YYYYMMDD.xlsx', () => {
    expect(scheduleFileName(3, new Date(2026, 8, 11))).toBe('排班表-第3周-20260911.xlsx')
  })

  it('exportScheduleFile 不抛错（真实写出路径）', () => {
    expect(() => exportScheduleFile(input, 'test-export.xlsx')).not.toThrow()
  })


  it('回归：写入排班后调整上班节次，已排数据在导出表中仍然可见', () => {
    // 缺陷：导出网格的节次行此前完全由"当前规则"推导，管理员改完上班节次直接导出，
    // 已写入的数据会整体"隐身"（所有格子显示 —），交出去的是一张空表。
    const changedRules: SchedulingRules = {
      ...rules,
      workSections: [{ start: 6, end: 9, label: '下午' }], // 与写入时（上午 1~2 节）不同
    }
    const ws = readBack({ rules: changedRules }).Sheets['排班表']
    const texts: string[] = []
    for (const addr of Object.keys(ws)) {
      if (addr.startsWith('!')) continue
      texts.push(String(ws[addr].v))
    }
    // 已写入的 c1/c2 排班必须仍出现在表中（行标签为数据独有的节次，无时间标注）
    expect(texts).toContain('张三\n13800000001')
    expect(texts).toContain('示例学生A\n13800000002')
    expect(texts.some((t) => t.includes('第1节 8:00~8:45'))).toBe(true)
  })

  it('关闭含电话：仅排班表网格、只显示姓名，且不留任何联系方式', () => {
    const wb = readBack({ includePhone: false })
    expect(wb.SheetNames).toEqual(['排班表'])
    // 网格中的值班人姓名仍然可见
    expect(wb.Sheets['排班表'][XLSX.utils.encode_cell({ r: 3, c: 1 })].v).toBe('张三')
    expect(allCellTexts(wb).some((t) => t.includes('138'))).toBe(false)
  })
})

describe('isAssistantFree（导出/校验共用的占用判定）', () => {
  const courses: Parameters<typeof isAssistantFree>[0] = [
    { assistantId: 1, kind: 'theory', dayOfWeek: 1, sectionText: '第一节-第二节', weekRanges: [[1, 17]] },
    { assistantId: 1, kind: 'experiment', dayOfWeek: 2, sectionText: '第一节-第二节', weekRanges: [[10, 17]] },
  ]

  it('有课则不空闲', () => {
    expect(isAssistantFree(courses, 1, 1, 1, 1, true, true)).toBe(false)
  })

  it('周次不覆盖 → 空闲', () => {
    expect(isAssistantFree(courses, 1, 1, 2, 1, true, true)).toBe(true) // 实验课 10 周才开始
    expect(isAssistantFree(courses, 1, 2, 1, 6, true, true)).toBe(true) // 理论课只占第1~2节，第6节空闲
  })

  it('类别过滤：关闭实验课 → 实验课不再挡人', () => {
    expect(isAssistantFree(courses, 1, 12, 2, 1, true, true)).toBe(false) // 开启：12 周实验课挡人
    expect(isAssistantFree(courses, 1, 12, 2, 1, true, false)).toBe(true) // 关闭：不挡
  })

  it('节次不重叠 → 空闲', () => {
    expect(isAssistantFree(courses, 1, 1, 3, 3, true, true)).toBe(true)
  })
})

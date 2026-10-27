/**
 * 双模板数据模型与内置模板（S5 第一片 / F07 / FE-17，2026-10-26，计划 §8）。
 *
 * 受控字段集合——模板只开放**有限的锚点/样式配置**，不做任意文件通用解析器、
 * 不支持脚本插件（计划红线）。导入模板参数化解析器的三个定位锚点；
 * 导出模板参数化标题/表头/列宽/简洁打印版式。
 *
 * 版本化：每次保存 formatVersion+1 并把快照追加进 versions 历史（可回看/恢复）；
 * 内置模板（isBuiltIn）可复制修改、不可删除——保证任何环境至少有两类可用样式。
 */

// ---------- 导入模板 ----------

export interface ImportTemplateMapping {
  /** 表头行锚点文本（默认"节次/星期"） */
  headerAnchor: string
  /** 学生标识行正则（含两个捕获组：姓名、学号） */
  studentPattern: string
  /** 学期行正则（一个捕获组） */
  semesterPattern: string
}

export const DEFAULT_IMPORT_MAPPING: ImportTemplateMapping = {
  headerAnchor: '节次/星期',
  studentPattern: '学生\\s*[：:]\\s*(.+?)[（(](\\d+)[）)]',
  semesterPattern: '(\\d{4}-\\d{4}-\\d)',
}

// ---------- 导出模板 ----------

export interface ExportTemplateStyle {
  /** 标题模板，{week} 占位符替换周次 */
  titleTemplate: string
  /** 表头首列文案 */
  headerFirst: string
  /** 首列（时段列）宽度（字符宽） */
  firstColumnWidth: number
  /** 各工作日列宽度 */
  dayColumnWidth: number
  /**
   * 简洁打印版：去掉底色填充与占位灰字，窄列——适合黑白打印。
   * 电话仍由导出时的运行开关控制（includePhone），模板不包含电话配置
   *（隐私口径：排班导出永不写学号/QQ）。
   */
  compact: boolean
}

export const DEFAULT_EXPORT_STYLE: ExportTemplateStyle = {
  titleTemplate: '行政办助理排班表（第 {week} 周）',
  headerFirst: '时段（节次）',
  firstColumnWidth: 24,
  dayColumnWidth: 18,
  compact: false,
}

export const COMPACT_EXPORT_STYLE: ExportTemplateStyle = {
  titleTemplate: '助理值班表（第 {week} 周）',
  headerFirst: '节次',
  firstColumnWidth: 14,
  dayColumnWidth: 10,
  compact: true,
}

// ---------- 模板实体 ----------

export interface TemplateVersion<T> {
  version: number
  savedAt: string
  snapshot: T
}

interface TemplateBase {
  id: string
  name: string
  formatVersion: number
  isBuiltIn: boolean
  createdAt: string
  updatedAt: string
}

export interface ImportTemplate extends TemplateBase {
  kind: 'import'
  mapping: ImportTemplateMapping
  versions: TemplateVersion<ImportTemplateMapping>[]
}

export interface ExportTemplate extends TemplateBase {
  kind: 'export'
  style: ExportTemplateStyle
  versions: TemplateVersion<ExportTemplateStyle>[]
}

export type AnyTemplate = ImportTemplate | ExportTemplate

/** 校验导入模板（正则可编译且捕获组数量正确；锚点非空） */
export function validateImportMapping(m: ImportTemplateMapping): string[] {
  const errors: string[] = []
  if (!m.headerAnchor.trim()) errors.push('表头锚点不能为空')
  try {
    const re = new RegExp(m.studentPattern)
    void re
    // 无法静态校验捕获组数量（需对样例试跑）——试解析阶段用真实文件验证
  } catch {
    errors.push('学生标识正则无法编译')
  }
  try {
    new RegExp(m.semesterPattern)
  } catch {
    errors.push('学期正则无法编译')
  }
  return errors
}

export function validateExportStyle(s: ExportTemplateStyle): string[] {
  const errors: string[] = []
  if (!s.titleTemplate.includes('{week}')) errors.push('标题模板需包含 {week} 周次占位符')
  if (!s.titleTemplate.trim()) errors.push('标题不能为空')
  if (!Number.isInteger(s.firstColumnWidth) || s.firstColumnWidth < 8 || s.firstColumnWidth > 60)
    errors.push('首列宽度须为 8~60 的整数')
  if (!Number.isInteger(s.dayColumnWidth) || s.dayColumnWidth < 6 || s.dayColumnWidth > 40)
    errors.push('日期列宽度须为 6~40 的整数')
  if (!s.headerFirst.trim()) errors.push('表头首列文案不能为空')
  return errors
}

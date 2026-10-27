/**
 * 模板服务（S5 第一片 / FE-17，2026-10-26）：双模板的持久化、版本化、
 * 启用切换与试解析。模板存于 config 表 key='templates'（非业务数据，
 * 不递增 dataRevision）；当前启用的导入/导出模板 id 存于同结构的 active 字段。
 */
import { db } from '../db/database'
import { now } from '../db/repositories'
import { parseTimetableWorkbook } from '../utils/courseParser'
import {
  COMPACT_EXPORT_STYLE,
  DEFAULT_EXPORT_STYLE,
  DEFAULT_IMPORT_MAPPING,
  validateExportStyle,
  validateImportMapping,
  type AnyTemplate,
  type ExportTemplate,
  type ImportTemplate,
  type ImportTemplateMapping,
  type ExportTemplateStyle,
} from './types'

interface TemplateStore {
  imports: ImportTemplate[]
  exports: ExportTemplate[]
  activeImportId: string
  activeExportId: string
}

const TEMPLATE_KEY = 'templates'

const BUILTIN_IMPORT_ID = 'builtin-import-college'
const BUILTIN_EXPORT_ID = 'builtin-export-college'
const BUILTIN_EXPORT_COMPACT_ID = 'builtin-export-compact'

function builtinTemplates(): TemplateStore {
  const ts = now()
  return {
    imports: [
      {
        id: BUILTIN_IMPORT_ID,
        kind: 'import',
        name: '学院标准课程表（内置）',
        formatVersion: 1,
        isBuiltIn: true,
        createdAt: ts,
        updatedAt: ts,
        mapping: { ...DEFAULT_IMPORT_MAPPING },
        versions: [{ version: 1, savedAt: ts, snapshot: { ...DEFAULT_IMPORT_MAPPING } }],
      },
    ],
    exports: [
      {
        id: BUILTIN_EXPORT_ID,
        kind: 'export',
        name: '学院默认版（内置）',
        formatVersion: 1,
        isBuiltIn: true,
        createdAt: ts,
        updatedAt: ts,
        style: { ...DEFAULT_EXPORT_STYLE },
        versions: [{ version: 1, savedAt: ts, snapshot: { ...DEFAULT_EXPORT_STYLE } }],
      },
      {
        id: BUILTIN_EXPORT_COMPACT_ID,
        kind: 'export',
        name: '简洁打印版（内置）',
        formatVersion: 1,
        isBuiltIn: true,
        createdAt: ts,
        updatedAt: ts,
        style: { ...COMPACT_EXPORT_STYLE },
        versions: [{ version: 1, savedAt: ts, snapshot: { ...COMPACT_EXPORT_STYLE } }],
      },
    ],
    activeImportId: BUILTIN_IMPORT_ID,
    activeExportId: BUILTIN_EXPORT_ID,
  }
}

/** 读取（内置模板每次按代码内置值重建——升级程序即更新内置定义） */
export async function loadTemplateStore(): Promise<TemplateStore> {
  const entry = await db.config.get(TEMPLATE_KEY)
  const saved = entry?.value as Partial<TemplateStore> | undefined
  const base = builtinTemplates()
  if (!saved) return base
  const merged: TemplateStore = {
    imports: [...base.imports, ...(saved.imports ?? [])],
    exports: [...base.exports, ...(saved.exports ?? [])],
    activeImportId: saved.activeImportId ?? base.activeImportId,
    activeExportId: saved.activeExportId ?? base.activeExportId,
  }
  // 启用 id 指向不存在的模板 → 回退内置
  if (!merged.imports.some((t) => t.id === merged.activeImportId)) merged.activeImportId = base.activeImportId
  if (!merged.exports.some((t) => t.id === merged.activeExportId)) merged.activeExportId = base.activeExportId
  return merged
}

async function saveStore(store: TemplateStore): Promise<void> {
  await db.config.put({ key: TEMPLATE_KEY, value: store })
}

/** 当前启用的导入模板（缺省回退内置） */
export async function getActiveImportTemplate(): Promise<ImportTemplate> {
  const s = await loadTemplateStore()
  return s.imports.find((t) => t.id === s.activeImportId) ?? s.imports[0]
}

/** 当前启用的导出模板 */
export async function getActiveExportTemplate(): Promise<ExportTemplate> {
  const s = await loadTemplateStore()
  return s.exports.find((t) => t.id === s.activeExportId) ?? s.exports[0]
}

export async function setActiveTemplate(kind: 'import' | 'export', id: string): Promise<void> {
  const s = await loadTemplateStore()
  if (kind === 'import' && s.imports.some((t) => t.id === id)) s.activeImportId = id
  if (kind === 'export' && s.exports.some((t) => t.id === id)) s.activeExportId = id
  await saveStore(s)
}

/** 新建模板（复制给定来源或内置默认）；自定义模板可删除 */
export async function createTemplate(
  kind: 'import' | 'export',
  name: string,
  copyFromId?: string,
): Promise<string> {
  const s = await loadTemplateStore()
  const id = `${kind}-custom-${Date.now().toString(36)}`
  const ts = now()
  if (kind === 'import') {
    const src = s.imports.find((t) => t.id === copyFromId) ?? s.imports[0]
    s.imports.push({
      id,
      kind,
      name: name.trim() || `${src.name}（副本）`,
      formatVersion: 1,
      isBuiltIn: false,
      createdAt: ts,
      updatedAt: ts,
      mapping: { ...src.mapping },
      versions: [{ version: 1, savedAt: ts, snapshot: { ...src.mapping } }],
    })
  } else {
    const src = s.exports.find((t) => t.id === copyFromId) ?? s.exports[0]
    s.exports.push({
      id,
      kind,
      name: name.trim() || `${src.name}（副本）`,
      formatVersion: 1,
      isBuiltIn: false,
      createdAt: ts,
      updatedAt: ts,
      style: { ...src.style },
      versions: [{ version: 1, savedAt: ts, snapshot: { ...src.style } }],
    })
  }
  await saveStore(s)
  return id
}

/** 保存修改：内置模板不可改（提示复制）；自定义模板版本 +1 并入历史（上限 20 条） */
export async function saveTemplateChanges(
  id: string,
  patch: { name?: string; mapping?: ImportTemplateMapping; style?: ExportTemplateStyle },
): Promise<number> {
  const s = await loadTemplateStore()
  const list: AnyTemplate[] = [...s.imports, ...s.exports]
  const t = list.find((x) => x.id === id)
  if (!t) throw new Error('模板不存在')
  if (t.isBuiltIn) throw new Error('内置模板不可修改，请先复制为自定义模板')
  if (patch.mapping) {
    const errors = validateImportMapping(patch.mapping)
    if (errors.length > 0) throw new Error(errors.join('；'))
    ;(t as ImportTemplate).mapping = { ...patch.mapping }
  }
  if (patch.style) {
    const errors = validateExportStyle(patch.style)
    if (errors.length > 0) throw new Error(errors.join('；'))
    ;(t as ExportTemplate).style = { ...patch.style }
  }
  if (patch.name !== undefined) t.name = patch.name.trim() || t.name
  t.formatVersion += 1
  t.updatedAt = now()
  if (t.kind === 'import') {
    const imp = t as ImportTemplate
    imp.versions.push({ version: t.formatVersion, savedAt: t.updatedAt, snapshot: { ...imp.mapping } })
    if (imp.versions.length > 20) imp.versions.splice(0, imp.versions.length - 20)
  } else {
    const exp = t as ExportTemplate
    exp.versions.push({ version: t.formatVersion, savedAt: t.updatedAt, snapshot: { ...exp.style } })
    if (exp.versions.length > 20) exp.versions.splice(0, exp.versions.length - 20)
  }
  await saveStore(s)
  return t.formatVersion
}

/** 恢复历史版本（生成新版本而非改写历史——版本链可追溯） */
export async function restoreTemplateVersion(id: string, version: number): Promise<void> {
  const s = await loadTemplateStore()
  const t = [...s.imports, ...s.exports].find((x) => x.id === id)
  if (!t) throw new Error('模板不存在')
  if (t.isBuiltIn) throw new Error('内置模板无需恢复')
  const versions = t.kind === 'import' ? (t as ImportTemplate).versions : (t as ExportTemplate).versions
  const snap = versions.find((v) => v.version === version)
  if (!snap) throw new Error(`版本 v${version} 不存在`)
  if (t.kind === 'import') {
    await saveTemplateChanges(id, { mapping: snap.snapshot as ImportTemplateMapping })
  } else {
    await saveTemplateChanges(id, { style: snap.snapshot as ExportTemplateStyle })
  }
}

export async function deleteTemplate(id: string): Promise<void> {
  const s = await loadTemplateStore()
  const t = [...s.imports, ...s.exports].find((x) => x.id === id)
  if (!t) return
  if (t.isBuiltIn) throw new Error('内置模板不可删除')
  s.imports = s.imports.filter((x) => x.id !== id)
  s.exports = s.exports.filter((x) => x.id !== id)
  if (s.activeImportId === id) s.activeImportId = BUILTIN_IMPORT_ID
  if (s.activeExportId === id) s.activeExportId = BUILTIN_EXPORT_ID
  await saveStore(s)
}

// ---------- 试解析（FE-17：配置先试跑，不落库） ----------

export interface ImportTrialResult {
  ok: boolean
  studentName?: string
  studentNo?: string
  semester?: string
  courseCount: number
  /** 预览前几条课程（课程名/星期/节次/周次） */
  preview: Array<{ courseName: string; dayOfWeek: number; sectionText: string; weeks: string }>
  problems: string[]
}

/** 用指定模板的映射试解析文件——纯读取，不写任何库表 */
export async function trialImportTemplate(
  data: Uint8Array,
  mapping: ImportTemplateMapping,
): Promise<ImportTrialResult> {
  try {
    const result = parseTimetableWorkbook(data, mapping)
    return {
      ok: result.courses.length > 0,
      studentName: result.studentName || undefined,
      studentNo: result.studentNo || undefined,
      semester: result.semester || undefined,
      courseCount: result.courses.length,
      preview: result.courses.slice(0, 5).map((c) => ({
        courseName: c.courseName,
        dayOfWeek: c.dayOfWeek,
        sectionText: c.sectionText,
        weeks: c.weekRanges.map(([a, b]) => (a === b ? `${a}周` : `${a}-${b}周`)).join(','),
      })),
      problems: result.problems.map((p) => `${p.text}（${p.reason}）`),
    }
  } catch (e) {
    return {
      ok: false,
      courseCount: 0,
      preview: [],
      problems: [e instanceof Error ? e.message : '解析失败'],
    }
  }
}

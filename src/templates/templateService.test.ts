/**
 * 模板服务测试（S5 第一片 / F07 / FE-17，2026-10-26）。
 * 覆盖：内置模板齐备（两类导出版式）、自定义模板版本化与恢复、内置保护、
 * 启用切换与失效回退、试解析（真实样例，不落库）。
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import 'fake-indexeddb/auto'
import { db } from '../db/database'
import {
  createTemplate,
  deleteTemplate,
  getActiveExportTemplate,
  getActiveImportTemplate,
  loadTemplateStore,
  restoreTemplateVersion,
  saveTemplateChanges,
  setActiveTemplate,
  trialImportTemplate,
} from './templateService'
import { DEFAULT_IMPORT_MAPPING, validateExportStyle, validateImportMapping } from './types'

const here = dirname(fileURLToPath(import.meta.url))
const SAMPLE = resolve(here, '../../samples/示例学生A.xlsx')
const hasSample = existsSync(SAMPLE)
const d = hasSample ? describe : describe.skip

beforeEach(async () => {
  await db.delete()
  await db.open()
})

describe('内置与持久化', () => {
  it('默认即有两类导出版式（学院默认 + 简洁打印）与一个导入模板', async () => {
    const s = await loadTemplateStore()
    expect(s.imports).toHaveLength(1)
    expect(s.imports[0].isBuiltIn).toBe(true)
    expect(s.exports).toHaveLength(2)
    expect(s.exports.map((t) => t.style.compact).sort()).toEqual([false, true])
  })

  it('自定义模板保存即版本化；恢复历史版本生成新版本而非改写', async () => {
    const id = await createTemplate('export', '我的版式')
    const v1 = await saveTemplateChanges(id, { style: { titleTemplate: 'A（第 {week} 周）', headerFirst: '时段', firstColumnWidth: 20, dayColumnWidth: 12, compact: false } })
    expect(v1).toBe(2)
    const v2 = await saveTemplateChanges(id, { style: { titleTemplate: 'B（第 {week} 周）', headerFirst: '时段', firstColumnWidth: 20, dayColumnWidth: 12, compact: true } })
    expect(v2).toBe(3)
    // 恢复 v2 的配置（titleTemplate A）
    await restoreTemplateVersion(id, 2)
    const t = (await loadTemplateStore()).exports.find((x) => x.id === id)!
    expect(t.formatVersion).toBe(4)
    expect(t.style.titleTemplate).toBe('A（第 {week} 周）')
    expect(t.versions).toHaveLength(4) // 历史完整保留
  })

  it('内置模板不可修改/删除；自定义可删除且删除后启用回退内置', async () => {
    const s = await loadTemplateStore()
    await expect(saveTemplateChanges(s.exports[0].id, {})).rejects.toThrow('内置')
    await expect(deleteTemplate(s.exports[0].id)).rejects.toThrow('内置')

    const id = await createTemplate('import', '自定义锚点')
    await setActiveTemplate('import', id)
    expect((await getActiveImportTemplate()).id).toBe(id)
    await deleteTemplate(id)
    expect((await getActiveImportTemplate()).isBuiltIn).toBe(true) // 回退
  })

  it('启用 id 失效自动回退内置', async () => {
    const id = await createTemplate('export', '临时')
    await setActiveTemplate('export', id)
    await deleteTemplate(id)
    expect((await getActiveExportTemplate()).isBuiltIn).toBe(true)
  })
})

describe('受控字段校验', () => {
  it('导入：锚点空/正则非法被拒', () => {
    expect(validateImportMapping({ ...DEFAULT_IMPORT_MAPPING, headerAnchor: '' })).toHaveLength(1)
    expect(
      validateImportMapping({ ...DEFAULT_IMPORT_MAPPING, studentPattern: '学生[：' }),
    ).toHaveLength(1)
    expect(validateImportMapping(DEFAULT_IMPORT_MAPPING)).toEqual([])
  })
  it('导出：缺 {week} 占位/列宽越界被拒', () => {
    const ok = { titleTemplate: '第 {week} 周', headerFirst: '时段', firstColumnWidth: 20, dayColumnWidth: 12, compact: false }
    expect(validateExportStyle(ok)).toEqual([])
    expect(validateExportStyle({ ...ok, titleTemplate: '没有占位符' })).toHaveLength(1)
    expect(validateExportStyle({ ...ok, firstColumnWidth: 5 })).toHaveLength(1)
    expect(validateExportStyle({ ...ok, dayColumnWidth: 99 })).toHaveLength(1)
  })
})

d('试解析（真实脱敏样例，不落库）', () => {
  it('默认映射解析成功并给出预览；数据零写入', async () => {
    const before = await db.assistant.count()
    const r = await trialImportTemplate(new Uint8Array(readFileSync(SAMPLE)), DEFAULT_IMPORT_MAPPING)
    expect(r.ok).toBe(true)
    expect(r.studentNo).toBe('2026000001')
    expect(r.courseCount).toBeGreaterThan(0)
    expect(r.preview.length).toBeLessThanOrEqual(5)
    expect(await db.assistant.count()).toBe(before) // 不落库
  })
  it('错误锚点试解析失败但不抛异常（给出可读原因）', async () => {
    const r = await trialImportTemplate(new Uint8Array(readFileSync(SAMPLE)), {
      ...DEFAULT_IMPORT_MAPPING,
      headerAnchor: '不存在的锚点XYZ',
    })
    expect(r.ok).toBe(false)
    expect(r.problems.length).toBeGreaterThan(0)
  })
})

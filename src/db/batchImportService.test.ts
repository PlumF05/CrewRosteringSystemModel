/**
 * 批量导入服务测试（S2 / F05 / FE-05，2026-10-26）。
 *
 * 场景（计划 FE-05）：3 份合法 + 1 份损坏 + 1 份同内容重复 → 逐项结果正确；
 * 不同内容争同一学生 → 明确冲突、不按先后覆盖。
 * 合法文件使用仓库内脱敏样例（samples/），损坏文件用随机字节，
 * "同号不同内容"通过在合法文件字节尾追加一位构造（xlsx/zip 容忍尾随字节，
 * 摘要不同但归属同一学号）。
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import 'fake-indexeddb/auto'
import { db } from './database'
import { assistantRepo } from './repositories'
import { importTimetableBatch, BATCH_LIMITS } from './batchImportService'

const here = dirname(fileURLToPath(import.meta.url))
const SAMPLES_DIR = resolve(here, '../../samples')
const load = (f: string) => new Uint8Array(readFileSync(resolve(SAMPLES_DIR, f)))

const hasSamples = ['示例学生A.xlsx', '示例学生B.xlsx', '示例学生C.xlsx'].every((f) =>
  existsSync(resolve(SAMPLES_DIR, f)),
)
const d = hasSamples ? describe : describe.skip

beforeEach(async () => {
  await db.delete()
  await db.open()
})

d('FE-05：混合批次逐项结果', () => {
  it('3 合法 + 1 损坏 + 1 同内容重复：成功/失败/跳过各自正确', async () => {
    const a = load('示例学生A.xlsx')
    const results = await importTimetableBatch([
      { fileName: 'A.xlsx', data: a },
      { fileName: 'B.xlsx', data: load('示例学生B.xlsx') },
      { fileName: 'C.xlsx', data: load('示例学生C.xlsx') },
      { fileName: 'broken.xlsx', data: new Uint8Array([0x00, 0x01, 0x02, 0xff, 0xfe]) },
      { fileName: 'A-copy.xlsx', data: a }, // 同内容重复
    ])

    expect(results).toHaveLength(5)
    const byFile = Object.fromEntries(results.map((r) => [r.fileName, r]))
    expect(byFile['A.xlsx'].status).toBe('ok')
    expect(byFile['B.xlsx'].status).toBe('ok')
    expect(byFile['C.xlsx'].status).toBe('ok')
    expect(byFile['broken.xlsx'].status).toBe('failed')
    expect(byFile['broken.xlsx'].message).toContain('无法解析')
    expect(byFile['A-copy.xlsx'].status).toBe('skipped')
    expect(byFile['A-copy.xlsx'].message).toContain('A.xlsx')

    // 合法的 3 人已建档；损坏/重复文件没有产生额外档案
    expect(await assistantRepo.count()).toBe(3)
  })

  it('不同内容争同一学生 → 后者明确报冲突，不覆盖先到者', async () => {
    const a = load('示例学生A.xlsx')
    // 尾部追加一个字节：摘要不同（不是"同内容重复"），但仍可解析出同一学号
    const variant = new Uint8Array(a.length + 1)
    variant.set(a)
    variant[a.length] = 0x20

    const results = await importTimetableBatch([
      { fileName: 'A.xlsx', data: a },
      { fileName: 'A-variant.xlsx', data: variant },
    ])
    expect(results[0].status).toBe('ok')
    expect(results[1].status).toBe('failed')
    expect(results[1].message).toContain('同一学号')
    expect(results[1].message).toContain('A.xlsx')
    // 只有先到者一份档案
    expect(await assistantRepo.count()).toBe(1)
    const saved = await assistantRepo.findByStudentNo('2026000001')
    expect(saved).toBeTruthy()
  })

  it('逐项结果携带归属与课程数（可核对）', async () => {
    const results = await importTimetableBatch([{ fileName: 'B.xlsx', data: load('示例学生B.xlsx') }])
    expect(results[0].studentNo).toBe('2026000002')
    expect(results[0].courseCount).toBe(48)
    expect(results[0].action).toBe('created')
  })

  it('超限整批拒绝（不部分执行）', async () => {
    const files = Array.from({ length: BATCH_LIMITS.maxFiles + 1 }, (_, i) => ({
      fileName: `f${i}.xlsx`,
      data: new Uint8Array([1]),
    }))
    await expect(importTimetableBatch(files)).rejects.toThrow('最多')
    expect(await assistantRepo.count()).toBe(0)
  })
})

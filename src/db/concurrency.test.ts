/**
 * 双 Dexie 连接并发写测试（S3 第三片 / FE-11，2026-10-26）。
 *
 * 场景：两个独立连接（模拟两个窗口/两个 WebView）基于**同一旧版本**并发提交
 * "版本检查 + 业务写入 + 版本递增"事务——必须恰好一个成功，另一个 StaleDataError；
 * 无丢失更新（成功方的写入完整保留）。
 */
import { beforeEach, describe, expect, it } from 'vitest'
import 'fake-indexeddb/auto'
import { CrsmDatabase, db } from './database'
import { StaleDataError, getDataRevision, withDataRevision } from './dataRevision'

describe('FE-11：双连接并发，同一旧版本最多一个成功', () => {
  let db2: CrsmDatabase

  beforeEach(async () => {
    await db.delete()
    await db.open()
    db2 = new CrsmDatabase() // 同名库的第二条连接（模拟另一窗口）
    await db2.open()
  })

  it('并发提交：恰好一个成功，另一连接被拒且不丢更新', async () => {
    // 预置版本 1
    await withDataRevision(null, [db.config], async () => {})
    const expected = await getDataRevision()

    /** 连接 B 按同一协议提交（另一窗口的 withDataRevision 等价实现） */
    const connBWrite = db2.transaction('rw', [db2.config, db2.duty_schedule], async () => {
      const cur = ((await db2.config.get('dataRevision'))?.value as number | undefined) ?? 0
      if (expected !== cur) throw new StaleDataError(expected, cur)
      await db2.duty_schedule.add({
        weekNo: 1,
        dayOfWeek: 1,
        timeSlot: 'c1',
        assistantId: 2,
        status: 'normal',
        source: 'auto',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      })
      await db2.config.put({ key: 'dataRevision', value: cur + 1 })
    })
    /** 连接 A（主连接服务层）同时提交 */
    const connAWrite = withDataRevision(expected, [db.duty_schedule], async () => {
      await db.duty_schedule.add({
        weekNo: 1,
        dayOfWeek: 1,
        timeSlot: 'c2',
        assistantId: 1,
        status: 'normal',
        source: 'auto',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      })
    })

    const results = await Promise.allSettled([connAWrite, connBWrite])
    const rejected = results.filter((r) => r.status === 'rejected')
    const fulfilled = results.filter((r) => r.status === 'fulfilled')
    expect(fulfilled).toHaveLength(1)
    expect(rejected).toHaveLength(1)
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(StaleDataError)

    // 版本只前进一次；成功方的写入完整保留，失败方零写入（无丢失更新）
    expect(await getDataRevision()).toBe(expected + 1)
    const rows = await db.duty_schedule.toArray()
    expect(rows).toHaveLength(1)
  })

  it('串行场景：后提交者基于旧版本被拒（更常见的窗口交错）', async () => {
    await withDataRevision(null, [db.config], async () => {})
    const expected = await getDataRevision()
    await withDataRevision(expected, [db.config], async () => {}) // 另一窗口先保存
    await expect(withDataRevision(expected, [db.config], async () => {})).rejects.toBeInstanceOf(
      StaleDataError,
    )
  })
})

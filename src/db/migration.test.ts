import { beforeEach, describe, expect, it } from 'vitest'
import 'fake-indexeddb/auto'
import Dexie from 'dexie'
import { db } from './database'

/**
 * 数据库版本迁移测试（2026-09-13 新增）。
 *
 * 背景（实测缺陷）：v3 迁移要把排班时段的编号从"下午 8~11 节"对齐为课程表的"下午 6~9 节"。
 * 最初实现为逐行平移键（c8→c6、c9→c7、c10→c8、c11→c9），在真实库上直接失败：
 *
 *   ConstraintError: Unable to add key to index '[weekNo+dayOfWeek+timeSlot+assistantId]'
 *
 * 两个独立原因：
 *   ① 库中同时存在旧标签行与新标签行（历史中间态）时，平移会撞上复合唯一索引，
 *      整个升级事务回滚 → 数据库不可用（用户导入课程表时即报此错）；
 *   ② 键在两种编号下**语义不同**（c8 旧=下午第一节、新=下午第三节），逐行平移会把
 *      下午节次静默改错——即本次要修的缺陷类型本身。
 *
 * 因此 v3 改为"归档到 schedule_snapshot + 清空 duty_schedule"：不猜测、不撞键、
 * 数据有留痕，排班由"生成排班"按 (课程表, 规则) 重算。本文件锁定该行为。
 */

/** 升级前（version ≤ 2）的表结构 */
const OLD_STORES = {
  assistant: '++id, &studentNo, name, identity, className',
  course: '++id, assistantId, courseNo, courseName',
  duty_schedule:
    '++id, &[weekNo+dayOfWeek+timeSlot+assistantId], weekNo, dayOfWeek, timeSlot, assistantId, source',
  config: '&key',
  operation_log: '++id, operatedAt, action',
  schedule_snapshot: '++id, createdAt, label',
}

const row = (assistantId: number, timeSlot: string) => ({
  weekNo: 1,
  dayOfWeek: 1,
  timeSlot,
  assistantId,
  status: 'normal',
  source: 'auto',
  createdAt: '2026-09-13T00:00:00.000Z',
  updatedAt: '2026-09-13T00:00:00.000Z',
})

/** 用一个"只声明到 version 2"的库实例，模拟升级前的旧库 */
async function seedLegacyDb(seed: (legacy: Dexie) => Promise<void>) {
  const legacy = new Dexie('crsm')
  legacy.version(1).stores(OLD_STORES)
  legacy.version(2).stores(OLD_STORES)
  await legacy.open()
  await seed(legacy)
  legacy.close()
}

beforeEach(async () => {
  await db.close()
  await Dexie.delete('crsm')
})

describe('v3 迁移：排班时段编号对齐', () => {
  it('旧编号库：升级不抛错，旧排班归档进快照表后清空', async () => {
    await seedLegacyDb(async (l) => {
      await l.table('duty_schedule').bulkAdd([
        row(1, 'c1'),
        row(1, 'c8'),
        row(2, 'c10'),
        row(2, 'c11'),
      ])
    })

    await expect(db.open()).resolves.toBe(db)

    expect(await db.duty_schedule.count()).toBe(0)
    const snaps = await db.schedule_snapshot.toArray()
    expect(snaps).toHaveLength(1)
    expect(snaps[0].label).toContain('节次编号对齐')
    expect(snaps[0].data).toHaveLength(4)
    const log = (await db.operation_log.toArray()).find((l) => l.action === 'schedule.migrate')
    expect(log).toBeTruthy()
    expect((log!.detail as { archivedRows: number }).archivedRows).toBe(4)
  })

  it('混合中间态（旧标签 c8/c9 与新标签 c6/c7 并存）：不得抛 ConstraintError', async () => {
    // 这是用户实际遇到的情形：中间版本按新编号写过排班，随后 v3 又去平移旧编号行
    await seedLegacyDb(async (l) => {
      await l.table('duty_schedule').bulkAdd([
        row(1, 'c1'),
        row(1, 'c8'), // 旧标签：下午第一节
        row(1, 'c9'), // 旧标签：下午第二节
        row(1, 'c6'), // 新标签：下午第一节（同义重复）
        row(1, 'c7'), // 新标签：下午第二节（同义重复）
        row(2, 'c10'),
        row(2, 'c11'),
      ])
    })

    await expect(db.open()).resolves.toBe(db)
    expect(await db.duty_schedule.count()).toBe(0)
    expect((await db.schedule_snapshot.toArray())[0].data).toHaveLength(7)
  })

  it('无历史排班：不产生快照与日志（升级无副作用）', async () => {
    await seedLegacyDb(async () => {})
    await expect(db.open()).resolves.toBe(db)
    expect(await db.duty_schedule.count()).toBe(0)
    expect(await db.schedule_snapshot.count()).toBe(0)
    expect(await db.operation_log.count()).toBe(0)
  })

  it('升级只影响排班表：课程表、助理、配置、既有快照全部保留', async () => {
    await seedLegacyDb(async (l) => {
      await l.table('assistant').add({
        id: 1,
        studentNo: '1024001',
        name: '张三',
        identity: 'undergrad',
        createdAt: 'x',
        updatedAt: 'x',
      })
      await l.table('course').add({
        id: 1,
        assistantId: 1,
        courseNo: 'A',
        courseName: '课程甲',
        kind: 'theory',
        weekRanges: [[1, 4]],
        dayOfWeek: 1,
        sectionText: '第一节-第二节',
        sectionStart: 1,
        sectionEnd: 2,
      })
      await l.table('config').add({ key: 'rules', value: { weekStart: 1 } })
      await l.table('schedule_snapshot').add({ id: 1, createdAt: 'x', label: '历史快照', data: [] })
      await l.table('duty_schedule').add(row(1, 'c8'))
    })

    await db.open()
    expect(await db.assistant.count()).toBe(1)
    expect(await db.course.count()).toBe(1)
    expect((await db.config.get('rules'))?.value).toEqual({ weekStart: 1 })
    // 升级归档快照 + 原有历史快照
    expect(await db.schedule_snapshot.count()).toBe(2)
  })

  it('升级后可按新编号正常写入排班（c6~c9 不撞唯一索引）', async () => {
    await seedLegacyDb(async (l) => {
      await l.table('duty_schedule').add(row(1, 'c8'))
    })
    await db.open()

    await db.duty_schedule.bulkAdd(['c6', 'c7', 'c8', 'c9'].map((s) => ({ ...row(1, s) })))
    const keys = (await db.duty_schedule.toArray()).map((r) => r.timeSlot).sort()
    expect(keys).toEqual(['c6', 'c7', 'c8', 'c9'])
    // 同一 (周, 天, 时段, 助理) 重复仍应被唯一索引拦住
    await expect(db.duty_schedule.add({ ...row(1, 'c6') })).rejects.toThrow(/ConstraintError/i)
  })
})

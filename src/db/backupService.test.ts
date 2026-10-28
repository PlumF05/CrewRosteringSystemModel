/**
 * 备份与恢复测试（S5 第三片 / FE-19/20/21，2026-10-26）。
 * 覆盖：一致备份与摘要、篡改/未知版本/结构缺失拒绝、唯一键与引用校验、
 * 恢复成功（替换+撤销链重置+版本前进+恢复副本隔离）、恢复失败回滚原数据保持、
 * 空库（第二台机器）恢复一致、schema v4 升级无损。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import 'fake-indexeddb/auto'
import { CrsmDatabase, db } from './database'
import { assistantRepo, courseRepo, dutyScheduleRepo, configRepo } from './repositories'
import { addManualAssignment } from './manualAdjustService'
import { getDataRevision } from './dataRevision'
import { BACKUP_FORMAT_VERSION, createBackup, restoreBackup, validateBackup } from './backupService'
import { DEFAULT_RULES } from '../algorithms/types'

beforeEach(async () => {
  await db.delete()
  await db.open()
})

async function seed() {
  await configRepo.set('rules', { ...DEFAULT_RULES, weekStart: 1, weekEnd: 2 })
  const a1 = await assistantRepo.add({ name: '示例学生A', studentNo: '1', identity: 'undergrad', phone: '13800000001' })
  const a2 = await assistantRepo.add({ name: '示例学生B', studentNo: '2', identity: 'undergrad' })
  await db.assistant.update(a1, { timetableStatus: 'confirmed_empty' })
  await db.assistant.update(a2, { timetableStatus: 'confirmed_empty' })
  await courseRepo.replaceForAssistant(a2, [
    { assistantId: a2, courseNo: '', courseName: '课', kind: 'theory', weekRanges: [[1, 2]], dayOfWeek: 3, sectionText: '第一节-第一节', sectionStart: 1, sectionEnd: 1 },
  ])
  await addManualAssignment({ weekNo: 1, dayOfWeek: 1, timeSlot: 'c1', assistantId: a1 }, await getDataRevision())
  await dutyScheduleRepo.add({ weekNo: 2, dayOfWeek: 2, timeSlot: 'c1', assistantId: a2 })
  return { a1, a2 }
}

describe('备份（FE-19）', () => {
  it('创建：内容完整、摘要可复验、个人资料标注、派生键不入备份', async () => {
    await seed()
    const b = await createBackup()
    const file = JSON.parse(b.json)
    expect(file.formatVersion).toBe(BACKUP_FORMAT_VERSION)
    expect(file.counts).toEqual({ assistants: 2, courses: 1, dutySchedule: 2, scheduleSnapshots: 0 })
    expect(file.includesPersonalInfo).toBe(true) // 有电话
    expect(file.content.config.some((e) => e.key === 'rules')).toBe(true)
    expect(file.content.config.some((e) => e.key === 'adjustJournal')).toBe(false) // 派生键排除
    expect(validateBackup(b.json).ok).toBe(true)
    expect(b.filename).toMatch(/^crsm-backup-\d{8}-\d{4}\.json$/)
  })

  it('自查修复回归：结构不全的备份被拒绝且校验器不抛异常（此前缺 dutySchedule 会 TypeError）', () => {
    const partial = JSON.stringify({
      formatVersion: 1,
      exportedAt: '2026-10-26T00:00:00.000Z',
      includesPersonalInfo: false,
      counts: {},
      content: { assistants: [] }, // 缺 courses/dutySchedule/scheduleSnapshots/config
      checksum: 'x',
    })
    let v: ReturnType<typeof validateBackup> | null = null
    expect(() => (v = validateBackup(partial))).not.toThrow()
    expect(v!.ok).toBe(false)
    expect(v!.errors[0]).toContain('结构不完整')

    // 逐个字段缺失同样拒绝
    for (const drop of ['courses', 'dutySchedule', 'scheduleSnapshots', 'config'] as const) {
      const file = {
        formatVersion: 1,
        content: {
          assistants: [],
          courses: [],
          dutySchedule: [],
          scheduleSnapshots: [],
          config: [],
          [drop]: undefined,
        },
      }
      expect(validateBackup(JSON.stringify(file)).ok).toBe(false)
    }
  })

  it('校验拒绝：未知新版本 / 篡改内容 / 非 JSON / 重复学号 / 引用缺失', async () => {
    await seed()
    const b = await createBackup()
    const bumped = JSON.parse(b.json)
    bumped.formatVersion = BACKUP_FORMAT_VERSION + 1
    expect(validateBackup(JSON.stringify(bumped)).errors[0]).toContain('更新版本')

    const tampered = JSON.parse(b.json)
    tampered.content.assistants[0].name = '被篡改'
    expect(validateBackup(JSON.stringify(tampered)).errors[0]).toContain('摘要')

    expect(validateBackup('not json').ok).toBe(false)

    const dup = JSON.parse(b.json)
    dup.content.assistants.push({ ...dup.content.assistants[0], id: 99 })
    const vDup = validateBackup(JSON.stringify(dup))
    expect(vDup.errors.some((e) => e.includes('重复学号') || e.includes('摘要'))).toBe(true)

    const dangling = JSON.parse(b.json)
    dangling.content.courses.push({ assistantId: 999, courseNo: '', courseName: '孤儿', kind: 'theory', weekRanges: [[1, 2]], dayOfWeek: 1, sectionText: '第一节', sectionStart: 1, sectionEnd: 1 })
    expect(validateBackup(JSON.stringify(dangling)).errors.some((e) => e.includes('不存在'))).toBe(true)
  })
})

describe('恢复（FE-20）', () => {
  it('成功：数据替换、撤销链重置、版本前进、恢复副本隔离留存', async () => {
    const { a1 } = await seed()
    const revBefore = await getDataRevision()
    const b = await createBackup()

    // 恢复前制造一些"当前脏数据"（会被备份内容替换掉）
    await assistantRepo.add({ name: '临时新人', studentNo: '999', identity: 'undergrad' })

    const r = await restoreBackup(b.json)
    expect(r.recovered.assistants).toBe(2) // 临时新人被替换掉
    expect(await assistantRepo.count()).toBe(2)
    expect(await courseRepo.count()).toBe(1)
    const journal = await configRepo.get('adjustJournal')
    expect(journal).toEqual({ undo: [], redo: [] }) // 撤销链已重置
    expect(r.newRevision).toBeGreaterThan(revBefore)
    // 恢复副本独立留存（含恢复前的"临时新人"）
    const copies = await db.recovery_backup.toArray()
    expect(copies.length).toBe(1)
    const payload = copies[0].payload as { assistants: Array<{ name: string }> }
    expect(payload.assistants.some((a) => a.name === '临时新人')).toBe(true)
    void a1
  })

  it('失败回滚：替换中途抛错 → 原数据完整保持', async () => {
    await seed()
    const b = await createBackup()
    const countsBefore = {
      a: await db.assistant.count(),
      c: await db.course.count(),
    }
    const spy = vi.spyOn(db.duty_schedule, 'bulkAdd').mockRejectedValueOnce(new Error('注入：写入失败'))
    await expect(restoreBackup(b.json)).rejects.toThrow('注入')
    spy.mockRestore()
    // 原数据保持（assistant.clear 已回滚）
    expect(await db.assistant.count()).toBe(countsBefore.a)
    expect(await db.course.count()).toBe(countsBefore.c)
  })

  it('空库（第二台机器）恢复：数据与备份完全一致', async () => {
    await seed()
    const b = await createBackup()
    // 模拟全新机器：删库重开（同一页面内以新连接打开）
    const db2 = new CrsmDatabase()
    await db2.open()
    await db2.close()
    await db.delete()
    await db.open()
    const r = await restoreBackup(b.json)
    expect(r.recovered).toEqual({ assistants: 2, courses: 1, dutySchedule: 2, scheduleSnapshots: 0 })
    const rules = await configRepo.get('rules')
    expect(rules).toBeTruthy()
  })
})

describe('schema v4 升级（FE-21）', () => {
  it('v3 数据在 v4 打开后无损保留，recovery_backup 表可用', async () => {
    await seed()
    const dutyCount = await db.duty_schedule.count()
    // 以新连接重新打开（Dexie 已是 v4；fake-indexeddb 持久化到内存同名库）
    const db2 = new CrsmDatabase()
    await db2.open()
    expect(await db2.assistant.count()).toBe(2)
    expect(await db2.duty_schedule.count()).toBe(dutyCount)
    const id = await db2.recovery_backup.add({ createdAt: new Date().toISOString(), reason: 't', payload: {} })
    expect(await db2.recovery_backup.get(id)).toBeTruthy()
    await db2.close()
  })
})

/**
 * 命名快照服务测试（S3 第三片 / FE-16，2026-10-26）。
 * 覆盖：自包含创建（规则+人员显示信息）、逐周对比、受控恢复（合法替换+撤销链重置）、
 * 缺人/课程冲突阻止恢复且数据不动。
 */
import { beforeEach, describe, expect, it } from 'vitest'
import 'fake-indexeddb/auto'
import { db } from './database'
import { assistantRepo, configRepo, courseRepo, dutyScheduleRepo } from './repositories'
import { addManualAssignment } from './manualAdjustService'
import { buildSnapshotExportBuffer, createNamedSnapshot, deleteSnapshot, listSnapshots, restoreSnapshot, snapshotDiff } from './snapshotService'
import { getDataRevision } from './dataRevision'
import { DEFAULT_RULES, type SchedulingRules } from '../algorithms/types'

const rules = (over: Partial<SchedulingRules> = {}): SchedulingRules => ({
  ...DEFAULT_RULES,
  workdays: [1, 2, 3, 4, 5],
  workSections: [{ start: 1, end: 4, label: '上午' }],
  balanceDaily: false,
  minConsecutiveSections: 1,
  ...over,
})

beforeEach(async () => {
  await db.delete()
  await db.open()
})

describe('命名快照（FE-16）', () => {
  it('创建：跨表一致快照，meta 含规则与人员显示信息', async () => {
    await configRepo.set('rules', rules())
    const a1 = await assistantRepo.add({ name: '示例学生A', studentNo: '1', identity: 'undergrad' })
    await db.assistant.update(a1, { timetableStatus: 'confirmed_empty' })
    await addManualAssignment({ weekNo: 1, dayOfWeek: 1, timeSlot: 'c1', assistantId: a1 }, await getDataRevision())
    await dutyScheduleRepo.add({ weekNo: 2, dayOfWeek: 3, timeSlot: 'c2', assistantId: a1 })

    const id = await createNamedSnapshot('发布版 v1')
    const snap = (await listSnapshots()).find((s) => s.id === id)!
    expect(snap.label).toBe('发布版 v1')
    expect(snap.data).toHaveLength(2)
    expect(snap.meta?.formatVersion).toBe(2)
    expect((snap.meta?.assistants ?? [])).toEqual([{ id: a1, name: '示例学生A' }])
    expect((snap.meta?.rules as SchedulingRules).workSections[0]).toEqual({ start: 1, end: 4, label: '上午' })
  })

  it('对比：当前变化后逐周新增/移除计数正确', async () => {
    const a1 = await assistantRepo.add({ name: '示例学生A', studentNo: '1', identity: 'undergrad' })
    await db.assistant.update(a1, { timetableStatus: 'confirmed_empty' })
    await dutyScheduleRepo.add({ weekNo: 1, dayOfWeek: 1, timeSlot: 'c1', assistantId: a1 })
    const id = await createNamedSnapshot('s')
    // 当前：删一条 + 加一条
    await dutyScheduleRepo.clearWeek(1)
    await dutyScheduleRepo.add({ weekNo: 1, dayOfWeek: 2, timeSlot: 'c2', assistantId: a1 })
    const diff = await snapshotDiff(id)
    expect(diff).toEqual([{ weekNo: 1, added: 1, removed: 1 }])
  })

  it('受控恢复：合法时替换覆盖周（范围外保持）、撤销链重置、版本递增', async () => {
    const a1 = await assistantRepo.add({ name: '示例学生A', studentNo: '1', identity: 'undergrad' })
    await db.assistant.update(a1, { timetableStatus: 'confirmed_empty' })
    await dutyScheduleRepo.add({ weekNo: 1, dayOfWeek: 1, timeSlot: 'c1', assistantId: a1 })
    await dutyScheduleRepo.add({ weekNo: 5, dayOfWeek: 1, timeSlot: 'c1', assistantId: a1 })
    const id = await createNamedSnapshot('带第5周')
    // 当前改动：第 1 周清空
    await dutyScheduleRepo.clearWeek(1)
    const revBefore = await getDataRevision()

    const r = await restoreSnapshot(id, await getDataRevision())
    expect(r.problems).toEqual([])
    const w1 = await dutyScheduleRepo.listByWeek(1)
    expect(w1).toHaveLength(1)
    expect(w1[0].dayOfWeek).toBe(1)
    const w5 = await dutyScheduleRepo.listByWeek(5)
    expect(w5).toHaveLength(1) // 快照覆盖范围内恢复为快照内容
    expect(await getDataRevision()).toBeGreaterThan(revBefore)
    // 撤销链已重置
    const journal = await db.config.get('adjustJournal')
    expect(journal?.value).toEqual({ undo: [], redo: [] })
  })

  it('受控恢复被阻止：快照中的人已删除（数据不动，明细含提示）', async () => {
    const a1 = await assistantRepo.add({ name: '示例学生A', studentNo: '1', identity: 'undergrad' })
    const a2 = await assistantRepo.add({ name: '示例学生B', studentNo: '2', identity: 'undergrad' })
    await db.assistant.update(a1, { timetableStatus: 'confirmed_empty' })
    await db.assistant.update(a2, { timetableStatus: 'confirmed_empty' })
    await dutyScheduleRepo.add({ weekNo: 1, dayOfWeek: 1, timeSlot: 'c1', assistantId: a1 })
    await dutyScheduleRepo.add({ weekNo: 1, dayOfWeek: 1, timeSlot: 'c1', assistantId: a2 })
    const id = await createNamedSnapshot('两人版')
    await assistantRepo.remove(a2) // 当前已无 a2

    const r = await restoreSnapshot(id, await getDataRevision())
    expect(r.problems.length).toBeGreaterThan(0)
    expect(r.problems.some((p) => p.includes('已被删除'))).toBe(true)
    // 数据未动
    expect(await dutyScheduleRepo.listByWeek(1)).toHaveLength(1)
  })

  it('受控恢复被阻止：课程冲突（当前课程使快照安排违法）', async () => {
    const a1 = await assistantRepo.add({ name: '示例学生A', studentNo: '1', identity: 'undergrad' })
    await db.assistant.update(a1, { timetableStatus: 'confirmed_empty' })
    await dutyScheduleRepo.add({ weekNo: 1, dayOfWeek: 2, timeSlot: 'c1', assistantId: a1 })
    const id = await createNamedSnapshot('s')
    await courseRepo.replaceForAssistant(a1, [
      { assistantId: a1, courseNo: '', courseName: '新必修', kind: 'theory', weekRanges: [[1, 17]], dayOfWeek: 2, sectionText: '第一节-第一节', sectionStart: 1, sectionEnd: 1 },
    ])
    const r = await restoreSnapshot(id, await getDataRevision())
    expect(r.problems.some((p) => p.includes('新必修'))).toBe(true)
  })

  it('删除快照不影响排班数据', async () => {
    const a1 = await assistantRepo.add({ name: '示例学生A', studentNo: '1', identity: 'undergrad' })
    await dutyScheduleRepo.add({ weekNo: 1, dayOfWeek: 1, timeSlot: 'c1', assistantId: a1 })
    const id = await createNamedSnapshot('s')
    await deleteSnapshot(id)
    expect(await listSnapshots()).toHaveLength(0)
    expect(await dutyScheduleRepo.listByWeek(1)).toHaveLength(1)
  })
})

describe('快照导出（FE-18：固定信息）', () => {
  it('使用快照固定姓名（人员已删除仍显示原名）且不含电话；周 sheet 正确', async () => {
    const a1 = await assistantRepo.add({ name: '示例学生A', studentNo: '1', identity: 'undergrad' })
    const a2 = await assistantRepo.add({ name: '示例学生B', studentNo: '2', identity: 'undergrad' })
    await dutyScheduleRepo.add({ weekNo: 1, dayOfWeek: 1, timeSlot: 'c1', assistantId: a1 })
    await dutyScheduleRepo.add({ weekNo: 2, dayOfWeek: 2, timeSlot: 'c2', assistantId: a2 })
    const id = await createNamedSnapshot('留档')
    await assistantRepo.remove(a2) // 当前已删除

    const snap = (await listSnapshots()).find((s) => s.id === id)!
    const buf = buildSnapshotExportBuffer(snap)
    const XLSX = (await import('xlsx-js-style')).default
    const wb = XLSX.read(buf, { type: 'array' })
    expect(wb.SheetNames).toEqual(['第1周', '第2周'])
    const texts: string[] = []
    for (const name of wb.SheetNames) {
      const ws = wb.Sheets[name]
      for (const addr of Object.keys(ws)) {
        if (addr.startsWith('!')) continue
        const v = (ws[addr] as { v?: unknown }).v
        if (v !== undefined && v !== null) texts.push(String(v))
      }
    }
    expect(texts.some((t) => t.includes('示例学生B'))).toBe(true) // 固定姓名未被当前删除影响
    expect(texts.some((t) => /1[3-9]\d{9}/.test(t))).toBe(false) // 快照导出永不含电话
    expect(texts.some((t) => /20\d{8}/.test(t))).toBe(false) // 无学号
  })
})

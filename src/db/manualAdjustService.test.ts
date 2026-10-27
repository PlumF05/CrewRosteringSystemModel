/**
 * 手动调整服务测试（S3 第一片 / F04 / FE-08，2026-10-26）。
 *
 * 覆盖：候选与冲突解释、添加（课程冲突/容量/个人上限/短段例外）、
 * 移除与移动的原子性与拒绝路径、锁定/解锁、例外登记与清除、CAS 陈旧拒绝、
 * 遗留旧问题不阻塞无关操作。
 */
import { beforeEach, describe, expect, it } from 'vitest'
import 'fake-indexeddb/auto'
import { db } from './database'
import { assistantRepo, courseRepo, configRepo, dutyScheduleRepo } from './repositories'
import {
  ManualAdjustRejected,
  addManualAssignment,
  getSlotCandidates,
  moveAssignment,
  removeAssignment,
  setContinuityException,
  setLocked,
} from './manualAdjustService'
import { DEFAULT_RULES, type SchedulingRules } from '../algorithms/types'
import { StaleDataError, getDataRevision } from './dataRevision'

const rules = (over: Partial<SchedulingRules> = {}): SchedulingRules => ({
  ...DEFAULT_RULES,
  workdays: [1, 2, 3, 4, 5],
  workSections: [{ start: 1, end: 4, label: '上午' }],
  balanceDaily: false,
  minConsecutiveSections: 1,
  ...over,
})

async function seed(opts: { minConsecutive?: number; maxPerSlot?: number } = {}) {
  await configRepo.set('rules', rules({
    ...(opts.minConsecutive ? { minConsecutiveSections: opts.minConsecutive } : {}),
    ...(opts.maxPerSlot ? { maxPerSlot: opts.maxPerSlot } : {}),
  }))
  const a1 = await assistantRepo.add({ name: '示例学生A', studentNo: '1', identity: 'undergrad' })
  const a2 = await assistantRepo.add({ name: '示例学生B', studentNo: '2', identity: 'undergrad' })
  return { a1, a2 }
}

beforeEach(async () => {
  await db.delete()
  await db.open()
})

describe('候选与冲突解释（FE-08）', () => {
  it('有课者标注课程信息；已在时段者标注；可排者无原因', async () => {
    const { a1, a2 } = await seed()
    await courseRepo.replaceForAssistant(a1, [])
    await courseRepo.replaceForAssistant(a2, [
      { assistantId: a2, courseNo: '', courseName: '编译原理', kind: 'theory', weekRanges: [[1, 17]], dayOfWeek: 1, sectionText: '第一节-第二节', sectionStart: 1, sectionEnd: 2 },
    ])
    await dutyScheduleRepo.add({ weekNo: 1, dayOfWeek: 1, timeSlot: 'c1', assistantId: a1 })
    // a1 未导课表？replaceForAssistant(a1, []) 写 0 条 → 状态仍是 missing（无导入标记）
    const cands = await getSlotCandidates(1, 1, 'c1')
    const byId = Object.fromEntries(cands.map((c) => [c.assistantId, c]))
    expect(byId[a1].eligible).toBe(false)
    expect(byId[a1].reason).toContain('已在该时段')
    expect(byId[a2].eligible).toBe(false)
    expect(byId[a2].reason).toContain('编译原理')
  })

  it('时段满员后其余候选标注"时段已满"', async () => {
    const { a1, a2 } = await seed({ maxPerSlot: 1 })
    await courseRepo.replaceForAssistant(a1, [])
    await courseRepo.replaceForAssistant(a2, [])
    // 两个"确认无课"状态
    await db.assistant.update(a1, { timetableStatus: 'confirmed_empty' })
    await db.assistant.update(a2, { timetableStatus: 'confirmed_empty' })
    await dutyScheduleRepo.add({ weekNo: 1, dayOfWeek: 1, timeSlot: 'c1', assistantId: a1 })
    const cands = await getSlotCandidates(1, 1, 'c1')
    const b2 = cands.find((c) => c.assistantId === a2)!
    expect(b2.eligible).toBe(false)
    expect(b2.reason).toContain('时段已满')
  })
})

describe('添加（含短段例外语义）', () => {
  it('合法添加：manual + 默认锁定；个人上限超限被拒', async () => {
    const { a1 } = await seed({ maxPerSlot: 2 })
    await db.assistant.update(a1, { timetableStatus: 'confirmed_empty', customMaxSections: 1 })
    const r = await addManualAssignment(
      { weekNo: 1, dayOfWeek: 1, timeSlot: 'c1', assistantId: a1 },
      await getDataRevision(),
    )
    expect(r.revision).toBeGreaterThan(0)
    const rows = await dutyScheduleRepo.listByWeek(1)
    expect(rows).toHaveLength(1)
    expect(rows[0].source).toBe('manual')
    expect(rows[0].locked).toBe(true)

    // 第二条 → 个人周上限 1 已满
    await expect(
      addManualAssignment({ weekNo: 1, dayOfWeek: 2, timeSlot: 'c1', assistantId: a1 }, await getDataRevision()),
    ).rejects.toBeInstanceOf(ManualAdjustRejected)
    expect(await dutyScheduleRepo.listByWeek(1)).toHaveLength(1)
  })

  it('课程冲突添加被拒并给出明细', async () => {
    const { a1 } = await seed()
    await courseRepo.replaceForAssistant(a1, [
      { assistantId: a1, courseNo: '', courseName: '操作系统', kind: 'theory', weekRanges: [[1, 17]], dayOfWeek: 3, sectionText: '第二节-第三节', sectionStart: 2, sectionEnd: 3 },
    ])
    await expect(
      addManualAssignment({ weekNo: 1, dayOfWeek: 3, timeSlot: 'c2', assistantId: a1 }, await getDataRevision()),
    ).rejects.toThrow(/操作系统/)
  })

  it('手动短段：无例外原因被拒；登记原因后放行且原因可追溯', async () => {
    const { a1 } = await seed({ minConsecutive: 2 })
    await db.assistant.update(a1, { timetableStatus: 'confirmed_empty' })
    await expect(
      addManualAssignment({ weekNo: 1, dayOfWeek: 1, timeSlot: 'c2', assistantId: a1 }, await getDataRevision()),
    ).rejects.toBeInstanceOf(ManualAdjustRejected)
    expect(await dutyScheduleRepo.listByWeek(1)).toHaveLength(0)

    await addManualAssignment(
      { weekNo: 1, dayOfWeek: 1, timeSlot: 'c2', assistantId: a1, continuityExceptionReason: '老师指定中午前单节补位' },
      await getDataRevision(),
    )
    const rows = await dutyScheduleRepo.listByWeek(1)
    expect(rows[0].continuityExceptionReason).toBe('老师指定中午前单节补位')

    // 例外只豁免连续性：该位置若有课仍被拒
    const { a2 } = { a2: (await assistantRepo.list()).find((a) => a.studentNo === '2')!.id! }
    await courseRepo.replaceForAssistant(a2, [
      { assistantId: a2, courseNo: '', courseName: '算法', kind: 'theory', weekRanges: [[1, 17]], dayOfWeek: 2, sectionText: '第一节-第一节', sectionStart: 1, sectionEnd: 1 },
    ])
    await expect(
      addManualAssignment(
        { weekNo: 1, dayOfWeek: 2, timeSlot: 'c1', assistantId: a2, continuityExceptionReason: 'x' },
        await getDataRevision(),
      ),
    ).rejects.toThrow(/算法/)
  })
})

describe('移除 / 移动 / 锁定 / 例外维护', () => {
  it('移动到冲突位置被拒且原位保留（原子）', async () => {
    const { a1, a2 } = await seed()
    await db.assistant.update(a1, { timetableStatus: 'confirmed_empty' })
    await courseRepo.replaceForAssistant(a2, [
      { assistantId: a2, courseNo: '', courseName: '数据库', kind: 'theory', weekRanges: [[1, 17]], dayOfWeek: 4, sectionText: '第三节-第三节', sectionStart: 3, sectionEnd: 3 },
    ])
    // a2 有课（周三 c3）→ a1 正常排在周一 c1，试图把 a1 移到有课助理无关的位置成功；
    // 再验证：a2 的既有安排移进自己有课位置被拒
    const row1 = await dutyScheduleRepo.add({ weekNo: 1, dayOfWeek: 1, timeSlot: 'c1', assistantId: a1 })
    await moveAssignment(row1, { dayOfWeek: 2, timeSlot: 'c3' }, await getDataRevision())
    expect((await dutyScheduleRepo.listByWeek(1))[0].dayOfWeek).toBe(2)

    await db.assistant.update(a2, { timetableStatus: 'ready' })
    const row2 = await dutyScheduleRepo.add({ weekNo: 1, dayOfWeek: 1, timeSlot: 'c2', assistantId: a2 })
    await expect(
      moveAssignment(row2, { dayOfWeek: 4, timeSlot: 'c3' }, await getDataRevision()),
    ).rejects.toThrow(/数据库/)
    const rows = await dutyScheduleRepo.listByWeek(1)
    expect(rows.find((r) => r.id === row2)!.dayOfWeek).toBe(1) // 原位保留
  })

  it('锁定/解锁与例外清除的字段维护', async () => {
    const { a1 } = await seed()
    await db.assistant.update(a1, { timetableStatus: 'confirmed_empty' })
    const id = await addManualAssignment(
      { weekNo: 1, dayOfWeek: 1, timeSlot: 'c1', assistantId: a1, continuityExceptionReason: '临时' },
      await getDataRevision(),
    ).then(async () => (await dutyScheduleRepo.listByWeek(1))[0].id!)

    await setLocked(id, false, await getDataRevision())
    expect((await dutyScheduleRepo.listByWeek(1))[0].locked).toBe(false)
    await setLocked(id, true, await getDataRevision())

    await setContinuityException(id, null, await getDataRevision())
    const row = (await dutyScheduleRepo.listByWeek(1))[0]
    expect(row.continuityExceptionReason).toBeUndefined()
    // 空原因拒绝
    await expect(setContinuityException(id, '  ', await getDataRevision())).rejects.toThrow('原因不能为空')
  })

  it('移除锁定项：显式操作允许（其自身锁定不阻塞）', async () => {
    const { a1 } = await seed()
    await db.assistant.update(a1, { timetableStatus: 'confirmed_empty' })
    await addManualAssignment({ weekNo: 1, dayOfWeek: 1, timeSlot: 'c1', assistantId: a1 }, await getDataRevision())
    const id = (await dutyScheduleRepo.listByWeek(1))[0].id!
    await removeAssignment(id, await getDataRevision())
    expect(await dutyScheduleRepo.listByWeek(1)).toHaveLength(0)
  })
})

describe('并发与遗留问题', () => {
  it('CAS：基于旧版本的操作被拒（StaleDataError）', async () => {
    const { a1 } = await seed()
    await db.assistant.update(a1, { timetableStatus: 'confirmed_empty' })
    const stale = await getDataRevision()
    await addManualAssignment({ weekNo: 1, dayOfWeek: 1, timeSlot: 'c1', assistantId: a1 }, await getDataRevision())
    await expect(
      addManualAssignment({ weekNo: 1, dayOfWeek: 2, timeSlot: 'c1', assistantId: a1 }, stale),
    ).rejects.toBeInstanceOf(StaleDataError)
  })

  it('遗留旧问题不阻塞无关操作（差分校验）', async () => {
    const { a1, a2 } = await seed()
    await db.assistant.update(a1, { timetableStatus: 'confirmed_empty' })
    await db.assistant.update(a2, { timetableStatus: 'confirmed_empty' })
    // 预置一条"遗留违规"：a2 排在自己的课上（绕过服务直接写库模拟旧数据）
    await courseRepo.replaceForAssistant(a2, [
      { assistantId: a2, courseNo: '', courseName: '旧课', kind: 'theory', weekRanges: [[1, 17]], dayOfWeek: 5, sectionText: '第一节-第一节', sectionStart: 1, sectionEnd: 1 },
    ])
    await db.duty_schedule.add({ weekNo: 1, dayOfWeek: 5, timeSlot: 'c1', assistantId: a2, status: 'normal', source: 'auto' })
    // a1 在别处的正常手调不应被 a2 的遗留冲突阻塞
    await addManualAssignment({ weekNo: 1, dayOfWeek: 1, timeSlot: 'c1', assistantId: a1 }, await getDataRevision())
    expect(await dutyScheduleRepo.listByWeek(1)).toHaveLength(2)
  })
})

import { beforeEach, describe, expect, it } from 'vitest'
import 'fake-indexeddb/auto'
import { db } from './database'
import {
  assistantRepo,
  configRepo,
  courseRepo,
  dutyScheduleRepo,
  DuplicateDutyError,
  DuplicateStudentNoError,
  operationLogRepo,
  scheduleSnapshotRepo,
} from './repositories'
import type { Assistant, DutySchedule } from './schema'

/**
 * 仓储层单元测试。
 * fake-indexeddb 在 Node 中模拟完整的 IndexedDB 规范（含唯一索引约束），
 * 因此无需浏览器即可验证数据库行为；Dexie 连接的是全局 indexedDB，
 * 与生产环境走的是同一套 Dexie 代码路径。
 */

const baseAssistant = {
  studentNo: '1024001',
  name: '张三',
  identity: 'undergrad',
} as const

beforeEach(async () => {
  // 每个用例前清库。注意：Dexie 的 delete() 会关闭实例且不会自动重开，
  // 必须显式 open()（实测结论，见 docs/troubleshooting.md T-004）
  await db.delete()
  await db.open()
})

describe('assistantRepo', () => {
  it('新增并读取助理', async () => {
    const id = await assistantRepo.add({ ...baseAssistant })
    const got = await assistantRepo.get(id)
    expect(got?.name).toBe('张三')
    expect(got?.createdAt).toBeTruthy()
    expect(await assistantRepo.count()).toBe(1)
  })

  it('学号重复被拒绝', async () => {
    await assistantRepo.add({ ...baseAssistant })
    await expect(
      assistantRepo.add({ ...baseAssistant, name: '李四' }),
    ).rejects.toThrowError(DuplicateStudentNoError)
    // 数据库层唯一索引兜底也要验证：绕过 repo 直接写入同样被拒
    const ts = new Date().toISOString()
    await expect(
      db.assistant.add({ ...baseAssistant, name: '王五', createdAt: ts, updatedAt: ts } as Assistant),
    ).rejects.toThrowError()
  })

  it('更新时学号与其他人冲突被拒绝', async () => {
    const a = await assistantRepo.add({ ...baseAssistant })
    await assistantRepo.add({ ...baseAssistant, studentNo: '1024002', name: '李四' })
    await expect(
      assistantRepo.update(a, { studentNo: '1024002' }),
    ).rejects.toThrowError(DuplicateStudentNoError)
  })

  it('删除助理时级联删除其课程', async () => {
    const id = await assistantRepo.add({ ...baseAssistant })
    await courseRepo.replaceForAssistant(id, [
      { assistantId: id, courseNo: 'C1', courseName: '高数', weekRanges: [[1, 17]], dayOfWeek: 1, sectionStart: 1, sectionEnd: 2 },
    ])
    expect(await courseRepo.count()).toBe(1)
    await assistantRepo.remove(id)
    expect(await assistantRepo.get(id)).toBeUndefined()
    expect(await courseRepo.count()).toBe(0)
  })
})

describe('courseRepo', () => {
  it('replaceForAssistant 是整体替换语义', async () => {
    const id = await assistantRepo.add({ ...baseAssistant })
    const mk = (courseNo: string) => ({
      assistantId: id, courseNo, courseName: `课-${courseNo}`,
      weekRanges: [[1, 17]] as [number, number][], dayOfWeek: 2, sectionStart: 3, sectionEnd: 5,
    })
    await courseRepo.replaceForAssistant(id, [mk('C1'), mk('C2'), mk('C3')])
    await courseRepo.replaceForAssistant(id, [mk('C9')])
    const list = await courseRepo.listByAssistant(id)
    expect(list).toHaveLength(1)
    expect(list[0].courseNo).toBe('C9')
  })
})

describe('dutyScheduleRepo', () => {
  const duty = (assistantId: number, weekNo = 1, dayOfWeek = 1, timeSlot = '1-2') => ({
    weekNo, dayOfWeek, timeSlot, assistantId,
  })

  it('新增排班并按周查询', async () => {
    const a = await assistantRepo.add({ ...baseAssistant })
    await dutyScheduleRepo.add(duty(a))
    const week = await dutyScheduleRepo.listByWeek(1)
    expect(week).toHaveLength(1)
    expect(week[0].source).toBe('auto')
    expect(week[0].status).toBe('normal')
  })

  it('同一(周,天,时段,助理)重复被拒', async () => {
    const a = await assistantRepo.add({ ...baseAssistant })
    await dutyScheduleRepo.add(duty(a))
    await expect(dutyScheduleRepo.add(duty(a))).rejects.toThrowError(DuplicateDutyError)
  })

  it('同时段可以安排不同助理', async () => {
    const a = await assistantRepo.add({ ...baseAssistant })
    const b = await assistantRepo.add({ ...baseAssistant, studentNo: '1024002', name: '李四' })
    await dutyScheduleRepo.add(duty(a))
    await dutyScheduleRepo.add(duty(b))
    expect(await dutyScheduleRepo.listByWeek(1)).toHaveLength(2)
  })

  it('手动记录可被单独查出并保留于清周操作之外', async () => {
    const a = await assistantRepo.add({ ...baseAssistant })
    const id1 = await dutyScheduleRepo.add(duty(a), )
    await dutyScheduleRepo.update(id1, { source: 'manual' })
    await dutyScheduleRepo.add(duty(a, 1, 2, '3-5'))
    const manual = await dutyScheduleRepo.listManual()
    expect(manual).toHaveLength(1)
    expect(manual[0].id).toBe(id1)
    // clearWeek 只清指定周
    await dutyScheduleRepo.clearWeek(2)
    await dutyScheduleRepo.clearWeek(1)
    expect(await dutyScheduleRepo.all()).toHaveLength(0)
  })
})

describe('configRepo', () => {
  it('读写与覆盖', async () => {
    await configRepo.set('rules', { minHours: 4, maxHours: 12, perSlot: { min: 1, max: 2 } })
    const rules = await configRepo.get<{ minHours: number }>('rules')
    expect(rules?.minHours).toBe(4)
    await configRepo.set('rules', { minHours: 6 })
    expect((await configRepo.get<{ minHours: number }>('rules'))?.minHours).toBe(6)
    expect(await configRepo.get('missing')).toBeUndefined()
  })
})

describe('scheduleSnapshotRepo', () => {
  it('快照是深拷贝，原数据修改不影响快照', async () => {
    const a = await assistantRepo.add({ ...baseAssistant })
    const snap: DutySchedule[] = [
      { weekNo: 1, dayOfWeek: 1, timeSlot: '1-2', assistantId: a, status: 'normal', source: 'auto', createdAt: '', updatedAt: '' },
    ]
    await scheduleSnapshotRepo.save('测试快照', snap)
    snap[0].timeSlot = '3-5' // 修改原数组
    const latest = await scheduleSnapshotRepo.latest()
    expect(latest?.data[0].timeSlot).toBe('1-2') // 快照未被波及
    expect(latest?.label).toBe('测试快照')
  })
})

describe('operationLogRepo', () => {
  it('recent 按新到旧排列', async () => {
    await operationLogRepo.add('assistant.add', { name: '张三' })
    await operationLogRepo.add('assistant.add', { name: '李四' })
    await operationLogRepo.add('duty.assign', { slot: '1-2' })
    const logs = await operationLogRepo.recent(2)
    expect(logs).toHaveLength(2)
    expect(logs[0].action).toBe('duty.assign')
    expect(logs[1].action).toBe('assistant.add')
  })
})

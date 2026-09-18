import { beforeEach, describe, expect, it } from 'vitest'
import 'fake-indexeddb/auto'
import { db } from './database'
import { assistantRepo, courseRepo, operationLogRepo } from './repositories'
import { importTimetableForStudent } from './importService'
import type { ParsedCourse } from '../utils/courseParser'

/**
 * 课程表导入归档服务单元测试（SRS F05 导入侧，2026-09-13 修订）。
 *
 * 覆盖两条分支及其"结果一致"要求：
 *   情况一「学号已存在」→ 更新姓名/身份，保留电话/QQ/班级，替换课程表；
 *   情况二「学号不存在」→ 新建助理，替换课程表。
 * 两种情况最终都以同一份课程数据落库，故课程表内容必须完全一致。
 */

/** 构造解析结果（模拟 courseParser 的输出，只保留服务用得到的字段） */
function pc(over: Partial<ParsedCourse> = {}): ParsedCourse {
  return {
    courseNo: '10125121047',
    courseName: '软件工程[02]',
    kind: 'theory',
    identity: 'undergrad',
    className: '02',
    weekRanges: [[1, 4]],
    dayOfWeek: 1,
    sectionText: '第一节-第二节',
    sectionStart: 1,
    sectionEnd: 2,
    location: '南院-博学东楼-303',
    sourceText: '调试用原文',
    ...over,
  }
}

const base = {
  studentName: '示例学生A',
  studentNo: '1024002',
  identity: 'undergrad' as const,
}

beforeEach(async () => {
  // Dexie 的 delete() 不会自动重开，必须显式 open()（见 docs/troubleshooting.md T-004）
  await db.delete()
  await db.open()
})

describe('importTimetableForStudent', () => {
  it('情况二：学号不存在 → 直接新建助理并导入课程表', async () => {
    const courses = [pc(), pc({ courseNo: '2001', courseName: '数据库', dayOfWeek: 3 })]
    const r = await importTimetableForStudent({ ...base, courses })

    expect(r.action).toBe('created')
    expect(r.courseCount).toBe(2)
    expect(await assistantRepo.count()).toBe(1)
    const created = await assistantRepo.findByStudentNo(base.studentNo)
    expect(created?.name).toBe('示例学生A')
    expect(created?.identity).toBe('undergrad')
    expect(await courseRepo.listByAssistant(r.assistantId)).toHaveLength(2)
  })

  it('情况一：学号已存在 → 更新姓名/身份，保留电话、QQ、班级', async () => {
    const id = await assistantRepo.add({
      studentNo: base.studentNo,
      name: '示例学生A（旧名）',
      identity: 'undergrad',
      phone: '13800000001',
      qq: '123456',
      className: '软件2401',
    })

    const r = await importTimetableForStudent({
      studentName: '示例学生A',
      studentNo: base.studentNo,
      identity: 'graduate', // 课程表出现（研）标记
      courses: [pc()],
    })

    expect(r.action).toBe('updated')
    expect(r.assistantId).toBe(id)
    expect(r.nameChanged).toBe(true)
    expect(r.identityChanged).toBe(true)
    expect(await assistantRepo.count()).toBe(1) // 不会重复建档

    const updated = await assistantRepo.get(id)
    expect(updated?.name).toBe('示例学生A')
    expect(updated?.identity).toBe('graduate')
    // 课程表没有的信息必须原样保留
    expect(updated?.phone).toBe('13800000001')
    expect(updated?.qq).toBe('123456')
    expect(updated?.className).toBe('软件2401')
  })

  it('情况一：信息已一致 → 不产生更新，但仍重新导入课程表', async () => {
    // 注意：助理模型用 name，导入服务入参用 studentName —— 此处要显式建档
    const id = await assistantRepo.add({
      studentNo: base.studentNo,
      name: base.studentName,
      identity: base.identity,
    })
    const r = await importTimetableForStudent({ ...base, courses: [pc()] })
    expect(r.action).toBe('updated')
    expect(r.nameChanged).toBe(false)
    expect(r.identityChanged).toBe(false)
    expect(await courseRepo.listByAssistant(id)).toHaveLength(1)
    // 只有 course.import 一条日志（没有多余的 assistant.update）
    const logs = await operationLogRepo.recent(10)
    expect(logs.some((l) => l.action === 'assistant.update')).toBe(false)
    expect(logs.some((l) => l.action === 'course.import')).toBe(true)
  })

  it('两种情况结果一致：同一份课程数据落库后课程表完全相同', async () => {
    const courses = [
      pc({ courseNo: 'A1', courseName: '课程甲', dayOfWeek: 1, sectionStart: 1, sectionEnd: 2 }),
      pc({ courseNo: 'B2', courseName: '课程乙', dayOfWeek: 5, sectionStart: 8, sectionEnd: 9 }),
    ]
    // 情况二：新建
    const created = await importTimetableForStudent({ ...base, courses })
    const rowsCreated = await courseRepo.listByAssistant(created.assistantId)

    // 复位后模拟情况一：同一学号已存在
    await db.delete()
    await db.open()
    const id = await assistantRepo.add({ ...base, name: '示例学生A' })
    const updated = await importTimetableForStudent({ ...base, courses })
    const rowsUpdated = await courseRepo.listByAssistant(id)

    expect(updated.assistantId).toBe(id)
    // 逐字段比对（忽略自增 id 与归属 id 的差异，比较业务字段）
    const normalize = (rows: typeof rowsCreated) =>
      rows
        .map((r) => ({
          courseNo: r.courseNo,
          courseName: r.courseName,
          kind: r.kind,
          weekRanges: r.weekRanges,
          dayOfWeek: r.dayOfWeek,
          sectionText: r.sectionText,
          sectionStart: r.sectionStart,
          sectionEnd: r.sectionEnd,
          location: r.location,
        }))
        .sort((x, y) => x.courseNo.localeCompare(y.courseNo))
    expect(normalize(rowsUpdated)).toEqual(normalize(rowsCreated))
  })

  it('幂等：连续导入同一份课程表两次，结果不叠加', async () => {
    const courses = [pc(), pc({ courseNo: '2002', courseName: '编译原理', dayOfWeek: 4 })]
    const first = await importTimetableForStudent({ ...base, courses })
    const second = await importTimetableForStudent({ ...base, courses })

    expect(second.action).toBe('updated')
    expect(second.assistantId).toBe(first.assistantId)
    expect(await assistantRepo.count()).toBe(1)
    expect(await courseRepo.listByAssistant(first.assistantId)).toHaveLength(2)
  })

  it('课程落库字段与数据模型一致：不写入解析器的调试字段 sourceText', async () => {
    const r = await importTimetableForStudent({ ...base, courses: [pc()] })
    const [row] = await courseRepo.listByAssistant(r.assistantId)
    expect(row.location).toBe('南院-博学东楼-303')
    expect(row.sectionStart).toBe(1)
    expect(row.sectionEnd).toBe(2)
    expect(row.weekRanges).toEqual([[1, 4]])
    expect('sourceText' in row).toBe(false)
  })

  it('重复学号由唯一约束兜底：并发建档只可能成功一次', async () => {
    await importTimetableForStudent({ ...base, courses: [pc()] })
    await expect(async () => {
      await assistantRepo.add({
        studentNo: base.studentNo,
        name: '另一个人',
        identity: 'undergrad',
      })
    }).rejects.toThrow(/学号已存在/)
  })
})

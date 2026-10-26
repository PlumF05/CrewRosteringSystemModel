/**
 * dataRevision 与导入原子性测试（S2，2026-10-26，FE-06/FE-11 基础）。
 *
 * 覆盖：
 * - 版本原语：默认 0、写事务递增并透传结果、期望版本不符拒绝（CAS）；
 * - 导入原子性（故障注入，FE-06）：课程替换阶段失败 → 建档/改名/状态/日志/版本全部回滚，
 *   不出现"助理已建但没有课表"的半更新状态（审计 §5.1 的缺陷场景）。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import 'fake-indexeddb/auto'
import { db } from './database'
import { assistantRepo, courseRepo, operationLogRepo } from './repositories'
import { importTimetableForStudent } from './importService'
import { StaleDataError, getDataRevision, withDataRevision } from './dataRevision'
import type { ParsedCourse } from '../utils/courseParser'

function pc(over: Partial<ParsedCourse> = {}): ParsedCourse {
  return {
    courseNo: 'C1',
    courseName: '软件工程[02]',
    kind: 'theory',
    identity: 'undergrad',
    className: '02',
    weekRanges: [[1, 4]],
    dayOfWeek: 1,
    sectionText: '第一节-第二节',
    sectionStart: 1,
    sectionEnd: 2,
    location: 'A-101',
    sourceText: '',
    ...over,
  }
}

const base = { studentName: '示例学生A', studentNo: '1024002', identity: 'undergrad' as const }

beforeEach(async () => {
  await db.delete()
  await db.open()
})

describe('withDataRevision', () => {
  it('默认版本为 0；写事务递增并透传业务结果', async () => {
    expect(await getDataRevision()).toBe(0)
    const { result, revision } = await withDataRevision(null, [db.config], async () => 'ok' as const)
    expect(result).toBe('ok')
    expect(revision).toBe(1)
    expect(await getDataRevision()).toBe(1)
  })

  it('CAS：期望版本不是当前版本 → StaleDataError，且不执行写入', async () => {
    await withDataRevision(null, [db.config], async () => {})
    // 版本已是 1，期望 0 的操作必须被拒
    let wrote = false
    await expect(
      withDataRevision(0, [db.config], async () => {
        wrote = true
      }),
    ).rejects.toBeInstanceOf(StaleDataError)
    expect(wrote).toBe(false)
    expect(await getDataRevision()).toBe(1)
  })

  it('同一旧版本连续提交两次：第二次被拒（最多一个成功，无丢失更新）', async () => {
    const expected = await getDataRevision()
    await withDataRevision(expected, [db.config], async () => {})
    await expect(withDataRevision(expected, [db.config], async () => {})).rejects.toBeInstanceOf(
      StaleDataError,
    )
  })

  it('StaleDataError 携带期望与实际版本，供界面提示刷新', async () => {
    try {
      await withDataRevision(99, [db.config], async () => {})
      expect.unreachable()
    } catch (e) {
      expect(e).toBeInstanceOf(StaleDataError)
      const err = e as StaleDataError
      expect(err.expected).toBe(99)
      expect(err.actual).toBe(0)
      expect(err.message).toContain('请刷新后重试')
    }
  })
})

describe('导入原子性（FE-06 故障注入）', () => {
  it('课程替换阶段失败 → 建档/状态/日志/版本全部回滚，无半更新', async () => {
    const spy = vi
      .spyOn(courseRepo, 'replaceForAssistant')
      .mockRejectedValueOnce(new Error('注入：课程写入失败'))

    await expect(importTimetableForStudent({ ...base, courses: [pc()] })).rejects.toThrow('注入')

    expect(await assistantRepo.count()).toBe(0) // 关键：新建的助理被回滚
    expect(await courseRepo.count()).toBe(0)
    expect(await operationLogRepo.recent(10)).toHaveLength(0)
    expect(await getDataRevision()).toBe(0) // 版本未动 → 后续操作不会被误导
    spy.mockRestore()
  })

  it('更新分支同样原子：改名成功但状态写失败 → 姓名保持原样', async () => {
    await importTimetableForStudent({ ...base, courses: [pc()] })
    const revBefore = await getDataRevision()

    const spy = vi.spyOn(assistantRepo, 'update').mockRejectedValueOnce(new Error('注入：状态写入失败'))
    await expect(
      importTimetableForStudent({ ...base, studentName: '新名字', courses: [pc({ courseNo: 'X' })] }),
    ).rejects.toThrow('注入')

    const a = await assistantRepo.findByStudentNo(base.studentNo)
    expect(a?.name).toBe('示例学生A') // 未被半改成"新名字"
    expect(await courseRepo.listByAssistant(a!.id!)).toHaveLength(1) // 旧课程未被清空
    expect(await getDataRevision()).toBe(revBefore)
    spy.mockRestore()
  })

  it('正常导入递增版本（数据变化可被预览/手调感知）', async () => {
    await importTimetableForStudent({ ...base, courses: [pc()] })
    expect(await getDataRevision()).toBe(1)
    await importTimetableForStudent({ ...base, courses: [pc(), pc({ courseNo: 'C2' })] })
    expect(await getDataRevision()).toBe(2)
  })
})

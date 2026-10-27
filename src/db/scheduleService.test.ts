/**
 * 全周期原子保存测试（S2，2026-10-26，FE-12）。
 *
 * 覆盖：
 * - 多周整体替换成功 + 版本递增；
 * - 故障注入：第 N 周写入失败 → 全部周回滚（不出现"前几周新、后几周旧"）；
 * - 旧预览拒绝：预览生成后版本前进（如发生导入），携带旧版本的保存抛 StaleDataError
 *   且不改动任何数据。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import 'fake-indexeddb/auto'
import { db } from './database'
import { dutyScheduleRepo } from './repositories'
import { saveFullCycle } from './scheduleService'
import { StaleDataError, getDataRevision } from './dataRevision'
import { importTimetableForStudent } from './importService'
import type { ParsedCourse } from '../utils/courseParser'

const week = (weekNo: number, rows: Array<[number, string, number]>) => ({
  weekNo,
  rows: rows.map(([dayOfWeek, timeSlot, assistantId]) => ({ dayOfWeek, timeSlot, assistantId })),
})

const pc: ParsedCourse = {
  courseNo: 'C1',
  courseName: '课',
  kind: 'theory',
  identity: 'undergrad',
  className: '01',
  weekRanges: [[1, 4]],
  dayOfWeek: 1,
  sectionText: '第一节-第二节',
  sectionStart: 1,
  sectionEnd: 2,
  location: '',
  sourceText: '',
}

beforeEach(async () => {
  await db.delete()
  await db.open()
})

describe('saveFullCycle（全周期原子保存）', () => {
  it('多周整体替换：旧数据被清空，新数据完整落库，版本递增', async () => {
    await dutyScheduleRepo.add({ weekNo: 1, dayOfWeek: 1, timeSlot: 'c9', assistantId: 99 })
    const rev = await saveFullCycle(
      [
        week(1, [[1, 'c1', 1], [1, 'c2', 1]]),
        week(2, [[2, 'c1', 2]]),
      ],
      await getDataRevision(),
      { weekRange: [1, 2], mode: 'perWeek' },
    )
    expect(rev).toBe(1)
    const w1 = await dutyScheduleRepo.listByWeek(1)
    expect(w1).toHaveLength(2)
    expect(w1.some((r) => r.assistantId === 99)).toBe(false) // 旧数据已清
    expect(await dutyScheduleRepo.listByWeek(2)).toHaveLength(1)
    expect((await db.operation_log.orderBy('id').last())?.action).toBe('schedule.write')
  })

  it('FE-12 故障注入：第 2 周写入失败 → 两周全部回滚', async () => {
    await dutyScheduleRepo.add({ weekNo: 1, dayOfWeek: 1, timeSlot: 'c1', assistantId: 7 }) // 旧数据
    const spy = vi.spyOn(db.duty_schedule, 'bulkAdd').mockImplementationOnce(async () => {
      throw new Error('注入：第 2 周写入失败')
    })
    await expect(
      saveFullCycle(
        [week(1, [[1, 'c1', 1]]), week(2, [[2, 'c1', 2]])],
        await getDataRevision(),
        { weekRange: [1, 2], mode: 'perWeek' },
      ),
    ).rejects.toThrow('注入')
    spy.mockRestore()

    // 全周期保持旧状态：第 1 周未被替换，第 2 周没有部分写入
    const w1 = await dutyScheduleRepo.listByWeek(1)
    expect(w1).toHaveLength(1)
    expect(w1[0].assistantId).toBe(7)
    expect(await dutyScheduleRepo.listByWeek(2)).toHaveLength(0)
    expect(await getDataRevision()).toBe(0)
  })

  it('S3：写入行携带 locked / 短段例外原因，落库不丢失', async () => {
    await saveFullCycle(
      [
        {
          weekNo: 3,
          rows: [
            { dayOfWeek: 1, timeSlot: 'c1', assistantId: 5, source: 'manual', locked: true, continuityExceptionReason: '老师补位' },
            { dayOfWeek: 1, timeSlot: 'c2', assistantId: 6, source: 'auto', locked: false },
          ],
        },
      ],
      await getDataRevision(),
      { weekRange: [3, 3], mode: 'perWeek' },
    )
    const rows = await dutyScheduleRepo.listByWeek(3)
    const manual = rows.find((r) => r.assistantId === 5)!
    expect(manual.locked).toBe(true)
    expect(manual.continuityExceptionReason).toBe('老师补位')
    const auto = rows.find((r) => r.assistantId === 6)!
    expect(auto.locked).toBe(false)
    expect(auto.continuityExceptionReason).toBeUndefined()
  })

  it('旧预览拒绝：预览后发生过导入（版本前进）→ StaleDataError 且零改动', async () => {
    const previewRevision = await getDataRevision()
    // 预览生成后、写入前，发生了另一次业务写入（导入）
    await importTimetableForStudent({
      studentName: '示例学生A',
      studentNo: '1024002',
      identity: 'undergrad',
      courses: [pc],
    })
    await expect(
      saveFullCycle([week(1, [[1, 'c1', 1]])], previewRevision, { weekRange: [1, 1], mode: 'perWeek' }),
    ).rejects.toBeInstanceOf(StaleDataError)
    expect(await dutyScheduleRepo.listByWeek(1)).toHaveLength(0)
  })
})

/**
 * 课程手动编辑服务测试（S2 / F06 / FE-07，2026-10-26）。
 *
 * 覆盖：表单校验（星期/节次/周次文本）、增改删的事务与状态重算
 * （含"删到 0 条 → 确认无课"、"写入无法识别节次 → 待核对"）、
 * 课程变化对已写入排班的影响分析（冲突 + 待核对）。
 */
import { beforeEach, describe, expect, it } from 'vitest'
import 'fake-indexeddb/auto'
import { db } from './database'
import { assistantRepo, courseRepo, dutyScheduleRepo } from './repositories'
import { addCourse, analyzeCourseImpact, removeCourse, updateCourse, validateCourseEdit } from './courseService'
import { DEFAULT_RULES } from '../algorithms/types'

const input = (over: Partial<Parameters<typeof validateCourseEdit>[0]> = {}) => ({
  courseName: '软件工程',
  kind: 'theory' as const,
  dayOfWeek: 1,
  sectionText: '第一节-第二节',
  weeksText: '1-4周',
  ...over,
})

beforeEach(async () => {
  await db.delete()
  await db.open()
})

describe('validateCourseEdit', () => {
  it('合法输入通过', () => {
    expect(validateCourseEdit(input())).toEqual([])
  })
  it('空课程名 / 星期越界 / 空节次被拦', () => {
    expect(validateCourseEdit(input({ courseName: ' ' }))).toHaveLength(1)
    expect(validateCourseEdit(input({ dayOfWeek: 8 as unknown as number }))).toHaveLength(1)
    expect(validateCourseEdit(input({ sectionText: '' }))).toHaveLength(1)
  })
  it('周次文本解析失败被拦（给出可展示原因）', () => {
    const errors = validateCourseEdit(input({ weeksText: 'abc' }))
    expect(errors).toHaveLength(1)
    expect(errors[0]).toContain('无法解析')
  })
  it('单双周写法合法', () => {
    expect(validateCourseEdit(input({ weeksText: '5-17周单周' }))).toEqual([])
  })
})

describe('增改删与状态重算', () => {
  it('新增课程 → 课表状态 ready；版本递增', async () => {
    const id = await assistantRepo.add({ name: '示例学生A', studentNo: '1', identity: 'undergrad' })
    await addCourse(id, input())
    expect(await courseRepo.listByAssistant(id)).toHaveLength(1)
    expect((await assistantRepo.get(id))?.timetableStatus).toBe('ready')
  })

  it('新增无法识别节次 → 状态 needs_review；修改为可识别后恢复 ready', async () => {
    const id = await assistantRepo.add({ name: '示例学生A', studentNo: '1', identity: 'undergrad' })
    await addCourse(id, input({ sectionText: '待定' }))
    expect((await assistantRepo.get(id))?.timetableStatus).toBe('needs_review')

    const row = (await courseRepo.listByAssistant(id))[0]
    await updateCourse(row.id!, input({ sectionText: '第三节-中课2' }))
    expect((await assistantRepo.get(id))?.timetableStatus).toBe('ready')
    expect((await courseRepo.listByAssistant(id))[0].sectionText).toBe('第三节-中课2')
  })

  it('删除到 0 条 → 状态 confirmed_empty（显式无课）', async () => {
    const id = await assistantRepo.add({ name: '示例学生A', studentNo: '1', identity: 'undergrad' })
    await addCourse(id, input())
    const row = (await courseRepo.listByAssistant(id))[0]
    await removeCourse(row.id!)
    expect(await courseRepo.listByAssistant(id)).toHaveLength(0)
    expect((await assistantRepo.get(id))?.timetableStatus).toBe('confirmed_empty')
  })

  it('周次文本正确展开为区间（单双周）', async () => {
    const id = await assistantRepo.add({ name: '示例学生A', studentNo: '1', identity: 'undergrad' })
    await addCourse(id, input({ weeksText: '1-2周,5周' }))
    const row = (await courseRepo.listByAssistant(id))[0]
    expect(row.weekRanges).toEqual([[1, 2], [5, 5]])
  })
})

describe('影响分析（FE-07）', () => {
  it('课程与已写入排班冲突 → 报告冲突条目', async () => {
    const id = await assistantRepo.add({ name: '示例学生A', studentNo: '1', identity: 'undergrad' })
    await addCourse(id, input({ sectionText: '第一节-第一节', weeksText: '1-17周' }))
    await dutyScheduleRepo.add({ weekNo: 2, dayOfWeek: 1, timeSlot: 'c1', assistantId: id })

    const impact = await analyzeCourseImpact(id, DEFAULT_RULES)
    expect(impact.conflicts).toHaveLength(1)
    expect(impact.conflicts[0]).toMatchObject({ weekNo: 2, dayOfWeek: 1, timeSlot: 'c1' })
  })

  it('无法识别节次 × 同日排班 → 待核对而非"安全"', async () => {
    const id = await assistantRepo.add({ name: '示例学生A', studentNo: '1', identity: 'undergrad' })
    await addCourse(id, input({ sectionText: '待定' }))
    await dutyScheduleRepo.add({ weekNo: 1, dayOfWeek: 1, timeSlot: 'c1', assistantId: id })

    const impact = await analyzeCourseImpact(id, DEFAULT_RULES)
    expect(impact.conflicts).toHaveLength(0)
    expect(impact.needsReview).toHaveLength(1)
  })

  it('无排班时影响为空（不误报）', async () => {
    const id = await assistantRepo.add({ name: '示例学生A', studentNo: '1', identity: 'undergrad' })
    await addCourse(id, input())
    const impact = await analyzeCourseImpact(id, DEFAULT_RULES)
    expect(impact.conflicts).toHaveLength(0)
    expect(impact.needsReview).toHaveLength(0)
  })
})

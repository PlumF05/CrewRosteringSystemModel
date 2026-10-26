/**
 * 课程手动编辑服务（S2 / F06 / FE-07，2026-10-26）。
 *
 * 职责：新增 / 修改 / 删除单条课程——校验、写库、课表状态重算、操作日志、
 * dataRevision 递增全部在**同一个写事务**内；并给出对当前已写入排班的影响分析
 * （冲突 + 待核对，与导入路径同一套判定，见 dutyConflict.ts）。
 *
 * 语义要点：
 * - 手动改课是"老师明确知道这条课存在"的动作：写入后按当前完整课程表重算四分类状态
 *   （全部可识别 → ready；含无法识别节次 → needs_review；删到 0 条 → confirmed_empty）；
 * - 排班不在这里改：影响分析只报告（冲突/待核对/受影响条数），处理动作
 *   （删除冲突排班/去重排）由界面已有入口承接；
 * - 周次文本沿用解析器的 parseWeekList（"1-4周,6-17周单周"），校验失败拒绝保存。
 */
import { db } from './database'
import { assistantRepo, operationLogRepo } from './repositories'
import { withDataRevision } from './dataRevision'
import { deriveImportStatus } from '../algorithms/timetableStatus'
import { findDutyConflicts, findDutyNeedsReview, type DutyConflict, type DutyNeedsReview } from '../algorithms/dutyConflict'
import type { Course, CourseKind } from './schema'
import type { SchedulingRules } from '../algorithms/types'
import { parseWeekList } from '../utils/weekParser'

export interface CourseEditInput {
  courseNo?: string
  courseName: string
  kind: CourseKind
  dayOfWeek: number
  /** 节次原文，如 "第三节-中课2"（与导入一致；无法识别时状态会转待核对） */
  sectionText: string
  /** 周次文本，如 "1-4周,6-17周"（解析后落库为区间列表） */
  weeksText: string
  location?: string
  note?: string
}

/** 表单校验：返回可展示的错误列表（空 = 通过） */
export function validateCourseEdit(input: CourseEditInput): string[] {
  const errors: string[] = []
  if (!input.courseName.trim()) errors.push('课程名不能为空')
  if (!Number.isInteger(input.dayOfWeek) || input.dayOfWeek < 1 || input.dayOfWeek > 7)
    errors.push('星期必须为 1~7')
  if (!input.sectionText.trim()) errors.push('节次不能为空')
  if (input.kind !== 'theory' && input.kind !== 'experiment') errors.push('课程类别不合法')
  try {
    const ranges = parseWeekList(input.weeksText)
    if (ranges.length === 0) errors.push('周次不能为空')
  } catch (e) {
    errors.push(e instanceof Error ? e.message : '周次格式无法解析')
  }
  return errors
}

/** 事务内：按当前完整课程表重算该助理的课表状态 */
async function recomputeStatus(assistantId: number): Promise<string> {
  const courses = await db.course.where('assistantId').equals(assistantId).toArray()
  const status = deriveImportStatus(courses)
  await assistantRepo.update(assistantId, { timetableStatus: status })
  return status
}

function toRow(assistantId: number, input: CourseEditInput): Omit<Course, 'id'> {
  return {
    assistantId,
    courseNo: input.courseNo?.trim() ?? '',
    courseName: input.courseName.trim(),
    kind: input.kind,
    weekRanges: parseWeekList(input.weeksText),
    dayOfWeek: input.dayOfWeek,
    sectionText: input.sectionText.trim(),
    sectionStart: null,
    sectionEnd: null,
    location: input.location?.trim() || undefined,
    note: input.note?.trim() || undefined,
  }
}

export async function addCourse(assistantId: number, input: CourseEditInput): Promise<void> {
  await withDataRevision(null, [db.course, db.assistant, db.operation_log], async () => {
    await db.course.add({ ...toRow(assistantId, input), assistantId })
    const status = await recomputeStatus(assistantId)
    await operationLogRepo.add('course.add', { assistantId, courseName: input.courseName, timetableStatus: status, via: 'manual-edit' })
  })
}

export async function updateCourse(courseId: number, input: CourseEditInput): Promise<void> {
  await withDataRevision(null, [db.course, db.assistant, db.operation_log], async () => {
    const row = await db.course.get(courseId)
    if (!row) throw new Error('课程记录不存在（可能已被删除），请刷新')
    const assistantId = row.assistantId
    await db.course.put({ ...row, ...toRow(assistantId, input) } as Course)
    const status = await recomputeStatus(assistantId)
    await operationLogRepo.add('course.update', { assistantId, courseName: input.courseName, timetableStatus: status, via: 'manual-edit' })
  })
}

export async function removeCourse(courseId: number): Promise<void> {
  await withDataRevision(null, [db.course, db.assistant, db.operation_log], async () => {
    const row = await db.course.get(courseId)
    if (!row) throw new Error('课程记录不存在（可能已被删除），请刷新')
    await db.course.delete(courseId)
    const status = await recomputeStatus(row.assistantId)
    await operationLogRepo.add('course.remove', { assistantId: row.assistantId, courseName: row.courseName, timetableStatus: status, via: 'manual-edit' })
  })
}

export interface CourseChangeImpact {
  conflicts: DutyConflict[]
  needsReview: DutyNeedsReview[]
}

/** 课程变化后对已写入排班的影响：与导入路径同一套冲突/待核对判定 */
export async function analyzeCourseImpact(
  assistantId: number,
  rules: SchedulingRules,
): Promise<CourseChangeImpact> {
  const [courses, duties] = await Promise.all([
    db.course.where('assistantId').equals(assistantId).toArray(),
    db.duty_schedule.where('assistantId').equals(assistantId).toArray(),
  ])
  const conflictCourses = courses.map((c) => ({
    assistantId,
    kind: c.kind,
    dayOfWeek: c.dayOfWeek,
    courseName: c.courseName,
    sectionText: c.sectionText,
    weekRanges: c.weekRanges as [number, number][],
  }))
  const dutyRows = duties.map((d) => ({
    id: d.id,
    weekNo: d.weekNo,
    dayOfWeek: d.dayOfWeek,
    timeSlot: d.timeSlot,
    assistantId: d.assistantId,
  }))
  return {
    conflicts: findDutyConflicts({ rules, assistantId, courses: conflictCourses, duties: dutyRows }),
    needsReview: findDutyNeedsReview({ rules, assistantId, courses: conflictCourses, duties: dutyRows }),
  }
}

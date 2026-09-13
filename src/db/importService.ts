/**
 * 课程表导入归档服务（SRS F05 导入侧，2026-09-13 修订）。
 *
 * 职责：把"解析出的学生 + 课程表"落到数据库，**两种情况的处理流程收口到同一出口**，
 * 从而保证结果一致、可重复导入（幂等）：
 *
 *   情况一「学号已存在」→ 更新该助理的姓名与身份类型（课程表能提供的字段），
 *                        电话 / QQ / 班级等课程表没有的信息一律保留；随后替换其课程表。
 *   情况二「学号不存在」→ 直接新建助理；随后替换其课程表。
 *
 * 为什么要独立成一层（而不是写在 .vue 里）：
 * 1. 分支逻辑是可被单测覆盖的业务规则（配合 fake-indexeddb 跑真实仓储路径）；
 * 2. 组件只保留"解析 → 调用 → 展示"，符合项目既有的分层纪律（UI 不直接编排数据库）；
 * 3. 将来若改为"增量导入"或加入冲突策略，只改这一处。
 *
 * 注意：调用方必须已校验 studentName / studentNo 非空——缺少学生标识时无法自动归属，
 * 属于"不该落库"的情形，由调用方直接报错中止。
 */
import { assistantRepo, courseRepo, operationLogRepo } from './repositories'
import type { Course, Identity } from './schema'
import type { ParsedCourse } from '../utils/courseParser'

export interface ImportTimetableInput {
  studentName: string
  studentNo: string
  /** 身份类型：由课程条目的（本）/（研）标记推导 */
  identity: Identity
  courses: ParsedCourse[]
}

export interface ImportTimetableResult {
  assistantId: number
  /** created = 本次新建了助理；updated = 助理已存在 */
  action: 'created' | 'updated'
  /** 更新分支下，姓名 / 身份类型是否真的发生了变化（用于结果报告） */
  nameChanged: boolean
  identityChanged: boolean
  /** 写入的课程条数 */
  courseCount: number
}

/** ParsedCourse → Course 落库模型：只写数据模型声明的字段，丢弃解析器的调试字段 sourceText */
function toCourseRow(assistantId: number, c: ParsedCourse): Omit<Course, 'id'> {
  return {
    assistantId,
    courseNo: c.courseNo,
    courseName: c.courseName,
    kind: c.kind,
    weekRanges: c.weekRanges.map(([s, e]) => [s, e] as [number, number]),
    dayOfWeek: c.dayOfWeek,
    sectionText: c.sectionText,
    sectionStart: c.sectionStart,
    sectionEnd: c.sectionEnd,
    location: c.location,
    note: c.note,
  }
}

/**
 * 归档一名学生的课程表（自动建档 / 更新 + 整体替换课程表）。
 * 两种情况共用同一个收口动作 replaceForAssistant，因此最终状态只取决于解析结果。
 */
export async function importTimetableForStudent(
  input: ImportTimetableInput,
): Promise<ImportTimetableResult> {
  const { studentName, studentNo, identity, courses } = input

  const existing = await assistantRepo.findByStudentNo(studentNo)

  let assistantId: number
  let action: ImportTimetableResult['action']
  let nameChanged = false
  let identityChanged = false

  if (existing) {
    // ---------- 情况一：已存在 → 更新其信息 ----------
    nameChanged = existing.name !== studentName
    identityChanged = existing.identity !== identity
    if (nameChanged || identityChanged) {
      await assistantRepo.update(existing.id!, { name: studentName, identity })
      await operationLogRepo.add('assistant.update', {
        studentNo,
        name: studentName,
        via: 'course-import',
        changed: { name: nameChanged, identity: identityChanged },
      })
    }
    assistantId = existing.id!
    action = 'updated'
  } else {
    // ---------- 情况二：不存在 → 直接新建 ----------
    assistantId = await assistantRepo.add({ name: studentName, studentNo, identity })
    await operationLogRepo.add('assistant.add', { studentNo, name: studentName, via: 'course-import' })
    action = 'created'
  }

  // ---------- 共同出口：整体替换该助理的课程表（幂等）----------
  await courseRepo.replaceForAssistant(
    assistantId,
    courses.map((c) => toCourseRow(assistantId, c)),
  )
  await operationLogRepo.add('course.import', {
    studentNo,
    studentName,
    count: courses.length,
    assistantAction: action,
  })

  return { assistantId, action, nameChanged, identityChanged, courseCount: courses.length }
}

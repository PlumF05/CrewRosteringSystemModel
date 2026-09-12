import Dexie, { type Table } from 'dexie'
import type {
  Assistant,
  ConfigEntry,
  Course,
  DutySchedule,
  OperationLog,
  ScheduleSnapshot,
} from './schema'

/**
 * 数据库实例。
 *
 * 表名刻意与 ADR-002 5.2 节定义保持一致（assistant/course/duty_schedule/...），
 * 保证"文档 = 实现"，review 时可逐字段核对。
 *
 * 索引语法（Dexie）：
 * - ++id          自增主键
 * - &studentNo    唯一索引（学号查重的数据库层兜底）
 * - &[a+b+c+d]    复合唯一索引：同一周/天/时段不允许重复安排同一名助理
 * - 普通字段名     二级索引，供 where() 查询
 */
export class CrsmDatabase extends Dexie {
  assistant!: Table<Assistant, number>
  course!: Table<Course, number>
  duty_schedule!: Table<DutySchedule, number>
  config!: Table<ConfigEntry, string>
  operation_log!: Table<OperationLog, number>
  schedule_snapshot!: Table<ScheduleSnapshot, number>

  constructor() {
    super('crsm')
    this.version(1).stores({
      assistant:
        '++id, &studentNo, name, identity, className',
      course:
        '++id, assistantId, courseNo, courseName',
      duty_schedule:
        '++id, &[weekNo+dayOfWeek+timeSlot+assistantId], weekNo, dayOfWeek, timeSlot, assistantId, source',
      config: '&key',
      operation_log: '++id, operatedAt, action',
      schedule_snapshot: '++id, createdAt, label',
    })
    // v2（2026-09-11）：课程新增 kind（theory/experiment）——存量行按 note 回填；
    // 排班时段键格式变更（固定模板 → 节次区间键 c{start}-{end}），旧格式排班记录清空
    this.version(2)
      .stores({
        assistant:
          '++id, &studentNo, name, identity, className',
        course:
          '++id, assistantId, courseNo, courseName',
        duty_schedule:
          '++id, &[weekNo+dayOfWeek+timeSlot+assistantId], weekNo, dayOfWeek, timeSlot, assistantId, source',
        config: '&key',
        operation_log: '++id, operatedAt, action',
        schedule_snapshot: '++id, createdAt, label',
      })
      .upgrade(async (tx) => {
        await tx.table('course').toCollection().modify((c) => {
          if (!c.kind) c.kind = c.note ? 'experiment' : 'theory'
        })
        await tx.table('duty_schedule').clear()
      })
  }
}

/** 全局单例。UI 层永远通过 repositories.ts 访问，不直接 import db */
export const db = new CrsmDatabase()

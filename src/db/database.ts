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
    // v3（2026-09-13）：排班时段编号与课程表对齐——下午由第 8~11 节改为第 6~9 节。
    //
    // 为什么这里"归档 + 清空"而**不是**逐行平移节次键：
    //   旧、新两套编号在"键"上不可区分——键 c8 在旧体系是"下午第一节"，在新体系却是
    //   "下午第三节"；c9 同理（旧=下午第二节，新=下午第四节）。若库中同时存在两种写法
    //   的行（曾出现过这种中间态），逐行平移会在复合唯一索引
    //   [weekNo+dayOfWeek+timeSlot+assistantId] 上撞键，使整个升级事务回滚、数据库直接
    //   不可用；即便不撞键，也可能把下午节次**静默改错**——那正是本次要修的缺陷类型。
    //   排班是 (课程表, 规则) 的纯函数结果，可由"生成排班"完整重算，因此选择把旧数据
    //   归档进 schedule_snapshot 后清空（v2 的时段键格式变更亦采用清空策略，保持一致）。
    this.version(3)
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
        const table = tx.table('duty_schedule')
        const rows = await table.toArray()
        if (rows.length === 0) return // 无历史排班，无需归档
        const ts = new Date().toISOString()
        await tx.table('schedule_snapshot').add({
          createdAt: ts,
          label: '升级归档：节次编号对齐（下午 8~11 → 6~9）前的排班',
          data: rows,
        })
        await tx.table('operation_log').add({
          operatedAt: ts,
          action: 'schedule.migrate',
          detail: {
            from: '上午 1~4 / 下午 8~11 节',
            to: '上午 1~4 / 下午 6~9 节',
            archivedRows: rows.length,
          },
        })
        await table.clear()
      })
  }
}

/** 全局单例。UI 层永远通过 repositories.ts 访问，不直接 import db */
export const db = new CrsmDatabase()

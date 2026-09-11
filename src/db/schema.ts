/**
 * 数据表类型定义 —— 与 docs/ADR-002.md 第 5.2 节的字段定义一一对应。
 *
 * 约定：
 * - id 均为 IndexedDB 自增主键（Dexie 的 ++id），新增时由调用方省略；
 * - 时间字段统一用 ISO 8601 字符串（便于 JSON 序列化到快照与导出）；
 * - 结构化字段（如 weekRanges）直接存数组——IndexedDB 原生支持结构化克隆，
 *   不需要像 localStorage 那样手工 JSON 序列化。
 */

/** 助理身份类型（字符串字面量联合类型 ≈ 枚举） */
export type Identity = 'undergrad' | 'graduate'

/** 排班来源：auto = 算法生成；manual = 手动调整（重新排班时保留） */
export type DutySource = 'auto' | 'manual'

/** 排班记录状态：normal = 正常；conflict = 违反约束（管理员强制保留时标记） */
export type DutyStatus = 'normal' | 'conflict'

/** 助理信息表（ADR-002 5.2 assistant） */
export interface Assistant {
  id?: number
  /** 学号，全表唯一（Dexie 唯一索引 &studentNo 兜底 + 仓储层友好报错） */
  studentNo: string
  name: string
  identity: Identity
  phone?: string
  qq?: string
  className?: string
  createdAt: string
  updatedAt: string
}

/** 课程表（ADR-002 5.2 course，2026-09-11 修订：节次支持非数字标签）。课程是"排班的障碍物"：占用的时间即不可值班时间 */
export interface Course {
  id?: number
  assistantId: number
  /** 课程编号，如 10125121047；实验课为批次号如 20261-07741（同编号可因不同班次重复出现） */
  courseNo: string
  courseName: string
  /** 生效周次区间列表，如 [[1,4],[6,17]] 表示第 1~4 周和第 6~17 周有课 */
  weekRanges: [number, number][]
  /** 1 = 周一 … 7 = 周日（约定 1 起始，避免 JS Date 的 0 起始星期歧义） */
  dayOfWeek: number
  /** 节次原文（如 "第三节-中课2"），始终保留用于展示 */
  sectionText: string
  /** 数字节次起止；含非数字标签（中课/晚课）时为 null */
  sectionStart: number | null
  sectionEnd: number | null
  location?: string
  teacher?: string
  /** 补充说明，如实验课的实验项目与批次 */
  note?: string
}

/** 排班记录（ADR-002 5.2 duty_schedule）。一条 = 某周某天某时段安排了一名助理 */
export interface DutySchedule {
  id?: number
  weekNo: number
  dayOfWeek: number
  /** 时段标识，如 "1-2"（第一~二节）。具体时段定义存 config 表 */
  timeSlot: string
  assistantId: number
  status: DutyStatus
  source: DutySource
  createdAt: string
  updatedAt: string
}

/** 系统配置（键值对）。value 走 JSON 结构化存储，schema 由使用方约定 */
export interface ConfigEntry {
  key: string
  value: unknown
}

/** 操作日志（SRS 4.2 可追溯要求） */
export interface OperationLog {
  id?: number
  operatedAt: string
  /** 动作类型，如 assistant.add / duty.assign / duty.remove */
  action: string
  detail?: unknown
}

/** 排班快照（ADR-002 第四节：撤销/重做与重排对比的数据基础） */
export interface ScheduleSnapshot {
  id?: number
  createdAt: string
  /** 快照用途说明，如 "自动排班前" / "手动调整" */
  label: string
  /** 快照时刻的整份排班数据（深拷贝） */
  data: DutySchedule[]
}

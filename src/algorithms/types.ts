/**
 * 排班算法的类型定义——刻意与数据层（Dexie）解耦：
 * 算法只吃纯数据（Plain Object），不 import 数据库也不 import Vue，
 * 因此可以在 Node 里用穷举的固定用例做单元测试（ADR-002 第三节的决策）。
 */
import type { Identity } from '../db/schema'

/** 时段模板：行政办开放值班的时段定义（不含中课/晚课——非数字节次无法映射课时） */
export interface SlotTemplate {
  /** 稳定标识，如 "1-2"，写入 duty_schedule.timeSlot */
  key: string
  label: string
  sectionStart: number
  sectionEnd: number
}

/** 排班规则（SRS F03），持久化于 config 表 key='rules' */
export interface SchedulingRules {
  /** 排班周期（周次范围） */
  weekStart: number
  weekEnd: number
  /** 每人每周期最少/最多值班节数（工时单位=节，1 节≈45 分钟） */
  minSectionsPerAssistant: number
  maxSectionsPerAssistant: number
  /** 同时段人数下限/上限 */
  minPerSlot: number
  maxPerSlot: number
  /** 启用的时段模板（子集） */
  slotTemplates: SlotTemplate[]
}

export const DEFAULT_SLOT_TEMPLATES: SlotTemplate[] = [
  { key: '1-2', label: '第一节-第二节', sectionStart: 1, sectionEnd: 2 },
  { key: '3-5', label: '第三节-第五节', sectionStart: 3, sectionEnd: 5 },
  { key: '6-8', label: '第六节-第八节', sectionStart: 6, sectionEnd: 8 },
  { key: '9-10', label: '第九节-第十节', sectionStart: 9, sectionEnd: 10 },
  { key: '11-13', label: '第十一节-第十三节', sectionStart: 11, sectionEnd: 13 },
]

export const DEFAULT_RULES: SchedulingRules = {
  weekStart: 1,
  weekEnd: 17,
  minSectionsPerAssistant: 4,
  maxSectionsPerAssistant: 12,
  minPerSlot: 1,
  maxPerSlot: 2,
  slotTemplates: DEFAULT_SLOT_TEMPLATES,
}

/** 算法输入：助理（只带算法需要的字段） */
export interface AssistantInput {
  id: number
  name: string
  identity: Identity
}

/** 算法输入：课程（判定占用的最小字段集） */
export interface CourseInput {
  assistantId: number
  dayOfWeek: number
  /** 数字节次；null = 非数字标签（中课/晚课），按"全天占用"保守处理 */
  sectionStart: number | null
  sectionEnd: number | null
  weekRanges: [number, number][]
}

/** F08 的"保留手动调整"：重排前已确定的人岗（阶段 6 使用，算法即已支持） */
export interface KeepEntry {
  dayOfWeek: number
  slotKey: string
  assistantId: number
}

export interface ScheduleInput {
  weekNo: number
  rules: SchedulingRules
  assistants: AssistantInput[]
  courses: CourseInput[]
  keep?: KeepEntry[]
}

/** 一条分配结果（尚未落库，落库时由 UI 补 weekNo/status/source） */
export interface Assignment {
  dayOfWeek: number
  slotKey: string
  assistantId: number
  /** auto = 算法生成；manual = 来自 keep 的保留项 */
  source: 'auto' | 'manual'
}

export interface UnmetSlot {
  dayOfWeek: number
  slotKey: string
  /** 还差几个人 */
  short: number
  required: number
  actual: number
  reason: string
}

export interface AssistantSummary {
  assistantId: number
  name: string
  /** 值班总节数 */
  sections: number
  /** 排到的时段个数 */
  slots: number
  belowMin: boolean
  atMax: boolean
}

export interface ScheduleOutput {
  assignments: Assignment[]
  unmetSlots: UnmetSlot[]
  summaries: AssistantSummary[]
  /** 算法耗时（毫秒，用于 SRS 4.1 性能验证） */
  elapsedMs: number
}

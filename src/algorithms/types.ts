/**
 * 排班算法的类型定义——刻意与数据层（Dexie）解耦：
 * 算法只吃纯数据（Plain Object），不 import 数据库也不 import Vue，
 * 因此可以在 Node 里用穷举的固定用例做单元测试（ADR-002 第三节的决策）。
 *
 * 2026-09-11 修订（见 ADR-002 第七节）：
 * - 时段不再用固定模板，由 工作日 × 上班节次 推导；
 * - 新增排班模式（各周独立 / 各周相同）；
 * - 新增课程占用过滤（理论课（本）/ 实验课（实））。
 */
import type { Identity, CourseKind } from '../db/schema'

/** 上班节次区间：如 { start: 1, end: 4, label: '上午' } */
export interface WorkSection {
  start: number
  end: number
  label: string
}

/** 排班规则（SRS F03，2026-09-11 修订版），持久化于 config 表 key='rules' */
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
  /** 工作日（1=周一 … 7=周日），默认周一~周五 */
  workdays: number[]
  /** 上班节次区间（默认上午 1~4 节、下午 8~11 节） */
  workSections: WorkSection[]
  /** 排班模式：true = 各周排班相同（任一周有课即占用，生成一份复制到全部周） */
  uniformMode: boolean
  /** 理论课（（本）/（研））是否计入值班占用 */
  countTheory: boolean
  /** 实验课（（实））是否计入值班占用 */
  countExperiment: boolean
  /** 最少连续值班节数（2026-09-11 增补）：>1 时孤立单节值班不被安排，默认 1 = 不限制 */
  minConsecutiveSections: number
}

export const DEFAULT_WORKDAYS: number[] = [1, 2, 3, 4, 5]
export const DEFAULT_WORK_SECTIONS: WorkSection[] = [
  { start: 1, end: 4, label: '上午' },
  { start: 8, end: 11, label: '下午' },
]

export const DEFAULT_RULES: SchedulingRules = {
  weekStart: 1,
  weekEnd: 17,
  minSectionsPerAssistant: 4,
  maxSectionsPerAssistant: 12,
  minPerSlot: 1,
  maxPerSlot: 2,
  workdays: [...DEFAULT_WORKDAYS],
  workSections: JSON.parse(JSON.stringify(DEFAULT_WORK_SECTIONS)),
  uniformMode: false,
  countTheory: true,
  countExperiment: true,
  minConsecutiveSections: 1,
}

/**
 * 由 工作日 × 上班节次 推导排班时段——**按单节拆分**（第 1 节、第 2 节…各自是
 * 一个独立排班时段，用户要求按时段节次逐一显示）。
 * key = `c{节号}`（如 c1、c11），即 duty_schedule.timeSlot 存的键。
 */
export interface Slot {
  dayOfWeek: number
  key: string
  label: string
  sectionStart: number
  sectionEnd: number
}

export function buildSlots(rules: SchedulingRules): Slot[] {
  const slots: Slot[] = []
  for (const day of [...rules.workdays].sort((a, b) => a - b)) {
    for (const sec of rules.workSections) {
      for (let s = sec.start; s <= sec.end; s++) {
        slots.push({
          dayOfWeek: day,
          key: `c${s}`,
          label: `${sec.label} 第${s}节`,
          sectionStart: s,
          sectionEnd: s,
        })
      }
    }
  }
  return slots
}

/**
 * 兼容旧版配置：合并默认值并丢弃已废弃字段（旧版 slotTemplates）。
 * 用户升级后首次读取 config 时调用。
 */
export function normalizeRules(saved: Partial<SchedulingRules> | null | undefined): SchedulingRules {
  const r = { ...DEFAULT_RULES, ...(saved ?? {}) } as SchedulingRules
  delete (r as unknown as Record<string, unknown>).slotTemplates
  if (!Array.isArray(r.workdays) || r.workdays.length === 0) r.workdays = [...DEFAULT_WORKDAYS]
  if (!Array.isArray(r.workSections) || r.workSections.length === 0)
    r.workSections = JSON.parse(JSON.stringify(DEFAULT_WORK_SECTIONS))
  if (typeof r.uniformMode !== 'boolean') r.uniformMode = false
  if (typeof r.countTheory !== 'boolean') r.countTheory = true
  if (typeof r.countExperiment !== 'boolean') r.countExperiment = true
  if (typeof r.minConsecutiveSections !== 'number' || r.minConsecutiveSections < 1)
    r.minConsecutiveSections = 1
  if (typeof r.weekStart !== 'number' || typeof r.weekEnd !== 'number') {
    r.weekStart = DEFAULT_RULES.weekStart
    r.weekEnd = DEFAULT_RULES.weekEnd
  }
  return r
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
  kind?: CourseKind
  dayOfWeek: number
  /** 数字节次；null = 非数字标签（中课/晚课），按"全天占用"保守处理 */
  sectionStart: number | null
  sectionEnd: number | null
  weekRanges: [number, number][]
}

/**
 * 排班时段为单节（每时段 1 节），工时上限即"最多时段数"。
 * minSectionsPerAssistant / maxSectionsPerAssistant 语义不变（节数）。
 */

/** F08 的"保留手动调整"：重排前已确定的人岗（阶段 6 使用，算法即已支持） */
export interface KeepEntry {
  dayOfWeek: number
  slotKey: string
  assistantId: number
}

export interface BaseScheduleInput {
  rules: SchedulingRules
  assistants: AssistantInput[]
  courses: CourseInput[]
  keep?: KeepEntry[]
}

export interface ScheduleInput extends BaseScheduleInput {
  weekNo: number
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

/** 单周排班结果 */
export interface ScheduleOutput {
  assignments: Assignment[]
  unmetSlots: UnmetSlot[]
  summaries: AssistantSummary[]
  /** 算法耗时（毫秒，用于 SRS 4.1 性能验证） */
  elapsedMs: number
}

export interface WeeklySchedule extends ScheduleOutput {
  weekNo: number
  /** uniform 模式下为 true：本周方案是复制的统一方案 */
  replicated?: boolean
}

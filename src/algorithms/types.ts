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
  /** 上班节次区间（默认上午 1~4 节、下午 6~9 节，编号与课程表一致） */
  workSections: WorkSection[]
  /** 排班模式：true = 各周排班相同（任一周有课即占用，生成一份复制到全部周） */
  uniformMode: boolean
  /** 理论课（（本）/（研））是否计入值班占用 */
  countTheory: boolean
  /** 实验课（（实））是否计入值班占用 */
  countExperiment: boolean
  /** 最少连续值班节数（2026-09-11 增补）：>1 时孤立单节值班不被安排，默认 1 = 不限制 */
  minConsecutiveSections: number
  /**
   * 每日均衡（2026-09-13 增补）：在"不违反其他约束"的前提下尽量平均每日排班，
   * 避免出现某天无人值班。默认 true。
   * 见 ADR-002 第七节修订记录第 4 条。
   */
  balanceDaily: boolean
}

export const DEFAULT_WORKDAYS: number[] = [1, 2, 3, 4, 5]
/**
 * 默认上班节次（2026-09-13 修正）：**采用课程表的节次编号**——上午 1~4 节、下午 6~9 节。
 *
 * 修正原因（实测冲突）：课程表的节次是"数字 + 命名（中课/晚课）"混排的连续序列
 *   1,2,3,4,5,中课1,中课2,6,7,8,9,10,晚课,11,12,13
 * 而旧默认值把下午写成 8~11，导致同一节真实课程在两表中编号不同（课程表"第6节"
 * 是下午第一节，排班表却叫"第8节"）。算法按节号比区间时会漏判占用，**在学生上课
 * 时间排班**。现统一为课程表编号：下午第一节 = 第6节。节次序号轴见 utils/sectionOrder。
 */
export const DEFAULT_WORK_SECTIONS: WorkSection[] = [
  { start: 1, end: 4, label: '上午' },
  { start: 6, end: 9, label: '下午' },
]

/**
 * 各节次对应的上课时间（2026-09-13 增补，随节次编号对齐而修正）。
 *
 * 单一数据源：排班表页面与导出文件的"节次"文案都由这里推导，
 * 避免时间表在多处硬编码而漂移。键为课程表节次编号。
 */
export const SECTION_TIME: Record<number, string> = {
  1: '8:00~8:45',
  2: '8:50~9:35',
  3: '9:55~10:40',
  4: '10:45~11:30',
  6: '14:00~14:45',
  7: '14:50~15:35',
  8: '15:40~16:25',
  9: '16:45~17:30',
}

/**
 * 节次展示文案，如「上午 第1节 8:00~8:45」。
 * 未登记时间的节次（管理员自行添加的区间）退化为「上午 第5节」，不会输出空占位。
 */
export function formatSectionLabel(periodLabel: string, section: number): string {
  const time = SECTION_TIME[section]
  return `${periodLabel} 第${section}节${time ? ` ${time}` : ''}`
}

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
  balanceDaily: true,
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
  // 防御性去重（2026-09-13）：管理员若配置了重叠的节次区间（如 1~4 与 4~8），
  // 展开后会得到重复时段键，导致界面/导出出现重复行、未满足清单重复计数。
  // 配置校验已拦截重叠，这里再兜一层，保证算法输入本身是干净的。
  const seen = new Set<string>()
  for (const day of [...rules.workdays].sort((a, b) => a - b)) {
    for (const sec of rules.workSections) {
      for (let s = sec.start; s <= sec.end; s++) {
        const key = `c${s}`
        if (seen.has(`${day}|${key}`)) continue
        seen.add(`${day}|${key}`)
        slots.push({
          dayOfWeek: day,
          key,
          label: formatSectionLabel(sec.label, s),
          sectionStart: s,
          sectionEnd: s,
        })
      }
    }
  }
  return slots
}

/** 规则校验结果：field 便于定位，message 为可直接展示给用户的中文提示 */
export interface RuleIssue {
  field: string
  message: string
}

/**
 * 校验排班规则的一致性（2026-09-13 增补）。
 *
 * 为什么必须有这一层：非法规则（如 weekStart > weekEnd）此前不会被拦截，
 * scheduleAll 会**静默产出 0 周结果**——界面点"生成方案"毫无反应、写入按钮不可用，
 * 用户只会以为按钮坏了。配置页保存前校验与算法入口把关共用本函数，行为一致。
 *
 * 覆盖：排班周期、工时上下限、同时段人数上下限、工作日非空、
 * 上班节次区间合法且**互不重叠**。
 */
export function validateRules(rules: SchedulingRules): RuleIssue[] {
  const issues: RuleIssue[] = []
  if (rules.weekStart < 1 || rules.weekEnd < rules.weekStart)
    issues.push({ field: 'weekStart', message: '排班周期不合法（起 ≤ 止，且从第 1 周起）' })
  if (rules.weekEnd > 30) issues.push({ field: 'weekEnd', message: '排班周期不能超过第 30 周' })
  if (rules.minSectionsPerAssistant > rules.maxSectionsPerAssistant)
    issues.push({ field: 'maxSectionsPerAssistant', message: '每人最少工时不能大于最多工时' })
  if (rules.minPerSlot > rules.maxPerSlot)
    issues.push({ field: 'maxPerSlot', message: '同时段最少人数不能大于最多人数' })
  if (!Array.isArray(rules.workdays) || rules.workdays.length === 0)
    issues.push({ field: 'workdays', message: '至少选择一个工作日' })
  if (!Array.isArray(rules.workSections) || rules.workSections.length === 0) {
    issues.push({ field: 'workSections', message: '至少设置一个上班节次区间' })
  } else {
    for (const s of rules.workSections) {
      if (s.start < 1 || s.end > 13 || s.end < s.start) {
        issues.push({ field: 'workSections', message: `节次区间不合法：第 ${s.start}~${s.end} 节` })
      }
    }
    // 重叠检测：按起点排序后，后一段的起点不得落入前一段
    const sorted = [...rules.workSections].sort((a, b) => a.start - b.start)
    for (let i = 1; i < sorted.length; i++) {
      if (sorted[i].start <= sorted[i - 1].end) {
        issues.push({
          field: 'workSections',
          message: `上班节次区间不能重叠：第 ${sorted[i - 1].start}~${sorted[i - 1].end} 节与第 ${sorted[i].start}~${sorted[i].end} 节`,
        })
      }
    }
  }
  return issues
}

/** 供算法入口把关：规则不合法时抛出可直接展示的错误（宁可不排，也不静默产出空结果） */
export function assertRulesValid(rules: SchedulingRules): void {
  const issues = validateRules(rules)
  if (issues.length > 0) {
    throw new Error(`排班规则不合法：${issues.map((i) => i.message).join('；')}`)
  }
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
  // 2026-09-13 迁移：把存量配置里的旧默认"下午 8~11 节"对齐为课程表编号"下午 6~9 节"。
  // 只迁移与旧默认值完全一致的区间，避免误改管理员自定义的节次；不迁移会持续造成
  // "课程表第6节 vs 排班表第8节"的错配，进而在上课时间排班。
  r.workSections = r.workSections.map((s) =>
    s.start === 8 && s.end === 11 ? { ...s, start: 6, end: 9 } : s,
  )
  if (typeof r.uniformMode !== 'boolean') r.uniformMode = false
  if (typeof r.countTheory !== 'boolean') r.countTheory = true
  if (typeof r.countExperiment !== 'boolean') r.countExperiment = true
  if (typeof r.minConsecutiveSections !== 'number' || r.minConsecutiveSections < 1)
    r.minConsecutiveSections = 1
  if (typeof r.balanceDaily !== 'boolean') r.balanceDaily = true
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
  /**
   * 节次原文，如 "第三节-中课2"、"中课1-第七节"、"第六节-第八节"。
   * 算法经 `sectionOrdinalRange` 换算为**节次序号区间**后再与排班时段比较——
   * 不可直接用数字节号比较：课程表的节次是"数字节次 + 命名节次（中课/晚课）"混排，
   * 且排班表编号必须与课程表一致（见 utils/sectionOrder 与 DEFAULT_WORK_SECTIONS 的说明）。
   */
  sectionText: string
  /** 生效周次区间列表，如 [[1,4],[6,17]] 表示第 1~4 周和第 6~17 周有课 */
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

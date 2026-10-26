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
 * 校验排班规则的一致性与取值合法性（2026-09-13 增补；2026-10-26 S1 按 P06 收紧）。
 *
 * 为什么必须有这一层：非法规则（如 weekStart > weekEnd）此前不会被拦截，
 * scheduleAll 会**静默产出 0 周结果**——界面点"生成方案"毫无反应、写入按钮不可用，
 * 用户只会以为按钮坏了。配置页保存前校验与算法入口把关共用本函数，行为一致。
 *
 * 2026-10-26 收紧（审查 P06：负数上下限、星期 0/8、小数节次曾全部通过校验）：
 * 所有数值字段必须是整数且在语义范围内；工作日必须是 1~7；节次区间端点必须是整数。
 * "能排出来的数"才允许进入算法——类型系统不拦数值域，这一层就是数值域的唯一闸门。
 *
 * 覆盖：排班周期、工时上下限、同时段人数上下限、工作日非空、
 * 上班节次区间合法且**互不重叠**。
 */
export function validateRules(rules: SchedulingRules): RuleIssue[] {
  const issues: RuleIssue[] = []
  const int = (v: unknown): boolean => Number.isInteger(v)

  if (!int(rules.weekStart) || !int(rules.weekEnd) || rules.weekStart < 1 || rules.weekEnd < rules.weekStart)
    issues.push({ field: 'weekStart', message: '排班周期不合法（起 ≤ 止、均为整数，且从第 1 周起）' })
  if (int(rules.weekEnd) && rules.weekEnd > 30)
    issues.push({ field: 'weekEnd', message: '排班周期不能超过第 30 周' })

  if (!int(rules.minSectionsPerAssistant) || rules.minSectionsPerAssistant < 0)
    issues.push({ field: 'minSectionsPerAssistant', message: '每人最少值班节数必须是不小于 0 的整数' })
  if (!int(rules.maxSectionsPerAssistant) || rules.maxSectionsPerAssistant < 1)
    issues.push({ field: 'maxSectionsPerAssistant', message: '每人最多值班节数必须是不小于 1 的整数' })
  else if (int(rules.minSectionsPerAssistant) && rules.minSectionsPerAssistant > rules.maxSectionsPerAssistant)
    issues.push({ field: 'maxSectionsPerAssistant', message: '每人最少工时不能大于最多工时' })

  if (!int(rules.minPerSlot) || rules.minPerSlot < 0)
    issues.push({ field: 'minPerSlot', message: '同时段最少人数必须是不小于 0 的整数' })
  if (!int(rules.maxPerSlot) || rules.maxPerSlot < 1)
    issues.push({ field: 'maxPerSlot', message: '同时段最多人数必须是不小于 1 的整数' })
  else if (int(rules.minPerSlot) && rules.minPerSlot > rules.maxPerSlot)
    issues.push({ field: 'maxPerSlot', message: '同时段最少人数不能大于最多人数' })

  if (!int(rules.minConsecutiveSections) || rules.minConsecutiveSections < 1)
    issues.push({ field: 'minConsecutiveSections', message: '最少连续值班节数必须是不小于 1 的整数' })

  if (!Array.isArray(rules.workdays) || rules.workdays.length === 0) {
    issues.push({ field: 'workdays', message: '至少选择一个工作日' })
  } else {
    const bad = rules.workdays.filter((d) => !int(d) || d < 1 || d > 7)
    if (bad.length > 0)
      issues.push({
        field: 'workdays',
        message: `工作日不合法（应为 1~7 的整数）：${[...new Set(bad)].join('、')}`,
      })
  }

  if (!Array.isArray(rules.workSections) || rules.workSections.length === 0) {
    issues.push({ field: 'workSections', message: '至少设置一个上班节次区间' })
  } else {
    for (const s of rules.workSections) {
      if (!int(s.start) || !int(s.end) || s.start < 1 || s.end > 13 || s.end < s.start) {
        issues.push({ field: 'workSections', message: `节次区间不合法：第 ${s.start}~${s.end} 节（端点须为 1~13 的整数且起 ≤ 止）` })
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
 * 旧配置的数据质量警告（2026-10-26 增补，P07）：读取存量规则时调用，
 * 返回需要用户确认（"待核对"）的提示；返回空数组表示无需处理。
 * 当前识别：下午 8~11 节——2026-09-13 之前的旧默认，与课程表编号错配，
 * 但无法与用户刻意设置的同值自定义区分，因此不改写、只提示。
 */
export function rulesDataWarnings(saved: Partial<SchedulingRules> | null | undefined): string[] {
  const warnings: string[] = []
  if (saved && Array.isArray(saved.workSections)) {
    if (saved.workSections.some((s) => s?.start === 8 && s?.end === 11)) {
      warnings.push(
        '检测到"下午 8~11 节"配置：这是 2026-09-13 之前旧版本的默认值，与课程表编号（下午 6~9 节）错配，' +
          '但无法与刻意设置的自定义区间区分，故未自动改写。请确认后保存为"下午 6~9 节"或保留自定义。',
      )
    }
  }
  return warnings
}

/**
 * 校验助理的个性化值班节数（2026-09-13 增补）：
 * 非负、上限至少为 1、最少不得大于最多；未单独设置的助理不校验（跟随全局）。
 */
export function validateAssistantOverrides(
  assistants: Array<Pick<AssistantInput, 'id' | 'name' | 'minSections' | 'maxSections'>>,
): RuleIssue[] {
  const issues: RuleIssue[] = []
  for (const a of assistants) {
    const label = a.name ? `助理「${a.name}」` : `助理 #${a.id}`
    const hasMin = typeof a.minSections === 'number'
    const hasMax = typeof a.maxSections === 'number'
    if (hasMin && (a.minSections as number) < 0)
      issues.push({ field: 'assistant', message: `${label}的自定义最少值班节数不能为负` })
    if (hasMax && (a.maxSections as number) < 1)
      issues.push({ field: 'assistant', message: `${label}的自定义最多值班节数至少为 1` })
    if (hasMin && hasMax && (a.minSections as number) > (a.maxSections as number))
      issues.push({ field: 'assistant', message: `${label}的最少值班节数不能大于最多值班节数` })
  }
  return issues
}

/** 供算法入口把关：个性化覆盖不合法时抛出可直接展示的错误 */
export function assertAssistantOverridesValid(
  assistants: Array<Pick<AssistantInput, 'id' | 'name' | 'minSections' | 'maxSections'>>,
): void {
  const issues = validateAssistantOverrides(assistants)
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
  // 2026-10-26 修订（审查 P07）：**不再**把"下午 8~11 节"静默改写为 6~9。
  // 旧默认与恰好同值的自定义无法区分，按数值猜测改写会掩盖用户真实配置；
  // 歧义配置原样保留，由 rulesDataWarnings() 标记"待核对"交由用户确认
  //（配合 ScheduleConfigView 的警告条，见 FE 验收"歧义 8~11 不静默迁移"）。
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
  /**
   * 个性化值班节数下限（2026-09-13 增补），缺省跟随全局 rules.minSectionsPerAssistant。
   * 来自助理档案的 customMinSections。
   */
  minSections?: number
  /** 个性化值班节数上限，缺省跟随全局 rules.maxSectionsPerAssistant */
  maxSections?: number
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

/**
 * F08 的"保留手动调整"：重排前已确定的人岗。
 * 2026-10-26 修订（审查 P04）：显式携带 **weekNo**——某周的手动安排只对那周生效，
 * 不再被应用到整个排班周期。缺省（undefined）= 全周生效，仅为兼容旧调用方保留；
 * 新代码（ScheduleView 等）必须显式携带周次。
 */
export interface KeepEntry {
  /** 该手动安排所属周次；缺省 = 全部周生效（兼容旧数据/旧调用） */
  weekNo?: number
  dayOfWeek: number
  slotKey: string
  assistantId: number
}

/** 被拒绝的保留项：entry 原样 + 人可读原因（P01/P02/P04：拒绝必须给明细，不静默丢弃） */
export interface RejectedKeep extends KeepEntry {
  reason: string
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
  /** 生效的值班节数下限（含个性化覆盖），供展示"目标区间" */
  minSections: number
  /** 生效的值班节数上限（含个性化覆盖） */
  maxSections: number
  belowMin: boolean
  atMax: boolean
}

/** 单周排班结果 */
export interface ScheduleOutput {
  assignments: Assignment[]
  unmetSlots: UnmetSlot[]
  summaries: AssistantSummary[]
  /** 因课程冲突/时段上限/个人上限/模式不兼容等原因未被采纳的保留项（含原因） */
  rejectedKeeps: RejectedKeep[]
  /** 算法耗时（毫秒，用于 SRS 4.1 性能验证） */
  elapsedMs: number
}

export interface WeeklySchedule extends ScheduleOutput {
  weekNo: number
  /** uniform 模式下为 true：本周方案是复制的统一方案 */
  replicated?: boolean
}

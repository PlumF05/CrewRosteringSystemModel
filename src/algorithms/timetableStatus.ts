/**
 * 课表提交状态四分类（S1，2026-10-26，计划 §5.2 / FE-02）。
 *
 * 语义（严格区分，不能互相冒充）：
 * - ready           已导入课表，且全部节次可在"节次序号轴"上识别 → 可参与排班
 * - confirmed_empty 已显式确认无课（导入空课表，或老师在界面确认）→ 可参与排班
 * - needs_review    已导入课表，但存在无法识别的节次 → **不参与排班**，等待人工核对
 * - missing         从未导入课表 → **不参与排班**（"未提交课表不等于全天空闲"）
 *
 * 旧数据保守回填：没有状态标记的记录，若已存在课程行则视为 ready（说明确实提交过），
 * 否则视为 missing——可解释、不武断。
 *
 * 纯函数：不 import Vue/Dexie；判定"节次无法识别"与算法/评价器同一口径
 * （utils/sectionOrder 的序号轴，而非数字节号——中课/晚课是合法节次）。
 */
import { sectionOrdinalRange } from '../utils/sectionOrder'

/** 持久化在助理档案上的状态（missing 不落库，由缺省表示） */
export type TimetableStatusRecord = 'ready' | 'confirmed_empty' | 'needs_review'

/** 运行时完整四态 */
export type TimetableStatus = TimetableStatusRecord | 'missing'

/** 助理档案上可读到的状态字段形状 */
export interface TimetableStatusHolder {
  timetableStatus?: TimetableStatusRecord
}

/**
 * 运行时状态判定（含旧数据回填）。
 * @param assistant 助理档案（可能带也可能不带 timetableStatus）
 * @param hasCourses 该助理当前是否存在课程记录
 */
export function timetableStatusOf(
  assistant: TimetableStatusHolder,
  hasCourses: boolean,
): TimetableStatus {
  const s = assistant.timetableStatus
  if (s === 'ready' || s === 'confirmed_empty' || s === 'needs_review') return s
  // 保守回填：有课程记录 = 提交过课表 → ready；否则从未提交 → missing
  return hasCourses ? 'ready' : 'missing'
}

/** 该状态是否可参与自动排班 */
export function isSchedulableStatus(status: TimetableStatus): boolean {
  return status === 'ready' || status === 'confirmed_empty'
}

/** 状态的展示文案（界面/提示共用，避免多处硬编码漂移） */
export const TIMETABLE_STATUS_LABEL: Record<TimetableStatus, string> = {
  ready: '已导入',
  confirmed_empty: '确认无课',
  needs_review: '待核对',
  missing: '未导入',
}

/**
 * 导入完成时推导应持久化的状态：
 * - 空课表 → confirmed_empty（导入的文件本身就是"无课"的证据）
 * - 任一课程节次无法在序号轴上识别 → needs_review（P05：不能当"安全"）
 * - 否则 → ready
 */
export function deriveImportStatus(
  courses: Array<Pick<import('../utils/courseParser').ParsedCourse, 'sectionText'>>,
): TimetableStatusRecord {
  if (courses.length === 0) return 'confirmed_empty'
  return courses.some((c) => sectionOrdinalRange(c.sectionText) === null)
    ? 'needs_review'
    : 'ready'
}

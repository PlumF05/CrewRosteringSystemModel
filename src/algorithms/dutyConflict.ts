/**
 * 已写入排班与课程表的冲突检测（2026-09-13 增补，SRS F06 第 3 条）。
 *
 * 场景：导入课程表会**整体替换**该生课程；若此前已生成过排班，可能出现
 * "排班落在该生有课的节次上"却无人察觉（实测确认）。导入完成后据此检测并提示。
 *
 * 占用判定与排班算法完全一致：节次原文 → 节次序号 → 区间重叠，
 * 同样遵循"理论课/实验课是否计入占用"的规则开关。
 */
import { sectionOrdinal, sectionOrdinalRange } from '../utils/sectionOrder'
import { weekInRanges } from '../utils/weekParser'
import type { CourseKind } from '../db/schema'
import type { SchedulingRules } from './types'

export interface DutyConflict {
  /** 对应 duty_schedule 行的主键（供"删除冲突排班"使用） */
  id?: number
  weekNo: number
  dayOfWeek: number
  timeSlot: string
  assistantId: number
  /** 冲突的课程信息（用于向用户解释原因） */
  courseName: string
  sectionText: string
}

export interface ConflictCourse {
  assistantId: number
  kind?: CourseKind
  dayOfWeek: number
  courseName: string
  /** 节次原文（如 "第三节-中课2"） */
  sectionText: string
  weekRanges: [number, number][]
}

export interface ConflictDuty {
  id?: number
  weekNo: number
  dayOfWeek: number
  timeSlot: string
  assistantId: number
}

/**
 * 找出与课程表冲突的已写入排班。
 * 排班时段已单节化（timeSlot = c{节号}），故按"该节次的序号"与课程序号区间判重叠。
 */
export function findDutyConflicts(params: {
  rules: SchedulingRules
  assistantId: number
  courses: ConflictCourse[]
  duties: ConflictDuty[]
}): DutyConflict[] {
  const { rules, assistantId, courses, duties } = params
  const mine = courses.filter((c) => c.assistantId === assistantId)
  const out: DutyConflict[] = []

  for (const duty of duties) {
    const ord = sectionOrdinal(duty.timeSlot.replace(/^c/, ''))
    if (ord === null) continue // 键无法识别（历史遗留数据）→ 无法判定，不计入冲突
    for (const c of mine) {
      if (c.dayOfWeek !== duty.dayOfWeek) continue
      const isExp = (c.kind ?? 'theory') === 'experiment'
      if (isExp ? !rules.countExperiment : !rules.countTheory) continue
      if (!weekInRanges(duty.weekNo, c.weekRanges)) continue
      const range = sectionOrdinalRange(c.sectionText)
      if (range === null) continue // 节次原文无法识别 → 不妄判（与算法的保守方向相反：此处宁可少报，避免误导用户删错）
      if (range.start <= ord && range.end >= ord) {
        out.push({
          id: duty.id,
          weekNo: duty.weekNo,
          dayOfWeek: duty.dayOfWeek,
          timeSlot: duty.timeSlot,
          assistantId: duty.assistantId,
          courseName: c.courseName,
          sectionText: c.sectionText,
        })
        break // 同一时段命中一条课程即可
      }
    }
  }

  return out.sort(
    (a, b) => a.weekNo - b.weekNo || a.dayOfWeek - b.dayOfWeek || Number(a.timeSlot.slice(1)) - Number(b.timeSlot.slice(1)),
  )
}

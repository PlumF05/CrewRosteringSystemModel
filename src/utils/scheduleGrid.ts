/**
 * 排班网格的"行列骨架"推导（2026-09-13 增补，纯函数）。
 *
 * 解决的问题：此前网格的行（节次）与列（工作日）完全由**当前规则**推导，而已写入的
 * 排班用的是**写入当时规则**的节次键。管理员修改上班节次/工作日后直接导出，会出现
 * "排班数据还在库里，但表里全是 —"的隐身现象（实测确认）。
 *
 * 方案：行列取「当前规则 ∪ 已写入数据」的**并集**——
 *   - 规则内的节次照常显示并标注上课时间；
 *   - 数据里多出来的节次也会显示（标注其全局已知的上课时间），保证任何已写入数据都可见；
 *   - 工作日同理。
 * 供导出（scheduleExport）与排班表页面（ScheduleView）共用，避免两处口径不一致。
 */
import { formatSectionLabel, type SchedulingRules } from '../algorithms/types'

export interface GridKey {
  /** 时段键，如 c1、c7（无法识别格式的键原样保留） */
  key: string
  /** 行标题；均标注该节次已知的上课时间（来自 SECTION_TIME） */
  label: string
  /** 是否来自当前规则（规则内的排在前，便于稳定排序） */
  fromRules: boolean
}

const KEY_RE = /^c(\d+)$/

export const DAY_LABELS: Record<number, string> = {
  1: '星期一', 2: '星期二', 3: '星期三', 4: '星期四', 5: '星期五', 6: '星期六', 7: '星期日',
}

function periodLabelOf(rules: SchedulingRules, section: number): string {
  return rules.workSections.find((w) => section >= w.start && section <= w.end)?.label ?? ''
}

/**
 * 网格的行（节次）= 当前规则的节次 ∪ 已写入数据出现的节次，升序。
 * 每行都标注该节次的上课时间（来自 SECTION_TIME，属全局属性，与是否在当前规则内无关）。
 * 键格式异常（非 c{数字}）的行原样保留在末尾，绝不静默丢弃数据。
 */
export function collectGridKeys(
  rules: SchedulingRules,
  rows: Array<{ timeSlot: string }>,
): GridKey[] {
  const ruleSecs: number[] = []
  for (const sec of [...rules.workSections].sort((a, b) => a.start - b.start)) {
    for (let s = sec.start; s <= sec.end; s++) ruleSecs.push(s)
  }

  const dataSecs = new Set<number>()
  const rawKeys = new Set<string>()
  for (const r of rows) {
    const m = KEY_RE.exec(r.timeSlot)
    if (m) dataSecs.add(Number(m[1]))
    else if (r.timeSlot) rawKeys.add(r.timeSlot)
  }

  const keys: GridKey[] = []
  const secs = [...new Set([...ruleSecs, ...dataSecs])].sort((a, b) => a - b)
  for (const s of secs) {
    keys.push({
      key: `c${s}`,
      label: formatSectionLabel(periodLabelOf(rules, s), s).trim(),
      fromRules: ruleSecs.includes(s),
    })
  }
  for (const k of [...rawKeys].sort()) keys.push({ key: k, label: k, fromRules: false })
  return keys
}

/** 网格的列（工作日）= 当前规则的工作日 ∪ 已写入数据出现的工作日，升序 */
export function collectGridDays(
  rules: SchedulingRules,
  rows: Array<{ dayOfWeek: number }>,
): number[] {
  return [...new Set([...rules.workdays, ...rows.map((r) => r.dayOfWeek)])].sort((a, b) => a - b)
}

/**
 * 重排差异对比（SRS F08）：重排前后按"周-星期-节次-助理"四元组 diff。
 * 纯函数；三分类：added（新方案新增）/ removed（旧方案移除）/ unchanged（保持）。
 */
export interface DiffRow {
  dayOfWeek: number
  timeSlot: string
  assistantId: number
}

export type DiffType = 'added' | 'removed' | 'unchanged'

export interface DiffEntry extends DiffRow {
  type: DiffType
}

export interface WeekDiff {
  added: DiffEntry[]
  removed: DiffEntry[]
  unchanged: DiffEntry[]
}

const keyOf = (r: DiffRow) => `${r.dayOfWeek}|${r.timeSlot}|${r.assistantId}`

export function diffWeekSchedule(
  oldRows: DiffRow[],
  newRows: DiffRow[],
): WeekDiff {
  const oldKeys = new Map(oldRows.map((r) => [keyOf(r), r]))
  const newKeys = new Map(newRows.map((r) => [keyOf(r), r]))

  const added: DiffEntry[] = []
  const removed: DiffEntry[] = []
  const unchanged: DiffEntry[] = []

  for (const [k, r] of newKeys) {
    if (oldKeys.has(k)) unchanged.push({ ...r, type: 'unchanged' })
    else added.push({ ...r, type: 'added' })
  }
  for (const [k, r] of oldKeys) {
    if (!newKeys.has(k)) removed.push({ ...r, type: 'removed' })
  }

  const sortFn = (a: DiffEntry, b: DiffEntry) =>
    a.dayOfWeek - b.dayOfWeek ||
    Number(a.timeSlot.slice(1)) - Number(b.timeSlot.slice(1)) ||
    a.assistantId - b.assistantId
  added.sort(sortFn)
  removed.sort(sortFn)
  unchanged.sort(sortFn)
  return { added, removed, unchanged }
}

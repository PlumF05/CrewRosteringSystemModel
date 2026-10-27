/**
 * 命名快照服务（S3 第三片 / FE-16，2026-10-26，计划 §7）。
 *
 * 语义：
 * - **创建**：跨表只读事务取得一致快照——整份排班行 + 当时规则 + 人员显示信息
 *   （自包含：删除人员或改规则后，历史快照仍可读、可对比、可导出）；
 * - **对比**：快照 vs 当前，按周给出新增/移除（复用 scheduleDiff）；
 * - **受控恢复**：恢复前用独立评价器按**当前**人员/课程/规则复核快照内容——
 *   缺人（快照里的人已删除）或课程冲突时**阻止直接覆盖**并给出明细，只读查看不受限；
 *   合法则在单个 CAS 事务中替换快照覆盖的周，并重置撤销链（恢复后旧编辑链不再适用）。
 */
import { db } from './database'
import { operationLogRepo, now } from './repositories'
import { withDataRevision } from './dataRevision'
import { evaluateSchedule } from '../algorithms/evaluate'
import { normalizeRules, type Assignment, type CourseInput, type SchedulingRules } from '../algorithms/types'
import { diffWeekSchedule } from '../utils/scheduleDiff'
import { buildMultiWeekFileBuffer } from '../utils/scheduleExport'
import type { ExportTemplateStyle } from '../templates/types'
import type { ScheduleSnapshot } from './schema'

const ADJUST_JOURNAL_KEY = 'adjustJournal'

export async function createNamedSnapshot(label: string): Promise<number> {
  if (!label.trim()) throw new Error('快照名称不能为空')
  // 跨表只读事务：排班行 / 规则 / 人员显示信息取自同一一致视图
  const snap = await db.transaction('r', [db.duty_schedule, db.config, db.assistant], async () =>
    Promise.all([db.duty_schedule.toArray(), db.config.get('rules'), db.assistant.toArray()]),
  )
  const [rows, rulesEntry, assistants] = snap
  const id = await db.schedule_snapshot.add({
    label: label.trim(),
    createdAt: now(),
    data: structuredClone(rows),
    meta: {
      formatVersion: 2,
      rules: structuredClone(rulesEntry?.value ?? null),
      assistants: assistants.map((a) => ({ id: a.id!, name: a.name })),
    },
  })
  await operationLogRepo.add('snapshot.create', { label: label.trim(), rows: rows.length })
  return id
}

export async function listSnapshots(): Promise<ScheduleSnapshot[]> {
  return db.schedule_snapshot.orderBy('createdAt').reverse().toArray()
}

export async function deleteSnapshot(id: number): Promise<void> {
  await db.schedule_snapshot.delete(id)
  await operationLogRepo.add('snapshot.delete', { id })
}

/**
 * 历史快照导出（S5 / FE-18）：**固定信息**——排班行、当时规则、当时人员姓名
 * 全部取自快照 meta，不被当前规则/名单/数据变化重新解释；生成时间为快照创建时间。
 * 快照不保存联系方式 → 导出**永不**含电话（更不含学号/QQ）。
 * 旧格式快照（无 meta）按当前默认规则渲染并显示 #id 姓名。
 */
export function buildSnapshotExportBuffer(snapshot: ScheduleSnapshot, tpl?: ExportTemplateStyle): Uint8Array {
  const rules = normalizeRules((snapshot.meta?.rules as Partial<SchedulingRules> | undefined) ?? null)
  const nameById = new Map((snapshot.meta?.assistants ?? []).map((a) => [a.id, a.name]))
  const weeks = [...new Set(snapshot.data.map((r) => r.weekNo))]
    .sort((a, b) => a - b)
    .map((weekNo) => ({
      weekNo,
      rows: snapshot.data
        .filter((r) => r.weekNo === weekNo)
        .map((r) => ({ dayOfWeek: r.dayOfWeek, timeSlot: r.timeSlot, assistantId: r.assistantId })),
    }))
  return buildMultiWeekFileBuffer(
    {
      rules,
      nameById,
      phoneById: new Map<number, string>(),
      includePhone: false,
      generatedAt: new Date(snapshot.createdAt).toLocaleString('zh-CN'),
    },
    weeks,
    tpl,
  )
}

export interface SnapshotWeekDiff {
  weekNo: number
  added: number
  removed: number
}

/** 快照 vs 当前 的逐周差异（新增/移除计数；快照覆盖范围之外的周不列出） */
export async function snapshotDiff(id: number): Promise<SnapshotWeekDiff[]> {
  const snap = await db.schedule_snapshot.get(id)
  if (!snap) throw new Error('快照不存在')
  const weeks = [...new Set(snap.data.map((r) => r.weekNo))].sort((a, b) => a - b)
  const current = await db.duty_schedule.toArray()
  return weeks.map((weekNo) => {
    const before = snap.data.filter((r) => r.weekNo === weekNo)
    const after = current.filter((r) => r.weekNo === weekNo)
    const d = diffWeekSchedule(
      before.map((r) => ({ dayOfWeek: r.dayOfWeek, timeSlot: r.timeSlot, assistantId: r.assistantId })),
      after.map((r) => ({ dayOfWeek: r.dayOfWeek, timeSlot: r.timeSlot, assistantId: r.assistantId })),
    )
    return { weekNo, added: d.added.length, removed: d.removed.length }
  })
}

/** 恢复前置复核：快照内容在当前人员/课程/规则下是否合法（不合法给出明细） */
async function reviewSnapshotAgainstCurrent(
  snap: ScheduleSnapshot,
): Promise<{ ok: boolean; problems: string[] }> {
  const [assistants, courses] = await Promise.all([db.assistant.toArray(), db.course.toArray()])
  const rules = normalizeRules((snap.meta?.rules as Partial<SchedulingRules> | undefined) ?? null)
  const courseInputs: CourseInput[] = courses.map((c) => ({
    assistantId: c.assistantId,
    kind: c.kind ?? (c.note ? 'experiment' : 'theory'),
    courseName: c.courseName,
    dayOfWeek: c.dayOfWeek,
    sectionText: c.sectionText,
    weekRanges: c.weekRanges as [number, number][],
  }))
  const problems: string[] = []
  const weeks = [...new Set(snap.data.map((r) => r.weekNo))]
  const currentAssistantIds = new Set(assistants.map((a) => a.id))
  for (const w of weeks) {
    const rows = snap.data.filter((r) => r.weekNo === w)
    const assignments: Assignment[] = rows.map((r) => ({
      dayOfWeek: r.dayOfWeek,
      slotKey: r.timeSlot,
      assistantId: r.assistantId,
      source: r.source,
    }))
    const report = evaluateSchedule({
      rules,
      assistants: assistants.map((a) => ({
        id: a.id!,
        name: a.name,
        identity: a.identity,
        minSections: a.customMinSections,
        maxSections: a.customMaxSections,
      })),
      courses: courseInputs,
      weekNo: w,
      assignments,
      locks: rows
        .filter((r) => r.locked)
        .map((r) => ({ weekNo: w, dayOfWeek: r.dayOfWeek, slotKey: r.timeSlot, assistantId: r.assistantId })),
      continuityExceptions: rows
        .filter((r) => r.continuityExceptionReason)
        .map((r) => ({
          dayOfWeek: r.dayOfWeek,
          slotKey: r.timeSlot,
          assistantId: r.assistantId,
          reason: r.continuityExceptionReason!,
        })),
    })
    for (const v of report.violations) {
      const who = v.assistantId !== undefined && !currentAssistantIds.has(v.assistantId) ? '（该助理已被删除）' : ''
      problems.push(`第${w}周：${v.message}${who}`)
    }
  }
  return { ok: problems.length === 0, problems }
}

/**
 * 受控恢复：合法则在单个 CAS 事务中用快照替换其覆盖的周；
 * 不合法（缺人/课程冲突/超上限）则拒绝并返回明细——只读对比不受影响。
 */
export async function restoreSnapshot(
  id: number,
  expectedRevision: number | null,
): Promise<{ problems: string[] }> {
  const snap = await db.schedule_snapshot.get(id)
  if (!snap) throw new Error('快照不存在')
  const review = await reviewSnapshotAgainstCurrent(snap)
  if (!review.ok) return review

  await withDataRevision(
    expectedRevision,
    [db.duty_schedule, db.operation_log, db.config],
    async () => {
      const weeks = [...new Set(snap.data.map((r) => r.weekNo))]
      const ts = now()
      for (const w of weeks) {
        await db.duty_schedule.where('weekNo').equals(w).delete()
      }
      await db.duty_schedule.bulkAdd(
        snap.data.map((r) => ({ ...r, id: undefined, createdAt: ts, updatedAt: ts })),
      )
      // 恢复后旧编辑链不再适用（引用的行已被替换）——重置撤销/重做
      await db.config.put({ key: ADJUST_JOURNAL_KEY, value: { undo: [], redo: [] } })
      await operationLogRepo.add('snapshot.restore', {
        label: snap.label,
        weeks,
        rows: snap.data.length,
      })
    },
  )
  return { problems: [] }
}

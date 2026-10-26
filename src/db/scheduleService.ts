/**
 * 排班写库服务（S2，2026-10-26，FE-12 / 计划 §6）。
 *
 * 职责：把"全周期预览"落库这一个业务动作收口为**单个读写事务**——
 * 全部周的清空 + 写入、操作日志、dataRevision 递增，要么全部发生，要么全部不发生。
 * （审计 §5.2：此前 ScheduleView 逐周调用 replaceWeek，每周各自原子，
 * 中途失败会留下"前几周已更新、后几周还是旧方案"的部分更新状态。）
 *
 * 版本协议：调用方携带"预览生成时"的 dataRevision 作为 expectedRevision；
 * 中间发生过任何业务写入（另一窗口保存/导入/手调）都会使版本前进，本事务拒绝执行
 * （StaleDataError），由界面提示重新生成预览——旧预览不能覆盖新数据。
 */
import { db } from './database'
import { now } from './repositories'
import { withDataRevision } from './dataRevision'
import type { DutyStatus, DutySource } from './schema'

export interface SaveWeekInput {
  weekNo: number
  rows: Array<{
    dayOfWeek: number
    timeSlot: string
    assistantId: number
    status?: DutyStatus
    source?: DutySource
  }>
}

/**
 * 全周期原子保存。
 * @param weeks 各周完整安排（每行携带周内定位与来源）
 * @param expectedRevision 预览生成时的业务版本；null = 强制写（内部维护用）
 * @returns 新版本号
 */
export async function saveFullCycle(
  weeks: SaveWeekInput[],
  expectedRevision: number | null,
  meta: { weekRange: [number, number]; mode: 'uniform' | 'perWeek' },
): Promise<number> {
  const ts = now()
  const { revision } = await withDataRevision(
    expectedRevision,
    [db.duty_schedule, db.operation_log],
    async () => {
      for (const w of weeks) {
        await db.duty_schedule.where('weekNo').equals(w.weekNo).delete()
        await db.duty_schedule.bulkAdd(
          w.rows.map((r) => ({
            weekNo: w.weekNo,
            dayOfWeek: r.dayOfWeek,
            timeSlot: r.timeSlot,
            assistantId: r.assistantId,
            status: r.status ?? ('normal' as const),
            source: r.source ?? ('auto' as const),
            createdAt: ts,
            updatedAt: ts,
          })),
        )
      }
      const count = weeks.reduce((s, w) => s + w.rows.length, 0)
      await db.operation_log.add({
        operatedAt: ts,
        action: 'schedule.write',
        detail: { weeks: meta.weekRange, mode: meta.mode, count, atomic: true },
      })
    },
  )
  return revision
}

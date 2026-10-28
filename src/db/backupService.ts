/**
 * 备份与恢复服务（S5 第三片 / F05 / FE-19/20，2026-10-26，计划 §9）。
 *
 * 备份文件（.crsm-backup.json）：
 * - 版本化结构：助理/课程/当前排班/命名快照/规则与模板配置 + 格式元信息与**内容摘要**
 *  （FNV——只用于检错，不承诺加密或来源证明）；
 * - 导出在**跨表只读事务**取得一致快照，事务完成后才序列化与计算摘要；
 * - 完整备份含个人资料（电话/QQ/班级）——文件名与界面均明确标注；
 *   不包含原始 xlsx 文件（程序本就不长期保存原文件）。
 *
 * 恢复（受控四步）：
 *   解析与校验（未知版本拒绝/摘要比对/唯一键与引用检查）→ 展示范围与数量（UI）→
 *   当前数据存 recovery_backup 独立表（隔离，不随主数据清空）→
 *   单写事务替换业务数据 + 重置撤销链 + 业务版本前进。
 * 失败：替换事务回滚，原数据保持；恢复副本保留（作为额外保险）。
 * 红线：备份是纯数据 JSON——**不执行**其中任何代码（不 eval、不 new Function）。
 */
import { db } from './database'
import { operationLogRepo, now } from './repositories'
import { getDataRevision, withDataRevision } from './dataRevision'
import type { Assistant, Course, DutySchedule, ScheduleSnapshot } from './schema'

export const BACKUP_FORMAT_VERSION = 1

export interface BackupContent {
  assistants: Assistant[]
  courses: Course[]
  dutySchedule: DutySchedule[]
  scheduleSnapshots: ScheduleSnapshot[]
  config: Array<{ key: string; value: unknown }>
}

export interface BackupFile {
  formatVersion: number
  exportedAt: string
  /** 完整备份含个人资料（电话/QQ/班级）——展示层必须标注 */
  includesPersonalInfo: boolean
  dataRevision: number
  counts: { assistants: number; courses: number; dutySchedule: number; scheduleSnapshots: number }
  content: BackupContent
  /** 内容摘要（canonical JSON 的 FNV-1a）——检错用 */
  checksum: string
}

/** 恢复时不应从备份带入、而应重置/重建的 config 键 */
const RESET_CONFIG_KEYS = ['adjustJournal', 'dataRevision', 'scheduleWriteRevision']

function fnv1a(text: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h.toString(16)
}

/** 摘要只覆盖业务内容（元信息如 exportedAt 不参与——同内容不同时间导出摘要一致） */
function contentChecksum(c: BackupContent): string {
  const canonical = JSON.stringify({
    a: c.assistants,
    c: c.courses,
    d: c.dutySchedule,
    s: c.scheduleSnapshots,
    k: [...c.config].sort((x, y) => x.key.localeCompare(y.key)),
  })
  return fnv1a(canonical)
}

export interface BackupExport {
  json: string
  filename: string
  summary: { counts: BackupFile['counts']; includesPersonalInfo: boolean }
}

/** 创建备份：跨表只读事务取一致快照 → 事务外序列化与摘要 */
export async function createBackup(): Promise<BackupExport> {
  const snap = await db.transaction(
    'r',
    [db.assistant, db.course, db.duty_schedule, db.schedule_snapshot, db.config],
    async () =>
      Promise.all([
        db.assistant.toArray(),
        db.course.toArray(),
        db.duty_schedule.toArray(),
        db.schedule_snapshot.toArray(),
        db.config.toArray(),
      ]),
  )
  const [assistants, courses, dutySchedule, scheduleSnapshots, configAll] = snap
  // 派生数据（撤销链/版本计数）不进入备份内容——恢复侧统一重置/前进
  const content: BackupContent = {
    assistants,
    courses,
    dutySchedule,
    scheduleSnapshots,
    config: configAll.filter((e) => !RESET_CONFIG_KEYS.includes(e.key)),
  }
  const file: BackupFile = {
    formatVersion: BACKUP_FORMAT_VERSION,
    exportedAt: now(),
    includesPersonalInfo: assistants.some((a) => a.phone || a.qq),
    dataRevision: await getDataRevision(),
    counts: {
      assistants: assistants.length,
      courses: courses.length,
      dutySchedule: dutySchedule.length,
      scheduleSnapshots: scheduleSnapshots.length,
    },
    content,
    checksum: contentChecksum(content),
  }
  const d = new Date()
  const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}-${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}`
  return {
    json: JSON.stringify(file, null, 1),
    filename: `crsm-backup-${stamp}.json`,
    summary: { counts: file.counts, includesPersonalInfo: file.includesPersonalInfo },
  }
}

export interface BackupValidation {
  ok: boolean
  errors: string[]
  /** 校验通过时的摘要信息（供界面确认） */
  summary?: { counts: BackupFile['counts']; exportedAt: string; includesPersonalInfo: boolean }
}

/** 完整校验：结构/版本/摘要/唯一键/引用。任何一项不过即拒绝恢复。 */
export function validateBackup(json: string): BackupValidation {
  let file: BackupFile
  try {
    file = JSON.parse(json) as BackupFile
  } catch {
    return { ok: false, errors: ['不是有效的 JSON 文件'] }
  }
  const errors: string[] = []
  if (typeof file.formatVersion !== 'number') errors.push('缺少格式版本信息')
  else if (file.formatVersion > BACKUP_FORMAT_VERSION)
    errors.push(`备份来自更新版本的程序（v${file.formatVersion} > 本程序支持 v${BACKUP_FORMAT_VERSION}），请先升级程序再导入`)
  // 结构完整性：五个内容字段必须齐全且为数组——缺任一项时后续 .map 会抛异常，
  // 必须在这里拦截而不是让校验器崩溃（自查修复 2026-10-26：此前只检查了 assistants）
  if (
    !file.content ||
    !Array.isArray(file.content.assistants) ||
    !Array.isArray(file.content.courses) ||
    !Array.isArray(file.content.dutySchedule) ||
    !Array.isArray(file.content.scheduleSnapshots) ||
    !Array.isArray(file.content.config)
  ) {
    errors.push('备份结构不完整（缺少助理/课程/排班/快照/配置数据之一）')
  }
  if (errors.length > 0) return { ok: false, errors }

  const c = file.content
  // 摘要检错
  if (file.checksum !== contentChecksum(c)) errors.push('内容摘要不一致——文件可能已损坏或被篡改')
  // 唯一键
  const nos = c.assistants.map((a) => a.studentNo)
  if (new Set(nos).size !== nos.length) errors.push('存在重复学号')
  const dutyKeys = c.dutySchedule.map((r) => `${r.weekNo}|${r.dayOfWeek}|${r.timeSlot}|${r.assistantId}`)
  if (new Set(dutyKeys).size !== dutyKeys.length) errors.push('存在重复排班（同周同时段同人）')
  // 引用完整性
  const ids = new Set(c.assistants.map((a) => a.id))
  if (c.courses.some((x) => !ids.has(x.assistantId))) errors.push('存在课程引用了不存在的助理')
  if (c.dutySchedule.some((x) => !ids.has(x.assistantId))) errors.push('存在排班引用了不存在的助理')
  if (errors.length > 0) return { ok: false, errors }

  return {
    ok: true,
    errors: [],
    summary: {
      counts: {
        assistants: c.assistants.length,
        courses: c.courses.length,
        dutySchedule: c.dutySchedule.length,
        scheduleSnapshots: c.scheduleSnapshots.length,
      },
      exportedAt: file.exportedAt,
      includesPersonalInfo: file.includesPersonalInfo === true,
    },
  }
}

export interface RestoreResult {
  recovered: { assistants: number; courses: number; dutySchedule: number; scheduleSnapshots: number }
  recoveryBackupId: number
  newRevision: number
}

/**
 * 受控恢复。前提：调用方已用 validateBackup 校验并向用户展示过范围与数量。
 * 步骤：①当前数据存 recovery_backup（独立表隔离）②单写事务整体替换
 * ③重置撤销链、业务版本前进并记录来源日志。②失败 → 原数据保持（Dexie 回滚）。
 */
export async function restoreBackup(json: string): Promise<RestoreResult> {
  const v = validateBackup(json)
  if (!v.ok) throw new Error(`备份校验未通过：${v.errors.join('；')}`)
  const file = JSON.parse(json) as BackupFile
  const c = file.content

  // ① 独立恢复副本（不随主数据清空；保留最近 5 份）
  const [curAssistants, curCourses, curDuty, curSnaps, curConfig] = await db.transaction(
    'r',
    [db.assistant, db.course, db.duty_schedule, db.schedule_snapshot, db.config],
    async () =>
      Promise.all([
        db.assistant.toArray(),
        db.course.toArray(),
        db.duty_schedule.toArray(),
        db.schedule_snapshot.toArray(),
        db.config.toArray(),
      ]),
  )
  const recoveryBackupId = await db.recovery_backup.add({
    createdAt: now(),
    reason: '恢复备份前的当前数据副本',
    payload: {
      assistants: curAssistants,
      courses: curCourses,
      dutySchedule: curDuty,
      scheduleSnapshots: curSnaps,
      config: curConfig,
    },
  })
  const oldCopies = await db.recovery_backup.orderBy('createdAt').toArray()
  if (oldCopies.length > 5) {
    await db.recovery_backup.bulkDelete(oldCopies.slice(0, oldCopies.length - 5).map((x) => x.id!))
  }

  // ② 单写事务整体替换（保留原 id——引用一致）
  const { revision } = await withDataRevision(
    null,
    [db.assistant, db.course, db.duty_schedule, db.schedule_snapshot, db.config, db.operation_log],
    async () => {
      await db.assistant.clear()
      await db.course.clear()
      await db.duty_schedule.clear()
      await db.schedule_snapshot.clear()
      await db.assistant.bulkAdd(c.assistants)
      await db.course.bulkAdd(c.courses)
      await db.duty_schedule.bulkAdd(c.dutySchedule)
      await db.schedule_snapshot.bulkAdd(c.scheduleSnapshots)
      // config：清掉业务键后按备份恢复（rules/templates 等），派生键重置
      for (const key of await db.config.toCollection().primaryKeys()) {
        await db.config.delete(key as string)
      }
      for (const e of c.config) await db.config.put({ key: e.key, value: e.value })
      await db.config.put({ key: 'adjustJournal', value: { undo: [], redo: [] } }) // 撤销链不适用于恢复后的数据
      await db.config.put({ key: 'scheduleWriteRevision', value: (await getDataRevision()) + 1 })
      await operationLogRepo.add('backup.restore', {
        exportedAt: file.exportedAt,
        counts: v.summary?.counts,
        recoveryBackupId,
      })
    },
  )

  // ③ 恢复后重新加载校验（记录数一致；学号唯一由索引兜底）
  const after = {
    assistants: await db.assistant.count(),
    courses: await db.course.count(),
    dutySchedule: await db.duty_schedule.count(),
    scheduleSnapshots: await db.schedule_snapshot.count(),
  }
  if (
    after.assistants !== c.assistants.length ||
    after.courses !== c.courses.length ||
    after.dutySchedule !== c.dutySchedule.length ||
    after.scheduleSnapshots !== c.scheduleSnapshots.length
  ) {
    throw new Error('恢复后校验失败：记录数与备份不一致（原数据已存恢复副本，可联系支持）')
  }

  return { recovered: after, recoveryBackupId, newRevision: revision }
}

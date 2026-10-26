/**
 * 批量导入服务（S2 / F05 / FE-05，2026-10-26）。
 *
 * 语义（计划 §8）：
 * - **逐文件顺序处理**（不并发读盘，读完一个释放一个），每个文件独立成败——
 *   合法文件照常自动归档，损坏/无法归属的文件只影响它自己；
 * - **同内容重复**：同一批次中内容完全一致（字节摘要一致）的后续文件跳过，
 *   不重复导入也不报错成"失败"；
 * - **不同内容争同一学生**：两个不同文件归属到同一学号时，**后者明确报冲突**，
 *   不按完成先后静默覆盖（先到者生效；用户应人工核对后自行选择重导哪个）；
 * - 批次限制：文件数与单文件大小有上限，超限整体拒绝。
 *
 * 每个文件的落库沿用 importTimetableForStudent 的单事务原子语义（V-011）。
 */
import { importTimetableForStudent } from './importService'
import { parseTimetableWorkbook } from '../utils/courseParser'
import { deriveImportStatus } from '../algorithms/timetableStatus'

export interface BatchFileInput {
  fileName: string
  data: Uint8Array
}

export type BatchItemStatus = 'ok' | 'failed' | 'skipped'

export interface BatchItemResult {
  fileName: string
  status: BatchItemStatus
  /** 人可读结论（一句话） */
  message: string
  studentName?: string
  studentNo?: string
  action?: 'created' | 'updated'
  courseCount?: number
  timetableStatus?: string
}

export const BATCH_LIMITS = {
  maxFiles: 50,
  maxFileBytes: 10 * 1024 * 1024,
}

/** 字节摘要（FNV-1a）：只用于同批次重复检测，不承诺加密强度 */
function contentHash(data: Uint8Array): string {
  let h = 0x811c9dc5
  for (let i = 0; i < data.length; i++) {
    h ^= data[i]
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return `${data.length.toString(16)}-${h.toString(16)}`
}

/** 单文件身份推导（与 CoursesView 单文件路径同一规则） */
function deriveIdentity(courses: Array<{ identity?: string }>): 'undergrad' | 'graduate' {
  return courses.some((c) => c.identity === 'graduate') ? 'graduate' : 'undergrad'
}

export async function importTimetableBatch(
  files: BatchFileInput[],
): Promise<BatchItemResult[]> {
  if (files.length === 0) return []
  if (files.length > BATCH_LIMITS.maxFiles) {
    throw new Error(`单次批量最多 ${BATCH_LIMITS.maxFiles} 个文件（当前 ${files.length} 个），请分批导入`)
  }

  const seenHash = new Map<string, string>() // 摘要 → 首次出现的文件名
  const ownerByStudentNo = new Map<string, string>() // 学号 → 首次成功导入的文件名
  const results: BatchItemResult[] = []

  for (const f of files) {
    if (f.data.byteLength > BATCH_LIMITS.maxFileBytes) {
      results.push({
        fileName: f.fileName,
        status: 'failed',
        message: `文件过大（${(f.data.byteLength / 1024 / 1024).toFixed(1)} MB > 上限 10 MB）`,
      })
      continue
    }

    const hash = contentHash(f.data)
    const firstSeen = seenHash.get(hash)
    if (firstSeen !== undefined) {
      results.push({
        fileName: f.fileName,
        status: 'skipped',
        message: `与「${firstSeen}」内容完全一致，已跳过（重复文件）`,
      })
      continue
    }
    seenHash.set(hash, f.fileName)

    // 解析：损坏/非课程表文件只影响自己
    let parsed: ReturnType<typeof parseTimetableWorkbook>
    try {
      parsed = parseTimetableWorkbook(f.data)
    } catch (e) {
      results.push({
        fileName: f.fileName,
        status: 'failed',
        message: e instanceof Error ? `无法解析：${e.message}` : '文件损坏或不是有效的 xlsx',
      })
      continue
    }

    if (!parsed.studentNo || !parsed.studentName) {
      results.push({
        fileName: f.fileName,
        status: 'failed',
        message: '未识别到"学生：姓名(学号)"，无法自动归属',
      })
      continue
    }

    const owner = ownerByStudentNo.get(parsed.studentNo)
    if (owner !== undefined) {
      results.push({
        fileName: f.fileName,
        status: 'failed',
        message: `与「${owner}」归属同一学号 ${parsed.studentNo}，但内容不同——已拒绝以避免覆盖，请人工核对后选择保留哪份`,
        studentNo: parsed.studentNo,
      })
      continue
    }

    try {
      const outcome = await importTimetableForStudent({
        studentName: parsed.studentName,
        studentNo: parsed.studentNo,
        identity: deriveIdentity(parsed.courses),
        courses: parsed.courses,
      })
      ownerByStudentNo.set(parsed.studentNo, f.fileName)
      const status = outcome.timetableStatus ?? deriveImportStatus(parsed.courses)
      const statusText =
        status === 'needs_review' ? '（含待核对节次）' : status === 'confirmed_empty' ? '（确认无课）' : ''
      results.push({
        fileName: f.fileName,
        status: 'ok',
        message: `${outcome.action === 'created' ? '新建助理' : '更新已有助理'}，导入 ${outcome.courseCount} 条课程${statusText}`,
        studentName: parsed.studentName,
        studentNo: parsed.studentNo,
        action: outcome.action,
        courseCount: outcome.courseCount,
        timetableStatus: status,
      })
    } catch (e) {
      results.push({
        fileName: f.fileName,
        status: 'failed',
        message: e instanceof Error ? `导入失败：${e.message}` : '导入失败',
        studentNo: parsed.studentNo,
      })
    }
  }

  return results
}

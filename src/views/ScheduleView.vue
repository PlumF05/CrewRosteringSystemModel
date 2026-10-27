<script setup lang="ts">
/**
 * 排班表页（SRS F01，2026-09-11 修订版）：
 *   一次性生成全部周方案（scheduleAll）→ 汇总 + 逐周预览 → 一次性写入全部周。
 *
 * 数据流（T-008 原则）：Dexie 读出的数据在构造算法输入时逐字段重建纯对象；
 * 算法输出写库时同样逐字段构造，杜绝响应式 Proxy 跨界。
 * F08 预留：手动调整记录（source=manual）作为 keep 传给算法保留。
 */
import { computed, onMounted, ref } from 'vue'
import { QuestionFilled } from '@element-plus/icons-vue'
import { assistantRepo, configRepo, courseRepo, dutyScheduleRepo } from '../db/repositories'
import type { DutySchedule } from '../db/schema'
import {
  normalizeRules,
  type SchedulingRules,
  type WeeklySchedule,
} from '../algorithms/types'
import { isSchedulableStatus, timetableStatusOf } from '../algorithms/timetableStatus'
import { saveFullCycle } from '../db/scheduleService'
import { StaleDataError, getDataRevision } from '../db/dataRevision'
import { incrementalSchedule, type DiffEntry } from '../algorithms/incremental'
import { ScheduleWorkerClient } from '../workers/scheduleClient'
import type { ScheduleJobResult } from '../workers/scheduleJob'
import { getActiveExportTemplate } from '../templates/templateService'
import ManualAdjustDialog from '../components/ManualAdjustDialog.vue'
import ScheduleSnapshotsCard from '../components/ScheduleSnapshotsCard.vue'
import { getAdjustHistory, undoRedoAdjust, type AdjustHistory } from '../db/manualAdjustService'
import { buildScheduleFileBuffer, buildMultiWeekFileBuffer, exportScheduleFile, scheduleFileName, type ExportInput } from '../utils/scheduleExport'
import { isTauri, saveXlsx } from '../utils/fileAccess'
import { diffWeekSchedule } from '../utils/scheduleDiff'
import {
  collectGridDays,
  collectGridKeys,
  DAY_LABELS as GRID_DAY_LABELS,
  type GridKey,
} from '../utils/scheduleGrid'

const rules = ref<SchedulingRules>(JSON.parse(JSON.stringify(normalizeRules(null))))
const weekNo = ref(1)
/** 全部周的方案（尚未写入） */
const previews = ref<WeeklySchedule[]>([])
/** 预览区当前查看的周 */
const previewWeek = ref<number>()
/** 本次预览所基于的业务数据版本（写入时 CAS 校验，防旧预览覆盖新数据） */
const previewedRevision = ref<number>(0)
const writing = ref(false)

/** S4 重排模式与增量差异（FE-13） */
const rescheduleMode = ref<'full' | 'incremental'>('full')
const targetWeekStart = ref(rules.value.weekStart)
const targetWeekEnd = ref(rules.value.weekEnd)
const incrementalDiff = ref<DiffEntry[]>([])
const zeroChange = ref(false)

/** S4 Worker 客户端与进度（FE-15）：Worker 只计算不写库；取消/超时零改动 */
const scheduleClient = new ScheduleWorkerClient()
const progressPercent = ref(0)
const progressMsg = ref('')
function cancelGenerate() {
  scheduleClient.cancel()
}

/** S5 多周导出（FE-18）：把已写入的全部周合成一个工作簿（每周一个 sheet） */
const exportingMulti = ref(false)
async function doExportMultiWeek() {
  exportingMulti.value = true
  try {
    const activeExport = await getActiveExportTemplate()
    const weeks: Array<{ weekNo: number; rows: Array<{ dayOfWeek: number; timeSlot: string; assistantId: number }> }> = []
    for (let w = rules.value.weekStart; w <= rules.value.weekEnd; w++) {
      const rows = (await dutyScheduleRepo.listByWeek(w)).map((r) => ({
        dayOfWeek: r.dayOfWeek,
        timeSlot: r.timeSlot,
        assistantId: r.assistantId,
      }))
      if (rows.length > 0) weeks.push({ weekNo: w, rows })
    }
    if (weeks.length === 0) {
      ElMessage.error('当前周期内没有已写入的排班，无法导出')
      return
    }
    const y = new Date()
    const stamp = `${y.getFullYear()}${String(y.getMonth() + 1).padStart(2, '0')}${String(y.getDate()).padStart(2, '0')}`
    const fileName = `排班表-第${weeks[0].weekNo}-${weeks[weeks.length - 1].weekNo}周-${stamp}.xlsx`
    const buffer = buildMultiWeekFileBuffer(
      {
        rules: JSON.parse(JSON.stringify(rules.value)),
        nameById: nameById.value,
        phoneById: phoneById.value,
        includePhone: exportIncludePhone.value,
      },
      weeks,
      activeExport.style,
    )
    const saved = await saveXlsx(fileName, buffer)
    if (saved) {
      ElMessage.success(`已保存 ${fileName}（${weeks.length} 个周 sheet）`)
      return
    }
    if (isTauri) return
    // 浏览器回退
    const blob = new Blob([buffer.buffer as ArrayBuffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = fileName
    a.click()
    URL.revokeObjectURL(url)
    ElMessage.success(`已生成 ${fileName}`)
  } catch (err) {
    ElMessage.error(err instanceof Error ? err.message : '导出失败')
  } finally {
    exportingMulti.value = false
  }
}

/** S3 撤销/重做（FE-10）：编辑链状态随刷新恢复；操作走 CAS */
const adjustHistory = ref<AdjustHistory>({ canUndo: false, canRedo: false, undoLabels: [], redoLabels: [] })
const undoingRedoing = ref(false)

async function undoRedo(direction: 'undo' | 'redo') {
  undoingRedoing.value = true
  try {
    const r = await undoRedoAdjust(direction, await getDataRevision())
    if (r) ElMessage.success(`${direction === 'undo' ? '已撤销' : '已重做'}：${r.label}`)
    else ElMessage.info('没有可' + (direction === 'undo' ? '撤销' : '重做') + '的调整（部分历史可能已被重排覆盖并跳过）')
  } catch (err) {
    if (err instanceof StaleDataError) {
      ElMessage.error('数据已被其他窗口修改，请稍后重试')
      return
    }
    ElMessage.error(err instanceof Error ? err.message : '操作失败')
  } finally {
    undoingRedoing.value = false
    await loadWeek()
    await loadAdjustHistory()
  }
}

async function loadAdjustHistory() {
  adjustHistory.value = await getAdjustHistory()
}

/** S3 手动调整（FE-08）：点击已写入网格的格子打开调整对话框 */
const adjustVisible = ref(false)
const adjustContext = ref<{ dayOfWeek: number; slotKey: string; label: string } | null>(null)
function openAdjust(slotKey: string, label: string, dayOfWeek: number) {
  adjustContext.value = { dayOfWeek, slotKey, label }
  adjustVisible.value = true
}
async function onAdjustChanged() {
  await loadWeek()
  await loadAdjustHistory()
}

/** 快照恢复后：刷新排班与撤销链（数据已被替换） */
async function onSnapRestored() {
  await loadWeek()
  await loadAdjustHistory()
}
const generating = ref(false)
const exporting = ref(false)
/** 当前查看周已落库的排班 */
const storedRows = ref<DutySchedule[]>([])
const nameById = ref<Map<number, string>>(new Map())
/** 2026-09-13 修订：导出只携带"电话"这一项个人信息，故只维护电话映射 */
const phoneById = ref<Map<number, string>>(new Map())
/** 生成方案那一刻的"重排前"数据（按周快照，供 F08 差异对比） */
const beforeRowsMap = ref<Map<number, DutySchedule[]>>(new Map())

const weekOptions = computed(() => {
  const arr: number[] = []
  for (let w = rules.value.weekStart; w <= rules.value.weekEnd; w++) arr.push(w)
  return arr
})


/** 当前预览选中的周方案 */
const currentPreview = computed(() =>
  previews.value.find((w) => w.weekNo === (previewWeek.value ?? previews.value[0]?.weekNo)),
)

onMounted(async () => {
  const saved = await configRepo.get<SchedulingRules>('rules')
  rules.value = normalizeRules(saved)
  weekNo.value = rules.value.weekStart
  const assistants = await assistantRepo.list()
  nameById.value = new Map(assistants.map((a) => [a.id!, a.name]))
  phoneById.value = new Map(assistants.map((a) => [a.id!, a.phone ?? '']))
  await loadWeek()
  // S3：刷新后验证编辑链并恢复撤销/重做按钮（失效条目在实际操作时自动跳过）
  await loadAdjustHistory()
})

async function loadWeek() {
  storedRows.value = await dutyScheduleRepo.listByWeek(weekNo.value)
}

/**
 * 切换查看周次：**先清空再加载**。此前是不 await 的浮动 Promise 且无 catch，
 * 读库失败时 storedRows 会保留上一周的数据、而表头已换成新周次——
 * 界面把旧周排班当新周展示，属静默数据错配。
 */
async function onWeekChange() {
  previews.value = []
  previewWeek.value = undefined
  storedRows.value = []
  try {
    await loadWeek()
  } catch (err) {
    ElMessage.error(err instanceof Error ? err.message : '读取排班失败')
  }
}

  async function generate() {
  generating.value = true
  try {
    const rows = await assistantRepo.list()
    if (rows.length === 0) {
      ElMessage.error('请先在"助理管理"中添加助理')
      return
    }
    const courses = (await courseRepo.all()).map((c) => ({
      assistantId: c.assistantId,
      kind: c.kind ?? (c.note ? 'experiment' : 'theory'),
      dayOfWeek: c.dayOfWeek,
      // 传节次原文：算法据此换算"节次序号"判占用，避免与排班表编号错配（2026-09-13）
      sectionText: c.sectionText,
      weekRanges: c.weekRanges.map(([s, e]) => [s, e] as [number, number]),
    }))
    // S1 四分类（2026-10-26）：未导入课表（missing）与待核对（needs_review）的助理
    // 不参与自动排班——"未提交课表不等于全天空闲"；排除原因明确告知，不静默跳过。
    const courseCountBy = new Map<number, number>()
    for (const c of courses) courseCountBy.set(c.assistantId, (courseCountBy.get(c.assistantId) ?? 0) + 1)
    const excluded: string[] = []
    const schedulableRows = rows.filter((a) => {
      const st = timetableStatusOf(a, (courseCountBy.get(a.id!) ?? 0) > 0)
      const ok = isSchedulableStatus(st)
      if (!ok) {
        excluded.push(`「${a.name}」${st === 'missing' ? '未导入课表' : '课表含无法识别的节次（待核对）'}`)
      }
      return ok
    })
    if (schedulableRows.length === 0) {
      ElMessage.error('没有可参与排班的助理：请先在「课程管理」导入课表，或在「助理管理」确认无课')
      return
    }
    if (excluded.length > 0) {
      ElMessage.warning(`已排除 ${excluded.length} 人（未参与本次排班）：${excluded.join('；')}`)
    }
    const schedulableIds = new Set(schedulableRows.map((a) => a.id!))
    const assistants = schedulableRows.map((a) => ({
      id: a.id!,
      name: a.name,
      identity: a.identity,
      // 个性化值班节数（2026-09-13 增补）：未设置的助理在算法内跟随全局默认
      minSections: a.customMinSections,
      maxSections: a.customMaxSections,
    }))
    // F08：快照"重排前"数据（逐周读库），供差异对比
    beforeRowsMap.value = new Map()
    for (let w = rules.value.weekStart; w <= rules.value.weekEnd; w++) {
      beforeRowsMap.value.set(w, await dutyScheduleRepo.listByWeek(w))
    }

    // ---- S4：全量 / 增量 两种重排模式（FE-13），全量经 Web Worker（FE-15） ----
    const pureRules = JSON.parse(JSON.stringify(rules.value))
    let rejectedAll: { weekNo?: number; dayOfWeek: number; slotKey: string; reason: string }[] = []
    if (rescheduleMode.value === 'incremental') {
      if (rules.value.uniformMode) {
        ElMessage.error('增量重排需要"各周独立"模式：请先到排班规则改为各周独立，或使用全量重排')
        return
      }
      const baseline = Array.from(beforeRowsMap.value.values())
        .flat()
        .filter((r) => schedulableIds.has(r.assistantId))
        .map((r) => ({
          weekNo: r.weekNo,
          dayOfWeek: r.dayOfWeek,
          slotKey: r.timeSlot,
          assistantId: r.assistantId,
          source: r.source,
          locked: r.locked,
        }))
      // 零改动判定：写入后无任何业务写入（版本未前进）
      const cur = await getDataRevision()
      const writeRev = await configRepo.get<number>('scheduleWriteRevision')
      const result = incrementalSchedule(
        { rules: pureRules, assistants, courses },
        baseline,
        {
          inputsUnchanged: writeRev !== undefined && cur === writeRev,
          targetWeeks: [targetWeekStart.value, targetWeekEnd.value],
        },
      )
      previews.value = result.weeks
      incrementalDiff.value = result.diff.filter((d) => d.type !== 'kept')
      zeroChange.value = result.zeroChange
      rejectedAll = result.rejectedKeeps
      if (result.zeroChange) {
        ElMessage.success('输入未变化且当前方案合法：本次增量重排保持零改动')
      }
    } else {
      incrementalDiff.value = []
      zeroChange.value = false
      // F08/S3：全量模式的保留项 = 锁定项（手动默认锁定；旧数据 manual 行回填为锁定）。
      const keep = Array.from(beforeRowsMap.value.values())
        .flat()
        .filter(
          (r) =>
            (r.locked === true || (r.source === 'manual' && r.locked === undefined)) &&
            schedulableIds.has(r.assistantId),
        )
        .map((r) => ({
          weekNo: r.weekNo,
          dayOfWeek: r.dayOfWeek,
          slotKey: r.timeSlot,
          assistantId: r.assistantId,
        }))
      // S4（FE-15）：生成 + 局部改良 + 独立校验全部在 Web Worker 执行——
      // 主线程只收进度与结果；取消/超时（默认 30s）终止计算，当前排班零改动。
      progressPercent.value = 0
      progressMsg.value = '正在启动计算…'
      const job = await new Promise<ScheduleJobResult | null>((resolve) => {
        scheduleClient.run(
          { rules: pureRules, assistants, courses, keep },
          {
            onProgress: (p) => {
              progressPercent.value = p.percent
              progressMsg.value = p.message
            },
            onDone: (r) => resolve(r),
            onCancelled: (reason) => {
              ElMessage[reason === 'timeout' ? 'error' : 'info'](
                reason === 'timeout' ? '计算超时已终止（当前排班未受影响），请缩小范围后重试' : '已取消计算（当前排班未受影响）',
              )
              resolve(null)
            },
            onError: (m) => {
              ElMessage.error(m)
              resolve(null)
            },
          },
        )
      })
      progressPercent.value = 0
      progressMsg.value = ''
      if (job === null) return // 已取消/超时/出错——不产生预览，数据零改动
      if (!job.legal) {
        ElMessage.error('生成的方案未通过独立终态校验（不应发生），已放弃本次结果——请反馈此问题')
        return
      }
      previews.value = job.weeks
      rejectedAll = job.weeks.flatMap((w) => w.rejectedKeeps)
    }
    previewWeek.value = previews.value[0]?.weekNo
    // 记录预览所基于的业务版本：写入时若版本已前进（期间有导入/保存/手调）则拒绝
    previewedRevision.value = await getDataRevision()
    // P01/P02/P04 的用户反馈面：被拒绝的保留项逐条给出原因，不静默丢弃
    const rejected = rejectedAll.map((k) => `第${k.weekNo ?? '?'}周 星期${k.dayOfWeek} ${k.slotKey}：${k.reason}`)
    if (rejected.length > 0) {
      ElMessage.warning(`有 ${rejected.length} 条手动安排无法保留：${rejected[0]}${rejected.length > 1 ? ' 等' : ''}`)
    }
  } catch (err) {
    // 规则不合法等确定性错误直接可见（validateRules 已在算法入口把关）
    ElMessage.error(err instanceof Error ? err.message : '生成排班失败')
  } finally {
    generating.value = false
  }
}

/** F08：重排前后差异（当前预览周）。Assignment.slotKey → DiffRow.timeSlot 映射 */
const weekDiff = computed(() => {
  const w = currentPreview.value
  if (!w) return null
  const toDiffRow = (a: { dayOfWeek: number; slotKey: string; assistantId: number }) => ({
    dayOfWeek: a.dayOfWeek,
    timeSlot: a.slotKey,
    assistantId: a.assistantId,
  })
  return diffWeekSchedule(
    (beforeRowsMap.value.get(w.weekNo) ?? []).map((r) => ({
      dayOfWeek: r.dayOfWeek,
      timeSlot: r.timeSlot,
      assistantId: r.assistantId,
    })),
    w.assignments.map(toDiffRow),
  )
})

function weekChangeLabel(w: WeeklySchedule): string {
  const before = beforeRowsMap.value.get(w.weekNo) ?? []
  const d = diffWeekSchedule(
    before.map((r) => ({ dayOfWeek: r.dayOfWeek, timeSlot: r.timeSlot, assistantId: r.assistantId })),
    w.assignments.map((a) => ({ dayOfWeek: a.dayOfWeek, timeSlot: a.slotKey, assistantId: a.assistantId })),
  )
  if (d.added.length === 0 && d.removed.length === 0) return '不变'
  return `+${d.added.length} / -${d.removed.length}`
}

/**
 * 导出时是否自动填入联系电话（2026-09-13 修订）。
 * 默认 true —— 导出即刻完成，不需要二次确认；且**只含"电话"这一项个人信息**。
 */
const exportIncludePhone = ref(true)

/** 导出当前查看周的排班表（联系电话默认自动填充）。
 *  Tauri 桌面端：弹系统「另存为」对话框写入所选路径；浏览器：回退为直接下载。 */
async function doExport() {
  if (storedRows.value.length === 0) {
    ElMessage.error(`第 ${weekNo.value} 周暂无排班记录，无法导出`)
    return
  }
  exporting.value = true
  try {
    const fileName = scheduleFileName(weekNo.value)
    // S5/FE-17：版式来自启用中的导出模板（学院默认版 / 简洁打印版 / 自定义）
    const activeExport = await getActiveExportTemplate()
    const input: ExportInput = {
      weekNo: weekNo.value,
      rules: JSON.parse(JSON.stringify(rules.value)),
      rows: storedRows.value.map((r) => ({
        dayOfWeek: r.dayOfWeek,
        timeSlot: r.timeSlot,
        assistantId: r.assistantId,
      })),
      nameById: nameById.value,
      phoneById: phoneById.value,
      includePhone: exportIncludePhone.value,
    }
    // Tauri：系统"另存为"对话框；用户取消（false）时静默结束
    const saved = await saveXlsx(fileName, buildScheduleFileBuffer(input, activeExport.style))
    if (saved) {
      ElMessage.success(
        exportIncludePhone.value
          ? `已保存 ${fileName}（排班表已填入值班人联系电话，不含学号/QQ）`
          : `已保存 ${fileName}（不含联系电话）`,
      )
      return
    }
    if (isTauri) return
    // 浏览器回退：直接触发下载
    exportScheduleFile(input, fileName, activeExport.style)
    ElMessage.success(
      exportIncludePhone.value
        ? `已生成 ${fileName}（排班表已填入值班人联系电话，不含学号/QQ）`
        : `已生成 ${fileName}（不含联系电话）`,
    )
  } catch (err) {
    ElMessage.error(err instanceof Error ? err.message : '导出失败')
  } finally {
    exporting.value = false
  }
}

async function write() {
  if (previews.value.length === 0) return
  writing.value = true
  try {
    // S2（2026-10-26）：全周期单事务原子保存（FE-12）——此前逐周 replaceWeek，
    // 中途失败会留下部分周更新、部分周保持旧方案。预览携带生成时的业务版本，
    // 期间发生过导入/保存/手调（版本前进）则拒绝写入，避免旧预览覆盖新数据。
    // S3：被保留的安排从重排前的行携带 locked / 短段例外原因，写入不丢失。
    await saveFullCycle(
      previews.value.map((w) => {
        const beforeByKey = new Map(
          (beforeRowsMap.value.get(w.weekNo) ?? []).map((r) => [
            `${r.dayOfWeek}|${r.timeSlot}|${r.assistantId}`,
            r,
          ]),
        )
        return {
          weekNo: w.weekNo,
          rows: w.assignments.map((a) => {
            const prev = beforeByKey.get(`${a.dayOfWeek}|${a.slotKey}|${a.assistantId}`)
            return {
              dayOfWeek: a.dayOfWeek,
              timeSlot: a.slotKey,
              assistantId: a.assistantId,
              source: a.source,
              ...(prev?.locked !== undefined ? { locked: prev.locked } : {}),
              ...(prev?.continuityExceptionReason
                ? { continuityExceptionReason: prev.continuityExceptionReason }
                : {}),
            }
          }),
        }
      }),
      previewedRevision.value,
      {
        weekRange: [rules.value.weekStart, rules.value.weekEnd],
        mode: rules.value.uniformMode ? 'uniform' : 'perWeek',
      },
    )
    ElMessage.success(
      `已写入第 ${rules.value.weekStart}~${rules.value.weekEnd} 周排班（共 ${previews.value.reduce(
        (s, w) => s + w.assignments.length,
        0,
      )} 条）`,
    )
    previews.value = []
    previewWeek.value = undefined
    await loadWeek()
  } catch (err) {
    if (err instanceof StaleDataError) {
      ElMessage.error('数据已变化（预览生成后发生过新的导入或保存），请重新生成预览后再写入')
      return
    }
    ElMessage.error(err instanceof Error ? err.message : '写入失败')
  } finally {
    writing.value = false
  }
}

/** 网格行：**每个节次一行**（第 1 节、第 2 节…），列 = 工作日，格子里是姓名列表 */
interface GridRow {
  label: string
  cells: Record<number, string>
}

/**
 * 网格行 = 节次（含上课时间）、列 = 工作日，骨架取「当前规则 ∪ 数据」并集：
 * 只按当前规则推导时，管理员改完上班节次再看旧排班/导出，数据会整体"隐身"。
 */
function buildGrid(
  keys: GridKey[],
  days: number[],
  rows: Array<{ dayOfWeek: number; timeSlot: string; assistantId: number }>,
): GridRow[] {
  const map = new Map<string, string[]>()
  for (const r of rows) {
    const key = `${r.dayOfWeek}|${r.timeSlot}`
    const list = map.get(key) ?? []
    list.push(nameById.value.get(r.assistantId) ?? `#${r.assistantId}`)
    map.set(key, list)
  }
  return keys.map((g) => ({
    key: g.key,
    label: g.label,
    cells: Object.fromEntries(days.map((d) => [d, (map.get(`${d}|${g.key}`) ?? []).join('、')])),
  }))
}

const previewRows = computed(() =>
  (currentPreview.value?.assignments ?? []).map((a) => ({
    dayOfWeek: a.dayOfWeek,
    timeSlot: a.slotKey,
    assistantId: a.assistantId,
  })),
)
const previewGridKeys = computed(() => collectGridKeys(rules.value, previewRows.value))
const previewGridDays = computed(() => collectGridDays(rules.value, previewRows.value))
const previewGrid = computed(() => buildGrid(previewGridKeys.value, previewGridDays.value, previewRows.value))

const storedGridKeys = computed(() => collectGridKeys(rules.value, storedRows.value))
const storedGridDays = computed(() => collectGridDays(rules.value, storedRows.value))
const storedGrid = computed(() => buildGrid(storedGridKeys.value, storedGridDays.value, storedRows.value))
</script>

<template>
  <!-- 工具栏 -->
  <el-card class="card">
    <div class="toolbar">
      <span>查看周次：</span>
      <el-select v-model="weekNo" style="width: 140px" @change="onWeekChange">
        <el-option v-for="w in weekOptions" :key="w" :value="w" :label="`第 ${w} 周`" />
      </el-select>
      <el-button type="primary" :loading="generating" @click="generate">
        {{ previews.length ? '重新生成全部周方案' : `一次性生成第 ${rules.weekStart}~${rules.weekEnd} 周方案` }}
      </el-button>
      <el-button v-if="generating && scheduleClient.isBusy" type="danger" plain @click="cancelGenerate">
        取消计算
      </el-button>
      <div v-if="generating && progressMsg" class="progress-line">
        <el-progress :percentage="progressPercent" :stroke-width="8" style="flex: 1; min-width: 220px" />
        <span class="progress-text">{{ progressMsg }}</span>
      </div>
      <el-radio-group v-model="rescheduleMode" size="small" style="margin-left: 8px">
        <el-radio-button value="full">全量重排</el-radio-button>
        <el-radio-button value="incremental">增量重排</el-radio-button>
      </el-radio-group>
      <template v-if="rescheduleMode === 'incremental'">
        <span style="font-size: 12px; color: var(--el-text-color-secondary)">目标周次：</span>
        <el-input-number v-model="targetWeekStart" size="small" :min="rules.weekStart" :max="rules.weekEnd" style="width: 90px" />
        <span>~</span>
        <el-input-number v-model="targetWeekEnd" size="small" :min="rules.weekStart" :max="rules.weekEnd" style="width: 90px" />
        <el-tooltip
          content="以已写入方案为基准：锁定项不动，其余安排优先保留，只重算目标周次；输入未变化时保持零改动"
          placement="bottom"
        >
          <el-icon style="color: var(--el-text-color-secondary)"><QuestionFilled /></el-icon>
        </el-tooltip>
      </template>
      <el-button
        v-if="previews.length"
        type="success"
        :loading="writing"
        @click="write"
      >
        写入全部周排班（共 {{ previews.reduce((s, w) => s + w.assignments.length, 0) }} 条）
      </el-button>
      <el-tag v-if="rules.uniformMode" type="info">模式：各周排班相同</el-tag>
      <el-alert
        v-if="previews.length && rescheduleMode === 'incremental'"
        :type="zeroChange ? 'success' : incrementalDiff.length ? 'warning' : 'success'"
        :closable="false"
        class="incr-result"
        :title="
          zeroChange
            ? '增量重排：输入未变化，方案保持零改动'
            : incrementalDiff.length
              ? `增量重排：${incrementalDiff.length} 处变动（新增 ${incrementalDiff.filter(d => d.type==='added').length}、移除 ${incrementalDiff.filter(d => d.type==='removed').length}、替换 ${incrementalDiff.filter(d => d.type==='replaced').length}；范围外周保持原样）`
              : '增量重排：全部安排可保留，无变动'
        "
      />
      <el-table
        v-if="previews.length && rescheduleMode === 'incremental' && incrementalDiff.length"
        :data="incrementalDiff"
        border
        size="small"
        max-height="240"
        class="incr-result"
      >
        <el-table-column label="变动" width="80">
          <template #default="{ row }">
            <el-tag
              size="small"
              :type="row.type === 'added' ? 'success' : row.type === 'removed' ? 'danger' : 'warning'"
            >
              {{ row.type === 'added' ? '新增' : row.type === 'removed' ? '移除' : '替换' }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="周次" width="80">
          <template #default="{ row }">第 {{ row.weekNo }} 周</template>
        </el-table-column>
        <el-table-column label="位置" width="150">
          <template #default="{ row }">星期{{ row.dayOfWeek }} 第{{ row.slotKey.slice(1) }}节</template>
        </el-table-column>
        <el-table-column label="人员" min-width="150">
          <template #default="{ row }">
            <template v-if="row.type === 'replaced'">
              {{ nameById.get(row.assistantId) ?? `#${row.assistantId}` }} →
              {{ nameById.get(row.otherAssistantId!) ?? `#${row.otherAssistantId}` }}
            </template>
            <template v-else>{{ nameById.get(row.assistantId!) ?? `#${row.assistantId}` }}</template>
          </template>
        </el-table-column>
        <el-table-column prop="reason" label="原因" min-width="240" />
      </el-table>
      <el-tag v-if="!rules.uniformMode" type="info">模式：各周独立</el-tag>
      <el-divider direction="vertical" />
      <el-tooltip
        content="导出时自动把值班人的联系电话填入排班表；只含电话这一项个人信息，不含学号 / QQ"
        placement="top"
      >
        <el-switch v-model="exportIncludePhone" active-text="含电话" />
      </el-tooltip>
      <el-button :loading="exporting" @click="doExport">导出第 {{ weekNo }} 周排班</el-button>
      <el-button :loading="exportingMulti" @click="doExportMultiWeek">导出多周工作簿</el-button>
    </div>
  </el-card>

  <!-- 方案预览 -->
  <template v-if="previews.length">
    <el-card class="card">
      <template #header>
        方案汇总（尚未写入）—— 共 {{ previews.length }} 周，总 {{ previews.reduce((s, w) => s + w.assignments.length, 0) }} 条
        <span v-if="currentPreview?.replicated">（统一方案复制）</span>
      </template>
      <el-table :data="previews" border size="small" max-height="240">
        <el-table-column prop="weekNo" label="周次" width="80">
          <template #default="{ row }">第 {{ row.weekNo }} 周</template>
        </el-table-column>
        <el-table-column prop="assignments.length" label="排班条数" width="100" />
        <el-table-column label="未满足时段" width="110">
          <template #default="{ row }">
            <el-tag :type="row.unmetSlots.length ? 'warning' : 'success'" size="small">
              {{ row.unmetSlots.length }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="重排变动" width="110">
          <template #default="{ row }">
            <el-tag
              :type="weekChangeLabel(row as WeeklySchedule) === '不变' ? 'info' : 'warning'"
              size="small"
            >
              {{ weekChangeLabel(row as WeeklySchedule) }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="elapsedMs" label="耗时(ms)" width="100">
          <template #default="{ row }">{{ row.elapsedMs.toFixed(1) }}</template>
        </el-table-column>
      </el-table>

      <div class="block preview-nav">
        <span>查看周次：</span>
        <el-select v-model="previewWeek" style="width: 140px">
          <el-option v-for="w in previews" :key="w.weekNo" :value="w.weekNo" :label="`第 ${w.weekNo} 周`" />
        </el-select>
      </div>

      <el-alert
        v-if="currentPreview && currentPreview.unmetSlots.length"
        type="warning"
        :closable="false"
        class="block"
        :title="`第 ${currentPreview.weekNo} 周有 ${currentPreview.unmetSlots.length} 个时段人数不足，可通过手动调整补充`"
        :description="currentPreview.unmetSlots.map((u) => u.reason).join('；')"
      />
      <el-table :data="previewGrid" border size="small">
        <el-table-column prop="label" label="时段（按节次）" width="180" fixed="left" />
        <el-table-column v-for="d in previewGridDays" :key="d" :label="GRID_DAY_LABELS[d]" min-width="110">
          <template #default="{ row }">{{ row.cells[d] || '—' }}</template>
        </el-table-column>
      </el-table>

      <h4 class="block">重排变动明细（第 {{ currentPreview?.weekNo }} 周）</h4>
      <el-empty
        v-if="weekDiff && weekDiff.added.length === 0 && weekDiff.removed.length === 0"
        description="与重排前完全一致"
        :image-size="48"
      />
      <el-table
        v-else
        :data="[...(weekDiff?.added ?? []), ...(weekDiff?.removed ?? [])]"
        border
        size="small"
        max-height="220"
      >
        <el-table-column label="变动" width="90">
          <template #default="{ row }">
            <el-tag :type="row.type === 'added' ? 'success' : 'danger'" size="small">
              {{ row.type === 'added' ? '新增' : '移除' }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="星期" width="90">
          <template #default="{ row }">{{ GRID_DAY_LABELS[row.dayOfWeek] }}</template>
        </el-table-column>
        <el-table-column label="节次" width="90">
          <template #default="{ row }">第 {{ row.timeSlot.slice(1) }} 节</template>
        </el-table-column>
        <el-table-column label="助理" min-width="120">
          <template #default="{ row }">{{ nameById.get(row.assistantId) ?? `#${row.assistantId}` }}</template>
        </el-table-column>
      </el-table>

      <h4 class="block">每人工时（第 {{ currentPreview?.weekNo }} 周）</h4>
      <el-table :data="currentPreview?.summaries ?? []" border size="small" max-height="220">
        <el-table-column prop="name" label="助理" width="120" />
        <el-table-column prop="sections" label="值班节数" width="100" />
        <el-table-column label="目标区间" width="150">
          <template #default="{ row }">
            {{ row.minSections }} ~ {{ row.maxSections }}
            <el-tag
              v-if="row.minSections !== rules.minSectionsPerAssistant || row.maxSections !== rules.maxSectionsPerAssistant"
              size="small"
              type="warning"
            >
              个性化
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="slots" label="时段数" width="90" />
        <el-table-column label="状态" width="140">
          <template #default="{ row }">
            <el-tag v-if="row.belowMin" type="warning" size="small">低于下限</el-tag>
            <el-tag v-else type="success" size="small">正常</el-tag>
          </template>
        </el-table-column>
      </el-table>
    </el-card>
  </template>

  <!-- 已写入的排班表（S3：点击格子手动调整，FE-08） -->
  <el-card class="card">
    <template #header>
      第 {{ weekNo }} 周排班表（已写入）——点击格子可手动调整
      <el-tag size="small" type="info" style="margin-left: 8px">手动=老师指定 · 锁定=重排时保持</el-tag>
      <span style="float: right">
        <el-tooltip
          :disabled="!adjustHistory.undoLabels.length"
          :content="adjustHistory.undoLabels.join('\n')"
          placement="bottom"
        >
          <el-button
            size="small"
            :disabled="!adjustHistory.canUndo"
            :loading="undoingRedoing"
            @click="undoRedo('undo')"
            >撤销</el-button
          >
        </el-tooltip>
        <el-tooltip
          :disabled="!adjustHistory.redoLabels.length"
          :content="adjustHistory.redoLabels.join('\n')"
          placement="bottom"
        >
          <el-button
            size="small"
            :disabled="!adjustHistory.canRedo"
            :loading="undoingRedoing"
            @click="undoRedo('redo')"
            >重做</el-button
          >
        </el-tooltip>
      </span>
    </template>
    <el-empty v-if="storedRows.length === 0" description="本周暂无排班记录" :image-size="60" />
    <el-table v-else :data="storedGrid" border size="small">
      <el-table-column prop="label" label="时段（按节次）" width="180" fixed="left" />
      <el-table-column v-for="d in storedGridDays" :key="d" :label="GRID_DAY_LABELS[d]" min-width="110">
        <template #default="{ row }">
          <span class="adjust-cell" @click="openAdjust(row.key, row.label, d)">
            {{ row.cells[d] || '＋' }}
          </span>
        </template>
      </el-table-column>
    </el-table>
  </el-card>

  <!-- S3 命名快照（S6 拆分为独立组件） -->
  <ScheduleSnapshotsCard @restored="onSnapRestored" />


  <!-- S3 手动调整对话框 -->
  <ManualAdjustDialog
    v-model="adjustVisible"
    :week-no="weekNo"
    :context="adjustContext"
    @changed="onAdjustChanged"
  />
</template>

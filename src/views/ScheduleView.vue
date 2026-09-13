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
import { ElMessage } from 'element-plus'
import { assistantRepo, configRepo, courseRepo, dutyScheduleRepo, operationLogRepo } from '../db/repositories'
import type { DutySchedule } from '../db/schema'
import { scheduleAll } from '../algorithms/greedy'
import {
  normalizeRules,
  type SchedulingRules,
  type WeeklySchedule,
} from '../algorithms/types'
import { exportScheduleFile, scheduleFileName } from '../utils/scheduleExport'
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
const writing = ref(false)
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
})

async function loadWeek() {
  storedRows.value = await dutyScheduleRepo.listByWeek(weekNo.value)
}

function onWeekChange() {
  previews.value = []
  previewWeek.value = undefined
  loadWeek()
}

async function generate() {
  generating.value = true
  try {
    const assistants = (await assistantRepo.list()).map((a) => ({
      id: a.id!,
      name: a.name,
      identity: a.identity,
    }))
    if (assistants.length === 0) {
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
    // F08：快照"重排前"数据（逐周读库），供差异对比
    beforeRowsMap.value = new Map()
    for (let w = rules.value.weekStart; w <= rules.value.weekEnd; w++) {
      beforeRowsMap.value.set(w, await dutyScheduleRepo.listByWeek(w))
    }
    // F08：手动调整记录作为 keep 保留（仅对各自周次生效）
    const keep = storedRows.value
      .filter((r) => r.source === 'manual')
      .map((r) => ({ dayOfWeek: r.dayOfWeek, slotKey: r.timeSlot, assistantId: r.assistantId }))
    previews.value = scheduleAll({ rules: JSON.parse(JSON.stringify(rules.value)), assistants, courses, keep })
    previewWeek.value = previews.value[0]?.weekNo
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

/** 导出当前查看周的排班表（联系电话默认自动填充） */
function doExport() {
  if (storedRows.value.length === 0) {
    ElMessage.error(`第 ${weekNo.value} 周暂无排班记录，无法导出`)
    return
  }
  exporting.value = true
  try {
    const fileName = scheduleFileName(weekNo.value)
    exportScheduleFile(
      {
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
      },
      fileName,
    )
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
    for (const w of previews.value) {
      await dutyScheduleRepo.replaceWeek(
        w.weekNo,
        w.assignments.map((a) => ({
          weekNo: w.weekNo,
          dayOfWeek: a.dayOfWeek,
          timeSlot: a.slotKey,
          assistantId: a.assistantId,
          status: 'normal' as const,
          source: a.source,
        })),
      )
    }
    await operationLogRepo.add('schedule.write', {
      weeks: [rules.value.weekStart, rules.value.weekEnd],
      mode: rules.value.uniformMode ? 'uniform' : 'perWeek',
      count: previews.value.reduce((s, w) => s + w.assignments.length, 0),
    })
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
      <el-button
        v-if="previews.length"
        type="success"
        :loading="writing"
        @click="write"
      >
        写入全部周排班（共 {{ previews.reduce((s, w) => s + w.assignments.length, 0) }} 条）
      </el-button>
      <el-tag v-if="rules.uniformMode" type="info">模式：各周排班相同</el-tag>
      <el-tag v-if="!rules.uniformMode" type="info">模式：各周独立</el-tag>
      <el-divider direction="vertical" />
      <el-tooltip
        content="导出时自动把值班人的联系电话填入排班表；只含电话这一项个人信息，不含学号 / QQ"
        placement="top"
      >
        <el-switch v-model="exportIncludePhone" active-text="含电话" />
      </el-tooltip>
      <el-button :loading="exporting" @click="doExport">导出第 {{ weekNo }} 周排班</el-button>
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
              :type="weekChangeLabel(row) === '不变' ? 'info' : 'warning'"
              size="small"
            >
              {{ weekChangeLabel(row) }}
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

  <!-- 已写入的排班表 -->
  <el-card class="card">
    <template #header>第 {{ weekNo }} 周排班表（已写入）</template>
    <el-empty v-if="storedRows.length === 0" description="本周暂无排班记录" :image-size="60" />
    <el-table v-else :data="storedGrid" border size="small">
      <el-table-column prop="label" label="时段（按节次）" width="180" fixed="left" />
      <el-table-column v-for="d in storedGridDays" :key="d" :label="GRID_DAY_LABELS[d]" min-width="110">
        <template #default="{ row }">{{ row.cells[d] || '—' }}</template>
      </el-table-column>
    </el-table>
  </el-card>
</template>

<style scoped>
.card { margin-bottom: 14px; }
.toolbar { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
.block { margin-top: 12px; margin-bottom: 8px; }
.preview-nav { display: flex; align-items: center; gap: 8px; }
</style>

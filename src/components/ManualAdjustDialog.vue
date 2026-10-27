<script setup lang="ts">
/**
 * 排班手动调整对话框（S3 第一片 / F04 / FE-08，2026-10-26）。
 *
 * 打开于"已写入"网格的某个格子：查看当前值班（含来源/锁定/例外标记）、
 * 添加候选（逐人给出可排/不可排与原因）、移除、跨格移动、锁定/解锁、
 * 短段例外登记。所有写入走 manualAdjustService 的原子事务（评价器终态校验 +
 * dataRevision CAS），本组件只做编排与展示（分层纪律：UI 不直接编排数据库）。
 */
import { computed, ref, watch } from 'vue'
import {
  ManualAdjustRejected,
  addManualAssignment,
  getSlotCandidates,
  moveAssignment,
  removeAssignment,
  setContinuityException,
  setLocked,
  type SlotCandidate,
} from '../db/manualAdjustService'
import { StaleDataError, getDataRevision } from '../db/dataRevision'
import { assistantRepo, configRepo, dutyScheduleRepo } from '../db/repositories'
import { buildSlots, normalizeRules } from '../algorithms/types'
import { DAY_LABELS as GRID_DAY_LABELS_SENTENCE } from '../utils/scheduleGrid'
import type { DutySchedule } from '../db/schema'

const props = defineProps<{
  weekNo: number
  /** 当前格子上文；null = 关闭 */
  context: { dayOfWeek: number; slotKey: string; label: string } | null
}>()

const emit = defineEmits<{ changed: [] }>()

const visible = defineModel<boolean>({ default: false })

const rows = ref<DutySchedule[]>([])
const nameById = ref<Map<number, string>>(new Map())
const candidates = ref<SlotCandidate[]>([])
const loading = ref(false)
/** 本对话框打开时捕获的业务版本（操作 CAS 基准） */
let baseRevision = 0

const selectedAssistant = ref<number>()
const exceptionReason = ref('')

/** 移动子表单：moveRowId 有值时展开 */
const moveRowId = ref<number | null>(null)
const moveDay = ref(1)
const moveSlot = ref('c1')
/** 全部合法时段（移动目标选项），按星期分组 */
const moveOptions = ref<Array<{ dayOfWeek: number; slotKey: string; label: string }>>([])

const name = (id: number) => nameById.value.get(id) ?? `#${id}`

const currentRows = computed(() =>
  rows.value
    .filter((r) => r.dayOfWeek === props.context?.dayOfWeek && r.timeSlot === props.context?.slotKey)
    .map((r) => ({ row: r, name: name(r.assistantId) })),
)

const eligibleCandidates = computed(() => candidates.value.filter((c) => c.eligible))
const blockedCandidates = computed(() => candidates.value.filter((c) => !c.eligible && c.reason !== '已在该时段'))

const title = computed(() =>
  props.context
    ? `调整：第 ${props.weekNo} 周 ${GRID_DAY_LABELS_SENTENCE[props.context.dayOfWeek]} ${props.context.label}`
    : '调整排班',
)

async function reload() {
  if (!props.context) return
  loading.value = true
  try {
    const [weekRows, assistants, cands, rulesRaw] = await Promise.all([
      dutyScheduleRepo.listByWeek(props.weekNo),
      assistantRepo.list(),
      getSlotCandidates(props.weekNo, props.context.dayOfWeek, props.context.slotKey),
      configRepo.get<{ [k: string]: unknown }>('rules'),
    ])
    rows.value = weekRows
    nameById.value = new Map(assistants.map((a) => [a.id!, a.name]))
    candidates.value = cands
    baseRevision = await getDataRevision()
    const rules = normalizeRules(rulesRaw as never)
    moveOptions.value = buildSlots(rules).map((s) => ({
      dayOfWeek: s.dayOfWeek,
      slotKey: s.key,
      label: s.label,
    }))
  } finally {
    loading.value = false
  }
}

watch(
  () => [props.context, visible.value],
  () => {
    if (visible.value && props.context) {
      selectedAssistant.value = undefined
      exceptionReason.value = ''
      moveRowId.value = null
      void reload()
    }
  },
)

/** 统一错误处理：拒绝给明细；版本冲突提示刷新；成功后刷新本格与基准版本 */
async function run(op: () => Promise<unknown>, successMsg?: string) {
  try {
    await op()
    if (successMsg) ElMessage.success(successMsg)
    await reload()
    emit('changed')
  } catch (err) {
    if (err instanceof StaleDataError) {
      ElMessage.error('数据已被其他窗口修改，本窗口已刷新到最新状态，请核对后重试')
      await reload()
      emit('changed')
      return
    }
    if (err instanceof ManualAdjustRejected) {
      ElMessage.error(err.message)
      return
    }
    ElMessage.error(err instanceof Error ? err.message : '操作失败')
  }
}

async function doAdd() {
  if (!props.context || !selectedAssistant.value) {
    ElMessage.warning('请先选择要添加的助理')
    return
  }
  const reason = exceptionReason.value.trim() || undefined
  await run(
    () =>
      addManualAssignment(
        {
          weekNo: props.weekNo!,
          dayOfWeek: props.context!.dayOfWeek,
          timeSlot: props.context!.slotKey,
          assistantId: selectedAssistant.value!,
          continuityExceptionReason: reason,
        },
        baseRevision,
      ),
    `已添加「${name(selectedAssistant.value)}」`,
  )
  selectedAssistant.value = undefined
  exceptionReason.value = ''
}

async function doRemove(id: number) {
  await run(() => removeAssignment(id, baseRevision), '已移除')
}

async function doToggleLock(row: DutySchedule) {
  await run(() => setLocked(row.id!, !(row.locked ?? false), baseRevision), row.locked ? '已解锁' : '已锁定')
}

async function doMove() {
  if (!moveRowId.value) return
  await run(
    () => moveAssignment(moveRowId.value!, { dayOfWeek: moveDay.value, timeSlot: moveSlot.value }, baseRevision),
    '已移动',
  )
  moveRowId.value = null
}

async function doException(row: DutySchedule, clear = false) {
  if (clear) {
    await run(() => setContinuityException(row.id!, null, baseRevision), '已清除例外')
    return
  }
  const reason = window.prompt(
    `为「${name(row.assistantId)}」在此处的手动短段填写例外原因（仅豁免连续节数要求，需可追溯）：`,
    row.continuityExceptionReason ?? '',
  )
  if (reason === null) return
  await run(() => setContinuityException(row.id!, reason, baseRevision), '已登记例外')
}

const moveDayOptions = computed(() => {
  const days = [...new Set(moveOptions.value.map((o) => o.dayOfWeek))].sort((a, b) => a - b)
  return days.map((d) => ({ value: d, label: GRID_DAY_LABELS_SENTENCE[d] ?? `星期${d}` }))
})
const moveSlotOptions = computed(() =>
  moveOptions.value.filter((o) => o.dayOfWeek === moveDay.value),
)
</script>

<template>
  <el-dialog v-model="visible" :title="title" width="560px">
    <div v-loading="loading">
      <!-- 当前值班 -->
      <h4 class="section">当前值班（{{ currentRows.length }} 人）</h4>
      <el-empty
        v-if="currentRows.length === 0"
        description="本时段暂无安排"
        :image-size="48"
      />
      <div v-for="item in currentRows" :key="item.row.id" class="person-row">
        <span class="person-name">{{ item.name }}</span>
        <el-tag size="small" :type="item.row.source === 'manual' ? 'warning' : 'info'">
          {{ item.row.source === 'manual' ? '手动' : '自动' }}
        </el-tag>
        <el-tag v-if="item.row.locked" size="small" type="success">已锁定</el-tag>
        <el-tooltip
          v-if="item.row.continuityExceptionReason"
          :content="`短段例外：${item.row.continuityExceptionReason}`"
        >
          <el-tag size="small" type="danger">短段例外</el-tag>
        </el-tooltip>
        <span class="actions">
          <el-button link type="primary" size="small" @click="doToggleLock(item.row)">
            {{ item.row.locked ? '解锁' : '锁定' }}
          </el-button>
          <el-button
            link
            type="primary"
            size="small"
            @click="moveRowId = item.row.id!; moveDay = context!.dayOfWeek; moveSlot = context!.slotKey"
            >移动</el-button
          >
          <el-button
            v-if="item.row.source === 'manual' && !item.row.continuityExceptionReason"
            link
            type="warning"
            size="small"
            @click="doException(item.row)"
            >登记短段例外</el-button
          >
          <el-button
            v-else-if="item.row.continuityExceptionReason"
            link
            type="info"
            size="small"
            @click="doException(item.row, true)"
            >清除例外</el-button
          >
          <el-button link type="danger" size="small" @click="doRemove(item.row.id!)"
            >移除</el-button
          >
        </span>

        <!-- 移动子表单 -->
        <div v-if="moveRowId === item.row.id" class="move-form">
          <el-select v-model="moveDay" size="small" style="width: 100px">
            <el-option v-for="d in moveDayOptions" :key="d.value" :value="d.value" :label="d.label" />
          </el-select>
          <el-select v-model="moveSlot" size="small" style="width: 170px">
            <el-option v-for="s in moveSlotOptions" :key="s.slotKey" :value="s.slotKey" :label="s.label" />
          </el-select>
          <el-button type="primary" size="small" @click="doMove">移到此处</el-button>
          <el-button size="small" @click="moveRowId = null">取消</el-button>
        </div>
      </div>

      <el-divider />

      <!-- 添加候选 -->
      <h4 class="section">添加值班（候选与不可排原因）</h4>
      <el-select
        v-model="selectedAssistant"
        placeholder="选择助理"
        style="width: 200px"
      >
        <el-option
          v-for="c in eligibleCandidates"
          :key="c.assistantId"
          :value="c.assistantId"
          :label="c.name"
        />
      </el-select>
      <el-input
        v-model="exceptionReason"
        placeholder="短段例外原因（添加短于最少连续节数的手动安排时必填）"
        style="width: 320px; margin-left: 8px"
      />
      <el-button
        type="primary"
        style="margin-left: 8px"
        :disabled="!selectedAssistant"
        @click="doAdd"
        >添加</el-button
      >
      <div v-if="blockedCandidates.length" class="blocked-list">
        <div v-for="c in blockedCandidates" :key="c.assistantId" class="blocked-item">
          {{ c.name }}：{{ c.reason }}
        </div>
      </div>
      <div v-else-if="eligibleCandidates.length === 0 && candidates.length > 0" class="blocked-list">
        当前没有可添加的候选（见上方原因或全员已在此时段）。
      </div>
    </div>
    <template #footer>
      <el-button type="primary" @click="visible = false">完成</el-button>
    </template>
  </el-dialog>
</template>

<style scoped>
.section {
  margin: 4px 0 8px;
}
.person-row {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 0;
  flex-wrap: wrap;
}
.person-name {
  min-width: 64px;
}
.actions {
  margin-left: auto;
  display: flex;
  gap: 2px;
}
.move-form {
  width: 100%;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 0 4px 70px;
}
.blocked-list {
  margin-top: 10px;
  font-size: 12px;
  color: var(--el-text-color-secondary);
  line-height: 1.8;
}
.blocked-item {
  border-left: 2px solid var(--el-border-color);
  padding-left: 8px;
}
</style>

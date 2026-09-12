<script setup lang="ts">
/**
 * 排班表页（SRS F01 核心流程）：
 *   选周 → 生成方案（算法纯函数）→ 预览（网格 + 汇总 + 未满足清单）→ 确认写入。
 *
 * 数据流（T-008 原则）：Dexie 读出的数据在构造算法输入时逐字段重建纯对象；
 * 算法输出写库时同样逐字段构造，杜绝响应式 Proxy 跨界。
 * F08 预留：手动调整记录（source=manual）作为 keep 传给算法保留。
 */
import { computed, onMounted, ref } from 'vue'
import { ElMessage } from 'element-plus'
import { assistantRepo, configRepo, courseRepo, dutyScheduleRepo, operationLogRepo } from '../db/repositories'
import type { DutySchedule } from '../db/schema'
import { scheduleWeek } from '../algorithms/greedy'
import { DEFAULT_RULES, type ScheduleOutput, type SchedulingRules, type SlotTemplate } from '../algorithms/types'

const rules = ref<SchedulingRules>(JSON.parse(JSON.stringify(DEFAULT_RULES)))
const weekNo = ref(1)
const preview = ref<ScheduleOutput | null>(null)
const generating = ref(false)
const writing = ref(false)
/** 当前周已落库的排班（无预览时展示它） */
const storedRows = ref<DutySchedule[]>([])
const nameById = ref<Map<number, string>>(new Map())

const weekOptions = computed(() => {
  const arr: number[] = []
  for (let w = rules.value.weekStart; w <= rules.value.weekEnd; w++) arr.push(w)
  return arr
})

onMounted(async () => {
  const saved = await configRepo.get<SchedulingRules>('rules')
  if (saved) rules.value = saved
  weekNo.value = rules.value.weekStart
  const assistants = await assistantRepo.list()
  nameById.value = new Map(assistants.map((a) => [a.id!, a.name]))
  await loadWeek()
})

async function loadWeek() {
  storedRows.value = await dutyScheduleRepo.listByWeek(weekNo.value)
}

function plainRules(): SchedulingRules {
  return JSON.parse(JSON.stringify(rules.value))
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
      dayOfWeek: c.dayOfWeek,
      sectionStart: c.sectionStart,
      sectionEnd: c.sectionEnd,
      weekRanges: c.weekRanges.map(([s, e]) => [s, e] as [number, number]),
    }))
    // F08：手动调整记录作为 keep 保留
    const keep = storedRows.value
      .filter((r) => r.source === 'manual')
      .map((r) => ({ dayOfWeek: r.dayOfWeek, slotKey: r.timeSlot, assistantId: r.assistantId }))
    preview.value = scheduleWeek({ weekNo: weekNo.value, rules: plainRules(), assistants, courses, keep })
  } finally {
    generating.value = false
  }
}

async function write() {
  if (!preview.value) return
  writing.value = true
  try {
    const week = weekNo.value
    await dutyScheduleRepo.replaceWeek(
      week,
      preview.value.assignments.map((a) => ({
        weekNo: week,
        dayOfWeek: a.dayOfWeek,
        timeSlot: a.slotKey,
        assistantId: a.assistantId,
        status: 'normal' as const,
        source: a.source,
      })),
    )
    await operationLogRepo.add('schedule.write', {
      week,
      count: preview.value.assignments.length,
      unmet: preview.value.unmetSlots.length,
    })
    ElMessage.success(`第 ${week} 周排班已写入（${preview.value.assignments.length} 条）`)
    preview.value = null
    await loadWeek()
  } catch (err) {
    ElMessage.error(err instanceof Error ? err.message : '写入失败')
  } finally {
    writing.value = false
  }
}

/** 网格行：时段模板 × 星期，格子里是姓名列表 */
interface GridRow {
  label: string
  cells: string[]
}

function buildGrid(rows: Array<{ dayOfWeek: number; timeSlot: string; assistantId: number }>): GridRow[] {
  const templates: SlotTemplate[] = rules.value.slotTemplates
  const map = new Map<string, string[]>()
  for (const r of rows) {
    const key = `${r.dayOfWeek}|${r.timeSlot}`
    const list = map.get(key) ?? []
    list.push(nameById.value.get(r.assistantId) ?? `#${r.assistantId}`)
    map.set(key, list)
  }
  return templates.map((t) => ({
    label: `${t.label}（${t.sectionStart}~${t.sectionEnd} 节）`,
    cells: Array.from({ length: 7 }, (_, i) => (map.get(`${i + 1}|${t.key}`) ?? []).join('、')),
  }))
}

const previewGrid = computed(() =>
  preview.value
    ? buildGrid(
        preview.value.assignments.map((a) => ({
          dayOfWeek: a.dayOfWeek,
          timeSlot: a.slotKey,
          assistantId: a.assistantId,
        })),
      )
    : [],
)

const storedGrid = computed(() => buildGrid(storedRows.value))

const DAY_LABELS = ['星期一', '星期二', '星期三', '星期四', '星期五', '星期六', '星期日']
</script>

<template>
  <!-- 工具栏 -->
  <el-card class="card">
    <div class="toolbar">
      <span>排班周次：</span>
      <el-select v-model="weekNo" style="width: 140px" @change="preview = null; loadWeek()">
        <el-option v-for="w in weekOptions" :key="w" :value="w" :label="`第 ${w} 周`" />
      </el-select>
      <el-button type="primary" :loading="generating" @click="generate">
        {{ preview ? '重新生成方案' : '生成排班方案' }}
      </el-button>
      <el-button v-if="preview" type="success" :loading="writing" @click="write">
        写入第 {{ weekNo }} 周排班（{{ preview.assignments.length }} 条）
      </el-button>
      <span class="hint" v-if="!rules.slotTemplates.length">请先在"排班配置"中启用时段</span>
    </div>
  </el-card>

  <!-- 方案预览 -->
  <template v-if="preview">
    <el-card class="card">
      <template #header>
        方案预览（尚未写入）—— 算法耗时 {{ preview.elapsedMs.toFixed(1) }} ms
      </template>
      <el-alert
        v-if="preview.unmetSlots.length"
        type="warning"
        :closable="false"
        :title="`有 ${preview.unmetSlots.length} 个时段人数不足（共缺 ${preview.unmetSlots.reduce((s, u) => s + u.short, 0)} 人），可通过手动调整补充`"
        class="block"
        :description="preview.unmetSlots.map((u) => u.reason).join('；')"
      />
      <el-table :data="previewGrid" border size="small">
        <el-table-column prop="label" label="时段" width="200" fixed="left" />
        <el-table-column v-for="(d, i) in DAY_LABELS" :key="d" :label="d" min-width="110">
          <template #default="{ row }">{{ row.cells[i] || '—' }}</template>
        </el-table-column>
      </el-table>

      <h4 class="block">每人工时</h4>
      <el-table :data="preview.summaries" border size="small" max-height="260">
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
      <el-table-column prop="label" label="时段" width="200" fixed="left" />
      <el-table-column v-for="(d, i) in DAY_LABELS" :key="d" :label="d" min-width="110">
        <template #default="{ row }">{{ row.cells[i] || '—' }}</template>
      </el-table-column>
    </el-table>
  </el-card>
</template>

<style scoped>
.card { margin-bottom: 14px; }
.toolbar { display: flex; align-items: center; gap: 12px; }
.hint { color: var(--el-text-color-secondary); font-size: 12px; }
.block { margin-top: 12px; margin-bottom: 8px; }
</style>

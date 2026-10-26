<script setup lang="ts">
/**
 * 助理管理页（SRS F02）：列表 + 搜索 + 新增/编辑/删除。
 *
 * 职责划分：
 * - 本组件只负责"列表展示与动作分发"；
 * - 表单与校验在 AssistantForm.vue（单一职责：弹窗表单自洽，列表不关心表单细节）；
 * - 数据读写全部经由 assistantRepo，本层不出现 Dexie。
 */
import { computed, onMounted, ref } from 'vue'
import { ElMessage } from 'element-plus'
import { Search } from '@element-plus/icons-vue'
import { assistantRepo, courseRepo, operationLogRepo } from '../db/repositories'
import type { Assistant } from '../db/schema'
import { IDENTITY_LABEL } from '../utils/dict'
import AssistantForm from '../components/AssistantForm.vue'
import {
  TIMETABLE_STATUS_LABEL,
  isSchedulableStatus,
  timetableStatusOf,
  type TimetableStatus,
} from '../algorithms/timetableStatus'

const list = ref<Assistant[]>([])
const keyword = ref('')
const formVisible = ref(false)
/** null = 新增模式；有值 = 编辑该记录 */
const editing = ref<Assistant | null>(null)

/** 课表状态四分类（S1）：课程行数用于旧数据的保守回填（有课程记录 → ready） */
const courseCountBy = ref<Map<number, number>>(new Map())

function statusOf(row: Assistant): TimetableStatus {
  return timetableStatusOf(row, (courseCountBy.value.get(row.id!) ?? 0) > 0)
}

/** 删除确认（声明式对话框：不用 ElMessageBox 命令式服务，行为一致且可测） */
const confirmVisible = ref(false)
const confirmTarget = ref<Assistant | null>(null)

/** 客户端过滤（本应用数据量 ≤50 人，无需数据库层检索——简单即正确） */
const filtered = computed(() => {
  const k = keyword.value.trim()
  if (!k) return list.value
  return list.value.filter(
    (a) => a.name.includes(k) || a.studentNo.includes(k) || (a.className ?? '').includes(k),
  )
})

async function refresh() {
  list.value = await assistantRepo.list()
  const counts = new Map<number, number>()
  for (const c of await courseRepo.all()) {
    counts.set(c.assistantId, (counts.get(c.assistantId) ?? 0) + 1)
  }
  courseCountBy.value = counts
}

/**
 * 状态确认动作（S1 四分类的"确认入口"）：
 * - missing → 确认无课（老师明确该生本学期无课，可参与排班）
 * - needs_review → 标记已核对（老师已人工核过无法识别的节次）
 */
async function confirmStatus(row: Assistant, target: 'confirmed_empty' | 'ready') {
  try {
    await assistantRepo.update(row.id!, { timetableStatus: target })
    await operationLogRepo.add('assistant.timetableStatus', {
      studentNo: row.studentNo,
      name: row.name,
      from: statusOf(row),
      to: target,
    })
    ElMessage.success(target === 'confirmed_empty' ? `已确认「${row.name}」无课（可参与排班）` : `已标记「${row.name}」课表核对完成`)
    await refresh()
  } catch (err) {
    ElMessage.error(err instanceof Error ? err.message : '操作失败')
  }
}

onMounted(refresh)

function openCreate() {
  editing.value = null
  formVisible.value = true
}

function openEdit(row: Assistant) {
  editing.value = row
  formVisible.value = true
}

async function handleSaved() {
  formVisible.value = false
  await refresh()
}

function askRemove(row: Assistant) {
  confirmTarget.value = row
  confirmVisible.value = true
}

async function handleRemoveConfirmed() {
  const row = confirmTarget.value
  if (!row) return
  try {
    await assistantRepo.remove(row.id!)
    await operationLogRepo.add('assistant.remove', { studentNo: row.studentNo, name: row.name })
    confirmVisible.value = false
    ElMessage.success('已删除')
  } catch (err) {
    // 必须显式提示：否则用户会误以为已删除，而数据其实还在（且对话框不关）
    ElMessage.error(err instanceof Error ? err.message : '删除失败')
    return
  }
  // 刷新只影响展示，失败不应被报成"删除失败"
  await refresh().catch(() => ElMessage.warning('列表刷新失败，请手动刷新页面'))
}
</script>

<template>
  <div class="toolbar">
    <el-input
      v-model="keyword"
      placeholder="按姓名 / 学号 / 班级搜索"
      :prefix-icon="Search"
      clearable
      class="search"
    />
    <el-button type="primary" @click="openCreate">新增助理</el-button>
  </div>

  <el-table :data="filtered" border stripe>
    <el-table-column prop="name" label="姓名" width="110" />
    <el-table-column prop="studentNo" label="学号" width="130" />
    <el-table-column label="身份" width="100">
      <template #default="{ row }">
        <el-tag :type="row.identity === 'undergrad' ? 'primary' : 'success'">
          {{ IDENTITY_LABEL[row.identity as keyof typeof IDENTITY_LABEL] }}
        </el-tag>
      </template>
    </el-table-column>
    <el-table-column prop="phone" label="联系电话" width="140" />
    <el-table-column prop="qq" label="QQ" width="130" />
    <el-table-column prop="className" label="班级" min-width="120" />
    <el-table-column label="课表状态" width="130">
      <template #default="{ row }">
        <el-tag
          v-if="isSchedulableStatus(statusOf(row))"
          :type="statusOf(row) === 'confirmed_empty' ? 'success' : 'primary'"
          size="small"
          >{{ TIMETABLE_STATUS_LABEL[statusOf(row)] }}</el-tag
        >
        <template v-else>
          <el-tag type="warning" size="small">{{ TIMETABLE_STATUS_LABEL[statusOf(row)] }}</el-tag>
          <el-button
            link
            type="primary"
            size="small"
            style="margin-left: 6px"
            @click="confirmStatus(row, statusOf(row) === 'missing' ? 'confirmed_empty' : 'ready')"
          >
            {{ statusOf(row) === 'missing' ? '确认无课' : '已核对' }}
          </el-button>
        </template>
      </template>
    </el-table-column>
    <el-table-column label="值班节数" width="120">
      <template #default="{ row }">
        <el-tag
          v-if="row.customMinSections !== undefined || row.customMaxSections !== undefined"
          size="small"
          type="warning"
        >
          {{ row.customMinSections ?? '全' }}~{{ row.customMaxSections ?? '全' }}
        </el-tag>
        <span v-else class="muted">跟随全局</span>
      </template>
    </el-table-column>
    <el-table-column label="操作" width="150" fixed="right">
      <template #default="{ row }">
        <el-button link type="primary" @click="openEdit(row)">编辑</el-button>
        <el-button link type="danger" @click="askRemove(row)">删除</el-button>
      </template>
    </el-table-column>
    <template #empty>
      <el-empty description="暂无助理，点击右上角新增" />
    </template>
  </el-table>

  <AssistantForm v-model="formVisible" :assistant="editing" @saved="handleSaved" />

  <el-dialog v-model="confirmVisible" title="删除确认" width="420px" :close-on-click-modal="false">
    <span>确定删除助理「{{ confirmTarget?.name }}」？其课程表将一并删除。</span>
    <template #footer>
      <el-button @click="confirmVisible = false">取消</el-button>
      <el-button type="danger" @click="handleRemoveConfirmed">删除</el-button>
    </template>
  </el-dialog>
</template>

<style scoped>
.toolbar {
  display: flex;
  justify-content: space-between;
  margin-bottom: 14px;
  gap: 12px;
}
.search { max-width: 320px; }
.muted { color: var(--el-text-color-secondary); font-size: 12px; }
</style>

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
import { assistantRepo, operationLogRepo } from '../db/repositories'
import type { Assistant } from '../db/schema'
import { IDENTITY_LABEL } from '../utils/dict'
import AssistantForm from '../components/AssistantForm.vue'

const list = ref<Assistant[]>([])
const keyword = ref('')
const formVisible = ref(false)
/** null = 新增模式；有值 = 编辑该记录 */
const editing = ref<Assistant | null>(null)

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
  await assistantRepo.remove(row.id!)
  await operationLogRepo.add('assistant.remove', { studentNo: row.studentNo, name: row.name })
  ElMessage.success('已删除')
  confirmVisible.value = false
  await refresh()
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

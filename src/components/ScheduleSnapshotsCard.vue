<script setup lang="ts">
/**
 * 命名快照卡片（S6 从 ScheduleView 拆出，功能见 S3/V-016）：
 * 自包含保存 / 逐周对比 / 固定信息导出 / 受控恢复 / 删除。
 * 恢复成功后向父页面发 restored 事件（父层刷新排班与撤销链状态）。
 */
import { onMounted, ref } from 'vue'
import {
  createNamedSnapshot,
  deleteSnapshot,
  listSnapshots,
  restoreSnapshot,
  snapshotDiff,
  type SnapshotWeekDiff,
} from '../db/snapshotService'
import { buildSnapshotExportBuffer } from '../db/snapshotService'
import { getDataRevision } from '../db/dataRevision'
import { getActiveExportTemplate } from '../templates/templateService'
import { isTauri, saveXlsx } from '../utils/fileAccess'
import type { ScheduleSnapshot } from '../db/schema'

const emit = defineEmits<{ restored: [] }>()

const snapshots = ref<ScheduleSnapshot[]>([])
const snapCreateVisible = ref(false)
const snapName = ref('')
const snapSaving = ref(false)
const snapCompareVisible = ref(false)
const snapCompareData = ref<SnapshotWeekDiff[]>([])
const snapRestoreVisible = ref(false)
const snapRestoreTarget = ref<ScheduleSnapshot | null>(null)
const snapRestoring = ref(false)
const snapProblems = ref<string[]>([])

async function loadSnapshots() {
  snapshots.value = await listSnapshots()
}
onMounted(loadSnapshots)

async function createSnap() {
  if (!snapName.value.trim()) return
  snapSaving.value = true
  try {
    await createNamedSnapshot(snapName.value)
    snapCreateVisible.value = false
    snapName.value = ''
    await loadSnapshots()
  } finally {
    snapSaving.value = false
  }
}

async function doSnapCompare(row: ScheduleSnapshot) {
  snapCompareData.value = await snapshotDiff(row.id!)
  snapCompareVisible.value = true
}

function askSnapRestore(row: ScheduleSnapshot) {
  snapRestoreTarget.value = row
  snapProblems.value = []
  snapRestoreVisible.value = true
}

async function doSnapRestore() {
  const target = snapRestoreTarget.value
  if (!target) return
  snapRestoring.value = true
  try {
    const r = await restoreSnapshot(target.id!, await getDataRevision())
    if (r.problems.length > 0) {
      snapProblems.value = r.problems
      return
    }
    snapRestoreVisible.value = false
    await loadSnapshots()
    emit('restored')
  } finally {
    snapRestoring.value = false
  }
}

async function doSnapDelete(row: ScheduleSnapshot) {
  await deleteSnapshot(row.id!)
  await loadSnapshots()
}

async function doSnapExport(row: ScheduleSnapshot) {
  const activeExport = await getActiveExportTemplate()
  const safe = row.label.replace(/[\\/:*?"<>|]/g, '_').slice(0, 30)
  const fileName = `快照-${safe}.xlsx`
  const buffer = buildSnapshotExportBuffer(row, activeExport.style)
  const saved = await saveXlsx(fileName, buffer)
  if (saved || isTauri) return
  const blob = new Blob([buffer.buffer as ArrayBuffer], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = fileName
  a.click()
  URL.revokeObjectURL(url)
}
</script>

<template>
  <el-card class="card">
    <template #header>
      命名快照
      <span style="float: right">
        <el-button size="small" type="primary" @click="snapCreateVisible = true">创建快照</el-button>
      </span>
    </template>
    <el-empty
      v-if="snapshots.length === 0"
      description="暂无快照。发布或大改前可创建快照留档、对比与恢复。"
      :image-size="60"
    />
    <el-table v-else :data="snapshots" border size="small" max-height="260">
      <el-table-column prop="label" label="名称" min-width="160" />
      <el-table-column label="时间" width="180">
        <template #default="{ row }">{{ new Date(row.createdAt).toLocaleString() }}</template>
      </el-table-column>
      <el-table-column label="排班条数" width="90">
        <template #default="{ row }">{{ row.data.length }}</template>
      </el-table-column>
      <el-table-column label="元数据" width="110">
        <template #default="{ row }">
          <el-tag v-if="row.meta" size="small" type="success">完整</el-tag>
          <el-tooltip v-else content="旧快照：缺少当时规则与人员信息，恢复按当前规则复核" placement="top">
            <el-tag size="small" type="info">旧格式</el-tag>
          </el-tooltip>
        </template>
      </el-table-column>
      <el-table-column label="操作" width="210" fixed="right">
        <template #default="{ row }">
          <el-button link type="primary" size="small" @click="doSnapCompare(row as ScheduleSnapshot)">对比</el-button>
          <el-button link size="small" @click="doSnapExport(row as ScheduleSnapshot)">导出</el-button>
          <el-button link type="warning" size="small" @click="askSnapRestore(row as ScheduleSnapshot)">恢复</el-button>
          <el-button link type="danger" size="small" @click="doSnapDelete(row as ScheduleSnapshot)">删除</el-button>
        </template>
      </el-table-column>
    </el-table>
  </el-card>

  <!-- 快照创建 -->
  <el-dialog v-model="snapCreateVisible" title="创建命名快照" width="420px">
    <el-input v-model="snapName" placeholder="如：第 1~17 周发布版" maxlength="40" />
    <div class="hint-snap">保存当前整份排班 + 当时规则与人员名单，用于对比、历史导出与受控恢复。</div>
    <template #footer>
      <el-button @click="snapCreateVisible = false">取消</el-button>
      <el-button type="primary" :loading="snapSaving" @click="createSnap">创建</el-button>
    </template>
  </el-dialog>

  <!-- 快照对比 -->
  <el-dialog v-model="snapCompareVisible" title="快照 vs 当前（逐周差异）" width="480px">
    <el-table :data="snapCompareData" border size="small" max-height="320">
      <el-table-column label="周次" width="110">
        <template #default="{ row }">第 {{ row.weekNo }} 周</template>
      </el-table-column>
      <el-table-column label="当前新增" width="110">
        <template #default="{ row }">
          <el-tag size="small" :type="row.added ? 'success' : 'info'">{{ row.added }}</el-tag>
        </template>
      </el-table-column>
      <el-table-column label="当前移除" width="110">
        <template #default="{ row }">
          <el-tag size="small" :type="row.removed ? 'danger' : 'info'">{{ row.removed }}</el-tag>
        </template>
      </el-table-column>
    </el-table>
    <div class="hint-snap">新增/移除以当前排班为基准（相对快照）；全为 0 表示与快照一致。</div>
  </el-dialog>

  <!-- 快照恢复（受控：先复核当前冲突） -->
  <el-dialog v-model="snapRestoreVisible" title="恢复快照" width="560px">
    <span v-if="snapProblems.length === 0"
      >将用快照「{{ snapRestoreTarget?.label }}」替换其覆盖的周。恢复前会按当前人员与课程复核；撤销/重做链将重置。</span
    >
    <el-alert
      v-else
      type="error"
      :closable="false"
      title="恢复被阻止：快照内容与当前人员/课程存在冲突（数据未改动，可先处理后再恢复）"
    >
      <div class="snap-problems">
        <div v-for="(p, i) in snapProblems" :key="i">{{ p }}</div>
      </div>
    </el-alert>
    <template #footer>
      <el-button @click="snapRestoreVisible = false">关闭</el-button>
      <el-button
        v-if="snapProblems.length === 0"
        type="warning"
        :loading="snapRestoring"
        @click="doSnapRestore"
        >确认恢复</el-button
      >
    </template>
  </el-dialog>
</template>

<style scoped>
.card {
  margin-bottom: 14px;
}
.hint-snap {
  margin-top: 8px;
  color: var(--el-text-color-secondary);
  font-size: 12px;
}
.snap-problems {
  font-size: 12px;
  line-height: 1.8;
  max-height: 240px;
  overflow: auto;
}
</style>

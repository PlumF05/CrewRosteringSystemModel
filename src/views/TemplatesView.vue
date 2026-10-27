<script setup lang="ts">
/**
 * 模板管理页（S5 第一片 / F07 / FE-17，2026-10-26）：导入模板 + 导出模板双管理。
 *
 * 受控字段配置（不做通用解析器/脚本）；导入模板可**试解析**真实文件（不落库）；
 * 自定义模板保存即**版本化**（历史可回看/恢复）；内置模板（学院标准 + 简洁打印）
 * 不可改不可删，可复制；启用切换即时生效（导入解析与排班导出使用启用中的模板）。
 */
import { onMounted, ref } from 'vue'
import { Upload, DocumentCopy } from '@element-plus/icons-vue'
import {
  createTemplate,
  deleteTemplate,
  loadTemplateStore,
  restoreTemplateVersion,
  saveTemplateChanges,
  setActiveTemplate,
  trialImportTemplate,
  type ImportTrialResult,
} from '../templates/templateService'
import type { ExportTemplate, ImportTemplate } from '../templates/types'

const tab = ref<'import' | 'export'>('import')
const imports = ref<ImportTemplate[]>([])
const exports_ = ref<ExportTemplate[]>([])
const activeImportId = ref('')
const activeExportId = ref('')

async function refresh() {
  const s = await loadTemplateStore()
  imports.value = s.imports
  exports_.value = s.exports
  activeImportId.value = s.activeImportId
  activeExportId.value = s.activeExportId
}
onMounted(refresh)

async function activate(kind: 'import' | 'export', id: string) {
  await setActiveTemplate(kind, id)
  await refresh()
  ElMessage.success(kind === 'import' ? '已启用该导入模板（课程导入/批量导入即生效）' : '已启用该导出模板（排班导出即生效）')
}

async function copy(t: ImportTemplate | ExportTemplate) {
  await createTemplate(t.kind, `${t.name}（副本）`, t.id)
  await refresh()
  ElMessage.success('已复制为自定义模板，可修改配置')
}

async function remove(t: ImportTemplate | ExportTemplate) {
  try {
    await deleteTemplate(t.id)
    await refresh()
    ElMessage.success('已删除')
  } catch (err) {
    ElMessage.error(err instanceof Error ? err.message : '删除失败')
  }
}

// ---------- 编辑对话框 ----------

const editVisible = ref(false)
const editTarget = ref<ImportTemplate | ExportTemplate | null>(null)
const editName = ref('')
const importForm = ref({ headerAnchor: '', studentPattern: '', semesterPattern: '' })
const exportForm = ref({ titleTemplate: '', headerFirst: '', firstColumnWidth: 18, dayColumnWidth: 12, compact: false })
const editSaving = ref(false)

function openEdit(t: ImportTemplate | ExportTemplate) {
  if (t.isBuiltIn) {
    ElMessage.info('内置模板不可修改——已为你准备了「复制」入口')
    return
  }
  editTarget.value = t
  editName.value = t.name
  if (t.kind === 'import') {
    importForm.value = { ...t.mapping }
  } else {
    exportForm.value = { ...t.style }
  }
  editVisible.value = true
}

async function saveEdit() {
  const t = editTarget.value
  if (!t) return
  editSaving.value = true
  try {
    const v = await saveTemplateChanges(t.id, {
      name: editName.value,
      ...(t.kind === 'import' ? { mapping: { ...importForm.value } } : { style: { ...exportForm.value } }),
    })
    ElMessage.success(`已保存为 v${v}（历史版本可回看）`)
    editVisible.value = false
    await refresh()
  } catch (err) {
    ElMessage.error(err instanceof Error ? err.message : '保存失败')
  } finally {
    editSaving.value = false
  }
}

// ---------- 版本历史 ----------

const versionsVisible = ref(false)
const versionsTarget = ref<ImportTemplate | ExportTemplate | null>(null)

function openVersions(t: ImportTemplate | ExportTemplate) {
  versionsTarget.value = t
  versionsVisible.value = true
}

async function restoreVersion(version: number) {
  const t = versionsTarget.value
  if (!t) return
  try {
    await restoreTemplateVersion(t.id, version)
    await refresh()
    ElMessage.success(`已按 v${version} 生成新版本`)
    versionsVisible.value = false
  } catch (err) {
    ElMessage.error(err instanceof Error ? err.message : '恢复失败')
  }
}

// ---------- 试解析（仅导入模板） ----------

const trialVisible = ref(false)
const trialTarget = ref<ImportTemplate | null>(null)
const trialResult = ref<ImportTrialResult | null>(null)
const trialLoading = ref(false)
const trialFileInput = ref<HTMLInputElement>()

function openTrial(t: ImportTemplate) {
  trialTarget.value = t
  trialResult.value = null
  trialVisible.value = true
}

async function onTrialFile(e: Event) {
  const input = e.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  const t = trialTarget.value
  if (!file || !t) return
  trialLoading.value = true
  try {
    trialResult.value = await trialImportTemplate(new Uint8Array(await file.arrayBuffer()), t.mapping)
  } finally {
    trialLoading.value = false
  }
}
</script>

<template>
  <el-tabs v-model="tab">
    <el-tab-pane label="课程导入模板" name="import">
      <el-alert
        type="info"
        :closable="false"
        style="margin-bottom: 12px"
        title="导入模板控制解析器的三个定位锚点（表头/学生标识/学期）。修改自定义模板后请先「试解析」验证，再启用。"
      />
      <el-table :data="imports" border size="small">
        <el-table-column label="" width="70">
          <template #default="{ row }">
            <el-radio :model-value="activeImportId" :value="row.id" @change="activate('import', row.id)">启用</el-radio>
          </template>
        </el-table-column>
        <el-table-column prop="name" label="名称" min-width="200" />
        <el-table-column label="版本" width="80">
          <template #default="{ row }">v{{ row.formatVersion }}</template>
        </el-table-column>
        <el-table-column label="类型" width="90">
          <template #default="{ row }">
            <el-tag size="small" :type="row.isBuiltIn ? 'info' : 'success'">{{ row.isBuiltIn ? '内置' : '自定义' }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="250" fixed="right">
          <template #default="{ row }">
            <el-button link type="primary" size="small" @click="openTrial(row as ImportTemplate)">试解析</el-button>
            <el-button link type="primary" size="small" @click="openEdit(row as ImportTemplate | ExportTemplate)">编辑</el-button>
            <el-button link size="small" @click="openVersions(row as ImportTemplate | ExportTemplate)">版本</el-button>
            <el-button link size="small" @click="copy(row as ImportTemplate | ExportTemplate)">复制</el-button>
            <el-button link type="danger" size="small" :disabled="row.isBuiltIn" @click="remove(row as ImportTemplate | ExportTemplate)">删除</el-button>
          </template>
        </el-table-column>
      </el-table>
    </el-tab-pane>

    <el-tab-pane label="排班导出模板" name="export">
      <el-alert
        type="info"
        :closable="false"
        style="margin-bottom: 12px"
        title="导出模板控制标题/表头/列宽与简洁打印版式。内置两套：学院默认版与简洁打印版（黑白打印友好）。电话列仍由导出时的开关控制；导出永不包含学号/QQ。"
      />
      <el-table :data="exports_" border size="small">
        <el-table-column label="" width="70">
          <template #default="{ row }">
            <el-radio :model-value="activeExportId" :value="row.id" @change="activate('export', row.id)">启用</el-radio>
          </template>
        </el-table-column>
        <el-table-column prop="name" label="名称" min-width="200" />
        <el-table-column label="版本" width="80">
          <template #default="{ row }">v{{ row.formatVersion }}</template>
        </el-table-column>
        <el-table-column label="类型" width="90">
          <template #default="{ row }">
            <el-tag size="small" :type="row.isBuiltIn ? 'info' : 'success'">{{ row.isBuiltIn ? '内置' : '自定义' }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="版式" width="110">
          <template #default="{ row }">
            <el-tag size="small" :type="row.style.compact ? 'warning' : 'primary'">
              {{ row.style.compact ? '简洁打印' : '学院默认' }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="220" fixed="right">
          <template #default="{ row }">
            <el-button link type="primary" size="small" @click="openEdit(row as ImportTemplate | ExportTemplate)">编辑</el-button>
            <el-button link size="small" @click="openVersions(row as ImportTemplate | ExportTemplate)">版本</el-button>
            <el-button link size="small" @click="copy(row as ImportTemplate | ExportTemplate)">复制</el-button>
            <el-button link type="danger" size="small" :disabled="row.isBuiltIn" @click="remove(row as ImportTemplate | ExportTemplate)">删除</el-button>
          </template>
        </el-table-column>
      </el-table>
    </el-tab-pane>
  </el-tabs>

  <!-- 编辑对话框 -->
  <el-dialog v-model="editVisible" :title="`编辑模板：${editTarget?.name}`" width="560px">
    <el-form label-width="120px">
      <el-form-item label="名称">
        <el-input v-model="editName" maxlength="40" />
      </el-form-item>
      <template v-if="editTarget?.kind === 'import'">
        <el-form-item label="表头锚点">
          <el-input v-model="importForm.headerAnchor" placeholder="节次/星期" />
        </el-form-item>
        <el-form-item label="学生标识正则">
          <el-input v-model="importForm.studentPattern" />
          <div class="hint-i">需含两个捕获组：姓名、学号。保存前请先试解析。</div>
        </el-form-item>
        <el-form-item label="学期正则">
          <el-input v-model="importForm.semesterPattern" />
        </el-form-item>
      </template>
      <template v-else>
        <el-form-item label="标题模板">
          <el-input v-model="exportForm.titleTemplate" placeholder="行政办助理排班表（第 {week} 周）" />
          <div class="hint-i">{week} 会被替换为导出的周次。</div>
        </el-form-item>
        <el-form-item label="表头首列">
          <el-input v-model="exportForm.headerFirst" />
        </el-form-item>
        <el-form-item label="列宽（首列/日）">
          <el-input-number v-model="exportForm.firstColumnWidth" :min="8" :max="60" /> /
          <el-input-number v-model="exportForm.dayColumnWidth" :min="6" :max="40" />
        </el-form-item>
        <el-form-item label="简洁打印">
          <el-switch v-model="exportForm.compact" />
          <div class="hint-i">去掉底色与占位灰字，黑白打印友好。</div>
        </el-form-item>
      </template>
    </el-form>
    <template #footer>
      <el-button @click="editVisible = false">取消</el-button>
      <el-button type="primary" :loading="editSaving" @click="saveEdit">保存（生成新版本）</el-button>
    </template>
  </el-dialog>

  <!-- 版本历史 -->
  <el-dialog v-model="versionsVisible" :title="`版本历史：${versionsTarget?.name}`" width="520px">
    <el-table
      :data="[...(versionsTarget?.kind === 'import' ? (versionsTarget as ImportTemplate).versions : (versionsTarget as ExportTemplate)?.versions ?? [])].reverse()"
      border
      size="small"
      max-height="300"
    >
      <el-table-column label="版本" width="70">
        <template #default="{ row }">v{{ row.version }}</template>
      </el-table-column>
      <el-table-column label="保存时间" min-width="170">
        <template #default="{ row }">{{ new Date(row.savedAt).toLocaleString() }}</template>
      </el-table-column>
      <el-table-column label="操作" width="90">
        <template #default="{ row }">
          <el-button link type="primary" size="small" @click="restoreVersion(row.version)">恢复</el-button>
        </template>
      </el-table-column>
    </el-table>
    <div class="hint-i" style="margin-top: 8px">恢复会按历史快照生成**新版本**，不改写历史。</div>
  </el-dialog>

  <!-- 试解析（不落库） -->
  <el-dialog v-model="trialVisible" :title="`试解析：${trialTarget?.name}`" width="620px">
    <input ref="trialFileInput" type="file" accept=".xlsx,.xls" style="display: none" @change="onTrialFile" />
    <el-button type="primary" :loading="trialLoading" :icon="Upload" @click="trialFileInput?.click()">
      选择课程表文件试解析
    </el-button>
    <span style="margin-left: 8px; font-size: 12px; color: var(--el-text-color-secondary)">
      <el-icon><DocumentCopy /></el-icon> 只读取解析，不写入任何数据
    </span>
    <template v-if="trialResult">
      <el-alert
        :type="trialResult.ok ? 'success' : 'error'"
        :closable="false"
        style="margin-top: 12px"
        :title="
          trialResult.ok
            ? `解析成功：${trialResult.studentName ?? '?'}（${trialResult.studentNo ?? '?'}）· ${trialResult.courseCount} 条课程${trialResult.semester ? ' · 学期 ' + trialResult.semester : ''}`
            : '解析失败'
        "
      />
      <el-table v-if="trialResult.preview.length" :data="trialResult.preview" border size="small" style="margin-top: 10px">
        <el-table-column prop="courseName" label="课程（前 5 条）" min-width="180" />
        <el-table-column label="星期" width="80">
          <template #default="{ row }">星期{{ row.dayOfWeek }}</template>
        </el-table-column>
        <el-table-column prop="sectionText" label="节次" width="130" />
        <el-table-column prop="weeks" label="周次" min-width="110" />
      </el-table>
      <div v-if="trialResult.problems.length" class="hint-i" style="margin-top: 8px">
        警告：{{ trialResult.problems.join('；') }}
      </div>
    </template>
  </el-dialog>
</template>

<style scoped>
.hint-i {
  color: var(--el-text-color-secondary);
  font-size: 12px;
  line-height: 1.7;
}
</style>

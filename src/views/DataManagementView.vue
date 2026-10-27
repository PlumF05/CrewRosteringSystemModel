<script setup lang="ts">
/**
 * 数据管理页（S5 第三片 / FE-19/20，2026-10-26）：版本化备份导出与受控恢复。
 *
 * 备份 = 单个 JSON 文件（含助理/课程/排班/快照/规则与模板配置），完整备份含
 * 个人资料（电话/QQ）——界面明确标注；不含原始课表 xlsx。
 * 恢复 = 校验（版本/摘要/唯一键/引用）→ 展示范围与数量 → 确认 → 当前数据先存
 * 独立恢复副本 → 单事务整体替换 → 重载校验。失败原数据保持。
 */
import { ref } from 'vue'
import { Download, UploadFilled } from '@element-plus/icons-vue'
import { createBackup, restoreBackup, validateBackup, type BackupValidation } from '../db/backupService'
import { isTauri, saveXlsx } from '../utils/fileAccess'

const exporting = ref(false)
const restoring = ref(false)
const restoreInput = ref<HTMLInputElement>()

/** 校验摘要 + 确认对话框状态 */
const pendingJson = ref('')
const pendingValidation = ref<BackupValidation | null>(null)
const confirmVisible = ref(false)

async function doBackup() {
  exporting.value = true
  try {
    const b = await createBackup()
    const bytes = new TextEncoder().encode(b.json)
    const saved = await saveXlsx(b.filename, bytes)
    if (saved) {
      ElMessage.success(
        b.summary.includesPersonalInfo
          ? `已保存 ${b.filename}（⚠ 含个人资料：电话/QQ，请妥善保管）`
          : `已保存 ${b.filename}`,
      )
      return
    }
    if (isTauri) return // 用户取消另存为——不提示成功
    // 浏览器回退：直接下载
    const blob = new Blob([bytes.buffer as ArrayBuffer], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = b.filename
    a.click()
    URL.revokeObjectURL(url)
    ElMessage.success(`已生成 ${b.filename}`)
  } catch (err) {
    ElMessage.error(err instanceof Error ? err.message : '备份失败')
  } finally {
    exporting.value = false
  }
}

async function onRestoreFile(e: Event) {
  const input = e.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (!file) return
  const json = await file.text()
  const v = validateBackup(json)
  if (!v.ok) {
    ElMessage.error(`备份文件无法使用：${v.errors.join('；')}`)
    return
  }
  pendingJson.value = json
  pendingValidation.value = v
  confirmVisible.value = true
}

async function doRestore() {
  restoring.value = true
  try {
    const r = await restoreBackup(pendingJson.value)
    confirmVisible.value = false
    ElMessage.success(
      `已恢复：${r.recovered.assistants} 名助理、${r.recovered.courses} 条课程、${r.recovered.dutySchedule} 条排班（当前数据已另存恢复副本 #${r.recoveryBackupId}）`,
    )
    // 全量数据已替换——整页重载让所有视图基于新数据重建
    setTimeout(() => window.location.reload(), 800)
  } catch (err) {
    ElMessage.error(err instanceof Error ? err.message : '恢复失败（原数据未受影响）')
  } finally {
    restoring.value = false
  }
}
</script>

<template>
  <el-card>
    <template #header>备份与恢复</template>
    <el-alert
      type="info"
      :closable="false"
      style="margin-bottom: 14px"
      title="备份把全部业务数据（助理/课程/排班/命名快照/规则与模板配置）导出为一个 JSON 文件，可用于换机交接或灾难恢复。恢复是整体替换：当前数据会先另存一份恢复副本。备份不含原始课表 xlsx 文件。"
    />
    <div class="btn-row">
      <el-button type="primary" :icon="Download" :loading="exporting" @click="doBackup">
        导出备份
      </el-button>
      <input ref="restoreInput" type="file" accept=".json" style="display: none" @change="onRestoreFile" />
      <el-button type="warning" :icon="UploadFilled" :loading="restoring" @click="restoreInput?.click()">
        从备份恢复…
      </el-button>
    </div>

    <el-dialog v-model="confirmVisible" title="确认恢复备份" width="520px">
      <template v-if="pendingValidation?.summary">
        <el-descriptions :column="2" border size="small">
          <el-descriptions-item label="助理">{{
            pendingValidation.summary.counts.assistants
          }}</el-descriptions-item>
          <el-descriptions-item label="课程">{{
            pendingValidation.summary.counts.courses
          }}</el-descriptions-item>
          <el-descriptions-item label="排班记录">{{
            pendingValidation.summary.counts.dutySchedule
          }}</el-descriptions-item>
          <el-descriptions-item label="命名快照">{{
            pendingValidation.summary.counts.scheduleSnapshots
          }}</el-descriptions-item>
          <el-descriptions-item label="备份时间" :span="2">{{
            new Date(pendingValidation.summary.exportedAt).toLocaleString()
          }}</el-descriptions-item>
        </el-descriptions>
        <el-alert
          :type="pendingValidation.summary.includesPersonalInfo ? 'warning' : 'info'"
          :closable="false"
          style="margin-top: 10px"
          :title="
            pendingValidation.summary.includesPersonalInfo
              ? '该备份包含个人资料（电话/QQ）'
              : '该备份不含个人资料'
          "
        />
        <div class="hint-b">
          恢复将<b>整体替换</b>当前全部业务数据；当前数据会先另存为恢复副本（最多保留 5 份）；
          撤销/重做链将重置。两台电脑通过备份交接后即为独立副本，不会自动同步。
        </div>
      </template>
      <template #footer>
        <el-button @click="confirmVisible = false">取消</el-button>
        <el-button type="warning" :loading="restoring" @click="doRestore">确认恢复</el-button>
      </template>
    </el-dialog>
  </el-card>
</template>

<style scoped>
.btn-row {
  display: flex;
  gap: 10px;
}
.hint-b {
  margin-top: 10px;
  font-size: 12px;
  color: var(--el-text-color-secondary);
  line-height: 1.8;
}
</style>

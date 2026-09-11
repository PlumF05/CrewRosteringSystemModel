<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { assistantRepo, courseRepo, operationLogRepo } from '../db/repositories'

const assistantCount = ref(0)
const courseCount = ref(0)
const recentLogs = ref<{ id?: number; operatedAt: string; action: string }[]>([])

onMounted(async () => {
  assistantCount.value = await assistantRepo.count()
  courseCount.value = await courseRepo.count()
  recentLogs.value = await operationLogRepo.recent(5)
})

const ACTION_LABEL: Record<string, string> = {
  'assistant.add': '新增助理',
  'assistant.update': '修改助理',
  'assistant.remove': '删除助理',
}
</script>

<template>
  <el-row :gutter="14">
    <el-col :span="6"><el-card><el-statistic title="助理人数" :value="assistantCount" /></el-card></el-col>
    <el-col :span="6"><el-card><el-statistic title="课程记录" :value="courseCount" /></el-card></el-col>
  </el-row>
  <el-card class="logs">
    <template #header>最近操作</template>
    <el-empty v-if="recentLogs.length === 0" description="暂无操作记录" :image-size="60" />
    <div v-for="log in recentLogs" :key="log.id" class="log-row">
      <span>{{ new Date(log.operatedAt).toLocaleString() }}</span>
      <el-tag size="small">{{ ACTION_LABEL[log.action] ?? log.action }}</el-tag>
    </div>
  </el-card>
</template>

<style scoped>
.logs { margin-top: 14px; }
.log-row {
  display: flex; justify-content: space-between; align-items: center;
  padding: 6px 0; border-bottom: 1px dashed var(--el-border-color-lighter);
}
.log-row:last-child { border-bottom: none; }
</style>

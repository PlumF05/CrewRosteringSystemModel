<script setup lang="ts">
/**
 * 仪表盘（S6 / FE-22 升级，2026-10-26）：从"数量展示"升级为**可行动信息**——
 * 缺课表/待核对、当前排班缺口、方案是否需要复核（写入后输入已变化）、快照数量，
 * 每项可点击直达对应页面处理；保留最近操作记录。
 */
import { onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { User, Reading, Camera, Tickets } from '@element-plus/icons-vue'
import {
  assistantRepo,
  courseRepo,
  configRepo,
  dutyScheduleRepo,
  operationLogRepo,
  scheduleSnapshotRepo,
} from '../db/repositories'
import { getDataRevision } from '../db/dataRevision'
import { normalizeRules } from '../algorithms/types'
import { evaluateSchedule } from '../algorithms/evaluate'
import { timetableStatusOf } from '../algorithms/timetableStatus'

const router = useRouter()

const assistantCount = ref(0)
const courseCount = ref(0)
const snapshotCount = ref(0)
const recentLogs = ref<{ id?: number; operatedAt: string; action: string }[]>([])

/** 可行动项（FE-22：缺课表/待核对、缺口、需复核、无排班） */
const actionItems = ref<
  Array<{ key: string; level: 'error' | 'warning' | 'info'; title: string; detail: string; to: string }>
>([])

onMounted(async () => {
  assistantCount.value = await assistantRepo.count()
  courseCount.value = await courseRepo.count()
  snapshotCount.value = await scheduleSnapshotRepo.count()
  recentLogs.value = await operationLogRepo.recent(5)
  await loadActions()
})

/** 计算可行动项（读取为主，量小：≤50 人 × 全部排班行） */
async function loadActions() {
  const items: typeof actionItems.value = []
  const [assistants, courses, allDuty, rulesRaw, curRev, writeRevRaw] = await Promise.all([
    assistantRepo.list(),
    courseRepo.all(),
    dutyScheduleRepo.all(),
    configRepo.get('rules'),
    getDataRevision(),
    configRepo.get<number>('scheduleWriteRevision'),
  ])
  const rules = normalizeRules(rulesRaw as never)

  // ① 课表状态：缺课表 / 待核对（不可参与排班的人）
  const courseCountBy = new Map<number, number>()
  for (const c of courses) courseCountBy.set(c.assistantId, (courseCountBy.get(c.assistantId) ?? 0) + 1)
  const missing = assistants.filter((a) => timetableStatusOf(a, (courseCountBy.get(a.id!) ?? 0) > 0) === 'missing')
  const needReview = assistants.filter((a) => a.timetableStatus === 'needs_review')
  if (missing.length > 0) {
    items.push({
      key: 'missing',
      level: 'warning',
      title: `${missing.length} 人未导入课表（未参与自动排班）`,
      detail: `${missing.slice(0, 5).map((a) => a.name).join('、')}${missing.length > 5 ? ' 等' : ''}——请导入课表或确认无课`,
      to: '/courses',
    })
  }
  if (needReview.length > 0) {
    items.push({
      key: 'review',
      level: 'warning',
      title: `${needReview.length} 人课表含无法识别节次（待核对）`,
      detail: `${needReview.slice(0, 5).map((a) => a.name).join('、')}${needReview.length > 5 ? ' 等' : ''}——请到课程管理修正节次`,
      to: '/courses',
    })
  }

  // ② 当前排班：是否存在 / 是否有缺口（按最近一个有排班的周评价）/ 是否需要复核
  if (allDuty.length === 0) {
    if (assistants.length > 0) {
      items.push({
        key: 'noschedule',
        level: 'info',
        title: '还没有排班——去生成第一份方案',
        detail: `已具备 ${assistants.length} 名助理与 ${courses.length} 条课程记录`,
        to: '/schedule',
      })
    }
  } else {
    const weeks = [...new Set(allDuty.map((r) => r.weekNo))].sort((a, b) => b - a)
    const latest = weeks[0]!
    const weekRows = allDuty.filter((r) => r.weekNo === latest)
    const report = evaluateSchedule({
      rules,
      assistants: assistants.map((a) => ({
        id: a.id!,
        name: a.name,
        identity: a.identity,
        minSections: a.customMinSections,
        maxSections: a.customMaxSections,
      })),
      courses: courses.map((c) => ({
        assistantId: c.assistantId,
        kind: c.kind ?? (c.note ? 'experiment' : 'theory'),
        courseName: c.courseName,
        dayOfWeek: c.dayOfWeek,
        sectionText: c.sectionText,
        weekRanges: c.weekRanges as [number, number][],
      })),
      weekNo: latest,
      assignments: weekRows.map((r) => ({
        dayOfWeek: r.dayOfWeek,
        slotKey: r.timeSlot,
        assistantId: r.assistantId,
        source: r.source,
      })),
    })
    const unmet = report.gaps.filter((g) => g.type === 'slot-understaffed').length
    if (unmet > 0) {
      items.push({
        key: 'unmet',
        level: 'warning',
        title: `第 ${latest} 周有 ${unmet} 个时段人数不足`,
        detail: '可手动补位（点击格子）或用增量重排补齐',
        to: '/schedule',
      })
    }
    if (!report.legal) {
      items.push({
        key: 'illegal',
        level: 'error',
        title: `第 ${latest} 周存在 ${report.violations.length} 项硬违规`,
        detail: '导入新课后旧安排可能违法——建议增量重排或手动处理',
        to: '/schedule',
      })
    }
    // ③ 需复核：写入后业务版本前进（导入/改课/手调）→ 旧方案基于过期输入
    if (writeRevRaw !== undefined && curRev !== writeRevRaw) {
      items.push({
        key: 'stale',
        level: 'info',
        title: '排班输入已变化，当前方案建议复核',
        detail: '上次写入后发生过导入/课程修改/手动调整——可增量重排（输入未变时零改动）',
        to: '/schedule',
      })
    }
  }

  actionItems.value = items
}

function go(to: string) {
  void router.push(to)
}

const ACTION_LABEL: Record<string, string> = {
  'assistant.add': '新增助理',
  'assistant.update': '修改助理',
  'assistant.remove': '删除助理',
  'assistant.timetableStatus': '课表状态确认',
  'course.import': '导入课程表',
  'course.add': '新增课程',
  'course.update': '修改课程',
  'course.remove': '删除课程',
  'rules.update': '修改排班规则',
  'schedule.write': '写入排班',
  'schedule.migrate': '排班数据迁移',
  'schedule.manualAdd': '手动添加排班',
  'schedule.manualRemove': '手动移除排班',
  'schedule.manualMove': '手动移动排班',
  'schedule.lock': '锁定安排',
  'schedule.unlock': '解锁安排',
  'schedule.continuityException': '短段例外登记',
  'schedule.undo': '撤销',
  'schedule.redo': '重做',
  'duty.remove.conflict': '清除冲突排班',
  'snapshot.create': '创建快照',
  'snapshot.restore': '恢复快照',
  'snapshot.delete': '删除快照',
  'backup.restore': '恢复备份',
}
</script>

<template>
  <!-- 可行动信息（FE-22）：点击直达处理页面 -->
  <el-card v-if="actionItems.length" class="actions">
    <template #header>需要处理</template>
    <div
      v-for="item in actionItems"
      :key="item.key"
      class="action-row"
      role="button"
      tabindex="0"
      @click="go(item.to)"
      @keydown.enter="go(item.to)"
    >
      <el-tag :type="item.level === 'error' ? 'danger' : item.level" size="small">
        {{ item.level === 'error' ? '违规' : item.level === 'warning' ? '注意' : '提示' }}
      </el-tag>
      <div class="action-text">
        <div class="action-title">{{ item.title }}</div>
        <div class="action-detail">{{ item.detail }}</div>
      </div>
      <span class="action-go">去处理 →</span>
    </div>
  </el-card>
  <el-card v-else class="actions">
    <template #header>需要处理</template>
    <el-empty description="一切正常：没有缺课表、待核对或排班缺口" :image-size="60" />
  </el-card>

  <el-row :gutter="14" class="stats">
    <el-col :span="6">
      <el-card class="stat-card">
        <div class="stat-row">
          <div class="stat-icon" style="background: linear-gradient(135deg, #4f6ef2, #7a8ef5)"><el-icon><User /></el-icon></div>
          <el-statistic title="助理人数" :value="assistantCount" />
        </div>
      </el-card>
    </el-col>
    <el-col :span="6">
      <el-card class="stat-card">
        <div class="stat-row">
          <div class="stat-icon" style="background: linear-gradient(135deg, #34a870, #6cc79a)"><el-icon><Reading /></el-icon></div>
          <el-statistic title="课程记录" :value="courseCount" />
        </div>
      </el-card>
    </el-col>
    <el-col :span="6">
      <el-card class="stat-card">
        <div class="stat-row">
          <div class="stat-icon" style="background: linear-gradient(135deg, #d98a2b, #e8ae63)"><el-icon><Camera /></el-icon></div>
          <el-statistic title="命名快照" :value="snapshotCount" />
        </div>
      </el-card>
    </el-col>
    <el-col :span="6">
      <el-card class="stat-card">
        <div class="stat-row">
          <div class="stat-icon" style="background: linear-gradient(135deg, #8b5cf0, #b18df5)"><el-icon><Tickets /></el-icon></div>
          <el-statistic title="最近操作" :value="recentLogs.length" description="条（见下）" />
        </div>
      </el-card>
    </el-col>
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
.stat-card :deep(.el-card__body) { padding: 16px 18px; }
.stat-row { display: flex; align-items: center; gap: 14px; }
.stat-icon {
  width: 44px; height: 44px; border-radius: 12px;
  display: flex; align-items: center; justify-content: center;
  color: #fff; font-size: 20px; flex: none;
  box-shadow: 0 4px 10px rgba(30, 41, 82, 0.18);
}
.actions { margin-bottom: 14px; }
.stats { margin-bottom: 14px; }
.logs { margin-top: 0; }
.log-row {
  display: flex; justify-content: space-between; align-items: center;
  padding: 6px 0; border-bottom: 1px dashed var(--el-border-color-lighter);
}
.log-row:last-child { border-bottom: none; }
.action-row {
  display: flex; align-items: center; gap: 10px;
  padding: 8px 6px; border-radius: 6px; cursor: pointer;
  border-bottom: 1px dashed var(--el-border-color-lighter);
}
.action-row:last-child { border-bottom: none; }
.action-row:hover { background: var(--el-fill-color-light); }
.action-text { flex: 1; min-width: 0; }
.action-title { font-size: 13px; }
.action-detail { font-size: 12px; color: var(--el-text-color-secondary); margin-top: 2px; }
.action-go { font-size: 12px; color: var(--el-color-primary); white-space: nowrap; }
</style>

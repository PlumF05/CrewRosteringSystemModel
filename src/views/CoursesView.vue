<script setup lang="ts">
/**
 * 课程表管理页（SRS F05 导入侧 + F06）。
 *
 * 流程：选文件 → 解析预览（学生信息/课程列表/警告）→ 选择归属助理 → 确认入库。
 * 设计要点：
 * - 解析逻辑全部在 utils/courseParser（纯函数，已被真实样例单测覆盖），本组件只做编排；
 * - 解析结果先预览再入库（两阶段提交）：用户能看到警告与课程明细后才落库；
 * - 按"学号"自动匹配助理（样例表头含学生学号），匹配不到时手动选择；
 * - 入库用 replaceForAssistant 整体替换语义：重复导入同一文件 = 幂等。
 */
import { computed, onMounted, ref, watch } from 'vue'
import { ElMessage } from 'element-plus'
import { assistantRepo, courseRepo, operationLogRepo } from '../db/repositories'
import type { Assistant, Course } from '../db/schema'
import { parseTimetableWorkbook, type TimetableParseResult } from '../utils/courseParser'
import { formatWeekRanges } from '../utils/weekParser'

const assistants = ref<Assistant[]>([])
const selectedAssistantId = ref<number>()
const parseResult = ref<TimetableParseResult | null>(null)
const importing = ref(false)
const creating = ref(false)
const storedCourses = ref<Course[]>([])
const fileInput = ref<HTMLInputElement>()

/** 按学号自动匹配助理 */
const matchedAssistant = computed(() =>
  parseResult.value
    ? assistants.value.find((a) => a.studentNo === parseResult.value!.studentNo)
    : undefined,
)

/**
 * 自动创建助理（2026-09-11 新需求）：解析出的学生在库中不存在时，
 * 按学生姓名+学号一键建档；身份由课程条目的（本）/（研）标记推导
 * （出现（研）即研究生，否则本科生）。
 */
const derivedIdentity = computed(() =>
  parseResult.value?.courses.some((c) => c.identity === 'graduate') ? 'graduate' : 'undergrad',
)
const canAutoCreate = computed(
  () =>
    !!parseResult.value &&
    !matchedAssistant.value &&
    !!parseResult.value.studentName &&
    !!parseResult.value.studentNo,
)

async function createAssistantFromParse() {
  const p = parseResult.value
  if (!p?.studentName || !p.studentNo) return
  creating.value = true
  try {
    const id = await assistantRepo.add({
      name: p.studentName,
      studentNo: p.studentNo,
      identity: derivedIdentity.value,
    })
    await operationLogRepo.add('assistant.add', {
      studentNo: p.studentNo,
      name: p.studentName,
      via: 'course-import',
    })
    ElMessage.success(`已自动创建助理：${p.studentName}（${p.studentNo}）`)
    await refreshAssistants()
    selectedAssistantId.value = id
  } catch (err) {
    ElMessage.error(err instanceof Error ? err.message : '创建失败')
    await refreshAssistants()
  } finally {
    creating.value = false
  }
}

async function refreshAssistants() {
  assistants.value = await assistantRepo.list()
}

async function loadStored() {
  storedCourses.value = selectedAssistantId.value
    ? await courseRepo.listByAssistant(selectedAssistantId.value)
    : []
}

watch(selectedAssistantId, loadStored)
onMounted(refreshAssistants)

async function onFileChange(e: Event) {
  const input = e.target as HTMLInputElement
  const file = input.files?.[0]
  if (!file) return
  try {
    const buf = await file.arrayBuffer()
    const result = parseTimetableWorkbook(new Uint8Array(buf))
    if (result.courses.length === 0) {
      ElMessage.error('未解析出任何课程，请确认文件是学院标准课程表')
      return
    }
    parseResult.value = result
    if (matchedAssistant.value) selectedAssistantId.value = matchedAssistant.value.id
    ElMessage.success(
      `解析完成：${result.courses.length} 条课程记录，${result.problems.length} 条警告`,
    )
  } catch (err) {
    parseResult.value = null
    ElMessage.error(err instanceof Error ? err.message : '解析失败')
  } finally {
    input.value = '' // 允许重复选择同一文件
  }
}

async function confirmImport() {
  if (!parseResult.value || !selectedAssistantId.value) return
  importing.value = true
  try {
    const targetId = selectedAssistantId.value
    // ParsedCourse → 落库模型：去掉调试字段 sourceText，补上归属。
    // 必须逐字段构造纯对象：存进 ref 的对象是响应式 Proxy，
    // 直接传给 IndexedDB 会因 structuredClone 不支持 Proxy 抛 DataCloneError（T-008）
    await courseRepo.replaceForAssistant(
      targetId,
      parseResult.value.courses.map((c) => ({
        assistantId: targetId,
        courseNo: c.courseNo,
        courseName: c.courseName,
        kind: c.kind,
        identity: c.identity,
        className: c.className,
        weekRanges: c.weekRanges.map(([s, e]) => [s, e] as [number, number]),
        dayOfWeek: c.dayOfWeek,
        sectionText: c.sectionText,
        sectionStart: c.sectionStart,
        sectionEnd: c.sectionEnd,
        location: c.location,
        note: c.note,
      })),
    )
    await operationLogRepo.add('course.import', {
      studentNo: parseResult.value.studentNo,
      studentName: parseResult.value.studentName,
      count: parseResult.value.courses.length,
    })
    ElMessage.success(`已导入 ${parseResult.value.courses.length} 条课程记录`)
    parseResult.value = null
    await loadStored()
  } catch (err) {
    ElMessage.error(err instanceof Error ? err.message : '导入失败')
  } finally {
    importing.value = false
  }
}
</script>

<template>
  <!-- 导入区 -->
  <el-card class="card">
    <template #header>导入课程表（学院标准 xlsx 格式）</template>
    <input ref="fileInput" type="file" accept=".xlsx,.xls" class="hidden-input" @change="onFileChange" />
    <el-button type="primary" @click="fileInput?.click()">选择课程表文件</el-button>
    <span class="hint">支持学院教务导出的标准课程表（.xlsx）。Word 版请先另存为 xlsx。</span>
  </el-card>

  <!-- 解析预览 -->
  <el-card v-if="parseResult" class="card">
    <template #header>解析预览（尚未入库）</template>
    <el-descriptions :column="3" border size="small">
      <el-descriptions-item label="学生">
        {{ parseResult.studentName || '（未识别）' }}
      </el-descriptions-item>
      <el-descriptions-item label="学号">{{ parseResult.studentNo || '（未识别）' }}</el-descriptions-item>
      <el-descriptions-item label="学期">{{ parseResult.semester || '（未识别）' }}</el-descriptions-item>
    </el-descriptions>

    <el-alert
      v-if="matchedAssistant"
      type="success"
      :closable="false"
      :title="`已按学号匹配到助理：${matchedAssistant.name}（${matchedAssistant.studentNo}）`"
      class="block"
    />
    <template v-else>
      <el-alert type="warning" :closable="false" title="未匹配到该学号的助理" class="block">
        <template #default>
          <span>可手动选择归属，或</span>
          <el-button
            v-if="canAutoCreate"
            link
            type="primary"
            :loading="creating"
            @click="createAssistantFromParse"
          >
            自动创建助理：{{ parseResult.studentName }}（{{ parseResult.studentNo }}，
            {{ derivedIdentity === 'graduate' ? '研究生' : '本科生' }}）
          </el-button>
        </template>
      </el-alert>
    </template>

    <div class="block">
      <span class="label">归属助理：</span>
      <el-select v-model="selectedAssistantId" placeholder="选择助理" style="width: 240px">
        <el-option
          v-for="a in assistants"
          :key="a.id"
          :value="a.id!"
          :label="`${a.name}（${a.studentNo}）`"
        />
      </el-select>
      <el-button
        type="success"
        :disabled="!selectedAssistantId"
        :loading="importing"
        @click="confirmImport"
      >
        确认导入（{{ parseResult.courses.length }} 条）
      </el-button>
    </div>

    <el-alert
      v-for="(p, i) in parseResult.problems"
      :key="i"
      type="warning"
      :closable="false"
      :title="p.reason"
      :description="p.text.slice(0, 80)"
      class="block"
    />

    <el-table :data="parseResult.courses" border size="small" max-height="360">
      <el-table-column prop="courseName" label="课程" min-width="140" />
      <el-table-column prop="courseNo" label="课程号" width="120" />
      <el-table-column label="类别" width="70">
        <template #default="{ row }">
          <el-tag :type="row.kind === 'experiment' ? 'warning' : 'primary'" size="small">
            {{ row.kind === 'experiment' ? '实' : '本' }}
          </el-tag>
        </template>
      </el-table-column>
      <el-table-column label="星期" width="70">
        <template #default="{ row }">星期{{ row.dayOfWeek }}</template>
      </el-table-column>
      <el-table-column prop="sectionText" label="节次" width="130" />
      <el-table-column label="周次" min-width="110">
        <template #default="{ row }">{{ formatWeekRanges(row.weekRanges) }}</template>
      </el-table-column>
      <el-table-column prop="location" label="地点" min-width="150" />
    </el-table>
  </el-card>

  <!-- 已存储课程表（F06 查看功能） -->
  <el-card class="card">
    <template #header>已存储的课程表</template>
    <el-select
      v-model="selectedAssistantId"
      placeholder="选择助理查看课程表"
      style="width: 240px"
      class="block"
    >
      <el-option
        v-for="a in assistants"
        :key="a.id"
        :value="a.id!"
        :label="`${a.name}（${a.studentNo}）`"
      />
    </el-select>
    <el-empty v-if="storedCourses.length === 0" description="该助理暂无课程记录" :image-size="60" />
    <el-table v-else :data="storedCourses" border size="small" max-height="360">
      <el-table-column prop="courseName" label="课程" min-width="140" />
      <el-table-column label="星期" width="70">
        <template #default="{ row }">星期{{ row.dayOfWeek }}</template>
      </el-table-column>
      <el-table-column prop="sectionText" label="节次" width="130" />
      <el-table-column label="周次" min-width="110">
        <template #default="{ row }">{{ formatWeekRanges(row.weekRanges) }}</template>
      </el-table-column>
      <el-table-column prop="location" label="地点" min-width="150" />
    </el-table>
  </el-card>
</template>

<style scoped>
.card { margin-bottom: 14px; }
.hidden-input { display: none; }
.hint { margin-left: 12px; color: var(--el-text-color-secondary); font-size: 12px; }
.block { margin-top: 12px; }
.label { margin-right: 8px; }
</style>

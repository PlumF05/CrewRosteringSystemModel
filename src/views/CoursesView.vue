<script setup lang="ts">
/**
 * 课程表管理页（SRS F05 导入侧 + F06）。
 *
 * 流程（2026-09-13 修订：全自动归档，去掉人工确认步骤）：
 *   选择文件 → 解析 → 按学号自动归属 → 落库（两种情况）→ 结果报告。
 *   情况一「已存在」：用解析结果更新该助理的姓名与身份类型，保留电话/QQ/班级，再导入课程表；
 *   情况二「不存在」：直接新建助理，再导入课程表。
 *   两种情况最终都收口到同一动作 replaceForAssistant（整体替换该助理课程表），故结果一致、可重复导入。
 *
 * 设计要点：
 * - 解析逻辑全部在 utils/courseParser（纯函数，已被真实样例单测覆盖），本组件只做编排；
 * - 学生姓名与学号是自动归属的唯一依据：缺失则直接报错、不落库（避免建错档案）；
 * - 导入是幂等的：重复导入同一文件 = 用同样结果覆盖，不会产生重复记录；
 * - 落库前逐字段构造纯对象：存进 ref 的对象是响应式 Proxy，
 *   直接传给 IndexedDB 会因 structuredClone 不支持 Proxy 抛 DataCloneError（T-008）。
 */
import { onMounted, ref, watch } from "vue";
import { useRouter } from "vue-router";
import { ElMessage } from "element-plus";
import {
  assistantRepo,
  configRepo,
  courseRepo,
  dutyScheduleRepo,
  operationLogRepo,
} from "../db/repositories";
import { importTimetableForStudent } from "../db/importService";
import type { Assistant, Course, Identity } from "../db/schema";
import type { SchedulingRules } from "../algorithms/types";
import { normalizeRules } from "../algorithms/types";
import {
  findDutyConflicts,
  type DutyConflict,
} from "../algorithms/dutyConflict";
import {
  parseTimetableWorkbook,
  type ParseProblem,
  type ParsedCourse,
} from "../utils/courseParser";
import { formatWeekRanges } from "../utils/weekParser";
import { isTauri, openXlsx } from "../utils/fileAccess";
import { IDENTITY_LABEL } from "../utils/dict";

const router = useRouter();

const assistants = ref<Assistant[]>([]);
const importing = ref(false);
const fileInput = ref<HTMLInputElement>();
/** 查看"已存储课程表"所选的助理——与导入流程解耦（导入是自动归档的） */
const viewAssistantId = ref<number>();
const storedCourses = ref<Course[]>([]);

/** 最近一次导入的结果（导入自动完成，此处仅作结果报告与明细查看） */
interface ImportOutcome {
  /** created = 新建助理；updated = 已存在，已更新其信息 */
  action: "created" | "updated";
  studentName: string;
  studentNo: string;
  identity: Identity;
  /** 更新分支下，姓名 / 身份类型是否真的发生了变化 */
  nameChanged: boolean;
  identityChanged: boolean;
  semester: string;
  courses: ParsedCourse[];
  problems: ParseProblem[];
}
const lastImport = ref<ImportOutcome | null>(null);

/** 导入课程表后检测到的冲突排班（排在了该生有课的节次上，SRS F06 第 3 条） */
const conflicts = ref<DutyConflict[]>([]);
const clearing = ref(false);

const ACTION_TEXT: Record<ImportOutcome["action"], string> = {
  created: "新建助理",
  updated: "更新已有助理",
};

/** 身份推导：课程条目出现（研）即研究生，否则本科生（与（本）/（研）标记一致） */
function deriveIdentity(courses: ParsedCourse[]): Identity {
  return courses.some((c) => c.identity === "graduate")
    ? "graduate"
    : "undergrad";
}

async function refreshAssistants() {
  assistants.value = await assistantRepo.list();
}

async function loadStored() {
  storedCourses.value = viewAssistantId.value
    ? await courseRepo.listByAssistant(viewAssistantId.value)
    : [];
}

watch(viewAssistantId, loadStored);
onMounted(refreshAssistants);

async function clearConflicts() {
  const ids = conflicts.value
    .map((c) => c.id)
    .filter((x): x is number => x !== undefined);
  if (ids.length === 0) return;
  clearing.value = true;
  try {
    await dutyScheduleRepo.removeMany(ids);
    await operationLogRepo.add("duty.remove.conflict", {
      studentNo: lastImport.value?.studentNo,
      count: ids.length,
      via: "course-import",
    });
    conflicts.value = [];
    ElMessage.success(`已删除 ${ids.length} 条与课程表冲突的排班记录`);
  } catch (err) {
    ElMessage.error(err instanceof Error ? err.message : "删除失败");
  } finally {
    clearing.value = false;
  }
}

function goReschedule() {
  router.push("/schedule");
}

async function onFileChange(e: Event) {
  const input = e.target as HTMLInputElement;
  const file = input.files?.[0];
  if (!file) return;
  // 浏览器环境回退入口；Tauri 桌面端走 pickAndImport（系统文件对话框）
  await handleBuffer(await file.arrayBuffer());
  input.value = ""; // 允许重复选择同一文件
}

/** Tauri 桌面端：弹出系统「打开」对话框选 xlsx，读取后进入与浏览器一致的解析导入流程 */
async function pickAndImport() {
  const picked = await openXlsx();
  if (!picked) return; // 用户取消
  await handleBuffer(picked.data.buffer as ArrayBuffer);
}

/** 解析 + 自动归档 + 冲突检测的公共主体（浏览器与 Tauri 两种取文件方式收口于此） */
async function handleBuffer(buf: ArrayBuffer) {
  importing.value = true;
  lastImport.value = null;
  conflicts.value = [];
  try {
    const result = parseTimetableWorkbook(new Uint8Array(buf));

    if (result.courses.length === 0) {
      ElMessage.error("未解析出任何课程，请确认文件是学院标准课程表");
      return;
    }
    // 姓名 + 学号是"自动归属"的唯一依据，缺失就无法自动建档/更新 —— 直接报错、不落库
    if (!result.studentNo || !result.studentName) {
      ElMessage.error('未识别到"学生：姓名(学号)"，无法自动归属，本次不导入');
      return;
    }

    // 建档 / 更新 + 导入课程表：两种情况的分支逻辑在 db/importService 内收口，
    // 组件只负责编排与展示（分层纪律：UI 不直接编排数据库）
    const identity = deriveIdentity(result.courses);
    const outcome = await importTimetableForStudent({
      studentName: result.studentName,
      studentNo: result.studentNo,
      identity,
      courses: result.courses,
    });

    lastImport.value = {
      action: outcome.action,
      studentName: result.studentName,
      studentNo: result.studentNo,
      identity,
      nameChanged: outcome.nameChanged,
      identityChanged: outcome.identityChanged,
      semester: result.semester,
      courses: result.courses,
      problems: result.problems,
    };
    await refreshAssistants();
    viewAssistantId.value = outcome.assistantId;
    await loadStored();

    // F06 第 3 条：课程表变更后检测与既有排班的冲突，并提示如何处理
    const savedRules = normalizeRules(
      await configRepo.get<SchedulingRules>("rules"),
    );
    const duties = (await dutyScheduleRepo.all()).filter(
      (d) => d.assistantId === outcome.assistantId,
    );
    conflicts.value = findDutyConflicts({
      rules: savedRules,
      assistantId: outcome.assistantId,
      courses: result.courses.map((c) => ({
        assistantId: outcome.assistantId,
        kind: c.kind,
        dayOfWeek: c.dayOfWeek,
        courseName: c.courseName,
        sectionText: c.sectionText,
        weekRanges: c.weekRanges,
      })),
      duties: duties.map((d) => ({
        id: d.id,
        weekNo: d.weekNo,
        dayOfWeek: d.dayOfWeek,
        timeSlot: d.timeSlot,
        assistantId: d.assistantId,
      })),
    });

    ElMessage.success(
      outcome.action === "created"
        ? `已新建助理「${result.studentName}」并导入 ${outcome.courseCount} 条课程`
        : `已更新助理「${result.studentName}」并导入 ${outcome.courseCount} 条课程`,
    );
  } catch (err) {
    ElMessage.error(err instanceof Error ? err.message : "导入失败");
  } finally {
    importing.value = false;
  }
}
</script>

<template>
  <!-- 导入区：选文件即自动解析 + 自动归属 + 自动落库，无二次确认 -->
  <el-card class="card">
    <template #header>导入课程表（学院标准 xlsx 格式）</template>
    <input
      ref="fileInput"
      type="file"
      accept=".xlsx,.xls"
      class="hidden-input"
      @change="onFileChange"
    />
    <el-button
      type="primary"
      :loading="importing"
      @click="isTauri ? pickAndImport() : fileInput?.click()"
    >
      {{ importing ? "正在解析并导入…" : "选择课程表文件" }}
    </el-button>
    <div class="hint">
      选择文件后系统会<b>自动</b>按表头中的「学生：姓名(学号)」归档：<br />
      ① 该学号已存在 → 更新其姓名与身份类型（电话 / QQ /
      班级保持不动），并导入课程表；<br />
      ② 该学号不存在 → 直接新建助理，并导入课程表。<br />
      两种情况都会<b>整体替换</b>该助理的课程表，重复导入同一文件结果一致。
      若文件未包含学生姓名或学号，则无法自动归属，本次不会写入任何数据。
    </div>
  </el-card>

  <!-- 导入结果报告（导入已自动完成） -->
  <el-card v-if="lastImport" class="card">
    <template #header>
      导入结果
      <el-tag
        :type="lastImport.action === 'created' ? 'success' : 'warning'"
        size="small"
        class="tag-gap"
      >
        {{ ACTION_TEXT[lastImport.action] }}
      </el-tag>
    </template>
    <el-descriptions :column="4" border size="small">
      <el-descriptions-item label="学生">{{
        lastImport.studentName
      }}</el-descriptions-item>
      <el-descriptions-item label="学号">{{
        lastImport.studentNo
      }}</el-descriptions-item>
      <el-descriptions-item label="身份类型">
        {{ IDENTITY_LABEL[lastImport.identity] }}
        <span v-if="lastImport.identityChanged" class="note">（已更新）</span>
      </el-descriptions-item>
      <el-descriptions-item label="学期">{{
        lastImport.semester || "（未识别）"
      }}</el-descriptions-item>
    </el-descriptions>

    <el-alert
      v-if="
        lastImport.action === 'updated' &&
        (lastImport.nameChanged || lastImport.identityChanged)
      "
      type="warning"
      :closable="false"
      class="block"
      :title="`已按课程表更新助理信息：${[lastImport.nameChanged ? '姓名' : '', lastImport.identityChanged ? '身份类型' : ''].filter(Boolean).join('、')}`"
    />
    <el-alert
      v-else-if="lastImport.action === 'updated'"
      type="success"
      :closable="false"
      class="block"
      title="助理信息已一致，仅重新导入了课程表"
    />
    <el-alert
      v-else
      type="success"
      :closable="false"
      class="block"
      :title="`已新建助理「${lastImport.studentName}」（${lastImport.studentNo}）`"
    />

    <el-alert
      v-for="(p, i) in lastImport.problems"
      :key="i"
      type="warning"
      :closable="false"
      :title="p.reason"
      :description="p.text.slice(0, 80)"
      class="block"
    />

    <!-- F06 第 3 条：课程表变更后与既有排班的冲突提示与处理 -->
    <el-alert
      v-if="conflicts.length > 0"
      type="error"
      :closable="false"
      class="block"
    >
      <template #title>
        检测到
        {{
          conflicts.length
        }}
        条已写入排班落在了该生有课的节次上（课程表已更新，建议处理）
      </template>
      <div class="conflict-list">
        <div
          v-for="c in conflicts"
          :key="`${c.weekNo}-${c.dayOfWeek}-${c.timeSlot}`"
        >
          第{{ c.weekNo }}周 星期{{ c.dayOfWeek }} 第{{ c.timeSlot.slice(1) }}节
          —— 课程「{{ c.courseName }}」（{{ c.sectionText }}）
        </div>
      </div>
      <div class="conflict-actions">
        <el-button
          type="danger"
          size="small"
          :loading="clearing"
          @click="clearConflicts"
        >
          删除这些冲突排班
        </el-button>
        <el-button size="small" @click="goReschedule"
          >去排班表重新生成</el-button
        >
      </div>
    </el-alert>

    <el-table
      :data="lastImport.courses"
      border
      size="small"
      max-height="360"
      class="block"
    >
      <el-table-column prop="courseName" label="课程" min-width="140" />
      <el-table-column prop="courseNo" label="课程号" width="120" />
      <el-table-column label="类别" width="70">
        <template #default="{ row }">
          <el-tag
            :type="row.kind === 'experiment' ? 'warning' : 'primary'"
            size="small"
          >
            {{ row.kind === "experiment" ? "实" : "本" }}
          </el-tag>
        </template>
      </el-table-column>
      <el-table-column label="星期" width="70">
        <template #default="{ row }">星期{{ row.dayOfWeek }}</template>
      </el-table-column>
      <el-table-column prop="sectionText" label="节次" width="130" />
      <el-table-column label="周次" min-width="110">
        <template #default="{ row }">{{
          formatWeekRanges(row.weekRanges)
        }}</template>
      </el-table-column>
      <el-table-column prop="location" label="地点" min-width="150" />
    </el-table>
  </el-card>

  <!-- 已存储课程表（F06 查看功能） -->
  <el-card class="card">
    <template #header>已存储的课程表</template>
    <el-select
      v-model="viewAssistantId"
      placeholder="选择助理查看课程表"
      style="width: 260px"
      class="block"
    >
      <el-option
        v-for="a in assistants"
        :key="a.id"
        :value="a.id!"
        :label="`${a.name}（${a.studentNo}）`"
      />
    </el-select>
    <el-empty
      v-if="storedCourses.length === 0"
      description="该助理暂无课程记录"
      :image-size="60"
    />
    <el-table v-else :data="storedCourses" border size="small" max-height="360">
      <el-table-column prop="courseName" label="课程" min-width="140" />
      <el-table-column label="星期" width="70">
        <template #default="{ row }">星期{{ row.dayOfWeek }}</template>
      </el-table-column>
      <el-table-column prop="sectionText" label="节次" width="130" />
      <el-table-column label="周次" min-width="110">
        <template #default="{ row }">{{
          formatWeekRanges(row.weekRanges)
        }}</template>
      </el-table-column>
      <el-table-column prop="location" label="地点" min-width="150" />
    </el-table>
  </el-card>
</template>

<style scoped>
.card {
  margin-bottom: 14px;
}
.hidden-input {
  display: none;
}
.hint {
  margin-top: 10px;
  color: var(--el-text-color-secondary);
  font-size: 12px;
  line-height: 1.8;
}
.block {
  margin-top: 12px;
}
.tag-gap {
  margin-left: 8px;
}
.note {
  color: var(--el-color-warning);
  font-size: 12px;
}
.conflict-list {
  font-size: 12px;
  color: var(--el-text-color-regular);
  line-height: 1.8;
}
.conflict-actions {
  margin-top: 8px;
  display: flex;
  gap: 8px;
}
</style>

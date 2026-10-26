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
import { importTimetableBatch, type BatchItemResult } from "../db/batchImportService";
import {
  addCourse,
  updateCourse,
  removeCourse,
  validateCourseEdit,
  analyzeCourseImpact,
  type CourseEditInput,
} from "../db/courseService";
import type { Assistant, Course, Identity } from "../db/schema";
import type { SchedulingRules } from "../algorithms/types";
import { normalizeRules } from "../algorithms/types";
import {
  findDutyConflicts,
  findDutyNeedsReview,
  type DutyConflict,
  type DutyNeedsReview,
} from "../algorithms/dutyConflict";
import {
  parseTimetableWorkbook,
  type ParseProblem,
  type ParsedCourse,
} from "../utils/courseParser";
import { formatWeekRanges } from "../utils/weekParser";
import { isTauri, openXlsxMultiple } from "../utils/fileAccess";
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
const needsReview = ref<DutyNeedsReview[]>([]);
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

watch(viewAssistantId, () => {
  loadStored();
  runImpact();
});
onMounted(refreshAssistants);

// ---------- F06 手动编辑（S2，2026-10-26）：新增 / 修改 / 删除 + 影响分析 ----------

const emptyCourseForm = (): CourseEditInput => ({
  courseNo: "",
  courseName: "",
  kind: "theory",
  dayOfWeek: 1,
  sectionText: "",
  weeksText: "",
  location: "",
});

const courseDialogVisible = ref(false);
/** null = 新增；有值 = 编辑该课程行 */
const editingCourse = ref<Course | null>(null);
const courseForm = ref<CourseEditInput>(emptyCourseForm());
const courseSaving = ref(false);

/** 删除确认（声明式对话框，行为与助理管理一致） */
const courseRemoveVisible = ref(false);
const courseRemoveTarget = ref<Course | null>(null);

const DAY_OPTIONS = [
  { value: 1, label: "周一" },
  { value: 2, label: "周二" },
  { value: 3, label: "周三" },
  { value: 4, label: "周四" },
  { value: 5, label: "周五" },
  { value: 6, label: "周六" },
  { value: 7, label: "周日" },
];

/** 编辑表单回填：周次区间转回文本（"1-4周,6-17周"风格） */
function openCourseCreate() {
  if (!viewAssistantId.value) {
    ElMessage.warning("请先选择要新增课程的助理");
    return;
  }
  editingCourse.value = null;
  courseForm.value = emptyCourseForm();
  courseDialogVisible.value = true;
}

function openCourseEdit(row: Course) {
  editingCourse.value = row;
  courseForm.value = {
    courseNo: row.courseNo ?? "",
    courseName: row.courseName,
    kind: row.kind ?? "theory",
    dayOfWeek: row.dayOfWeek,
    sectionText: row.sectionText,
    weeksText: formatWeekRanges(row.weekRanges),
    location: row.location ?? "",
  };
  courseDialogVisible.value = true;
}

async function saveCourse() {
  const errors = validateCourseEdit(courseForm.value);
  if (errors.length > 0) {
    ElMessage.error(errors[0]);
    return;
  }
  courseSaving.value = true;
  try {
    if (editingCourse.value) {
      await updateCourse(editingCourse.value.id!, courseForm.value);
      ElMessage.success(`已修改课程「${courseForm.value.courseName}」`);
    } else {
      await addCourse(viewAssistantId.value!, courseForm.value);
      ElMessage.success(`已新增课程「${courseForm.value.courseName}」`);
    }
    courseDialogVisible.value = false;
    await loadStored();
    await refreshAssistants(); // 课表状态可能变化（如待核对 → 已导入）
    await runImpact();
  } catch (err) {
    ElMessage.error(err instanceof Error ? err.message : "保存失败");
  } finally {
    courseSaving.value = false;
  }
}

function askRemoveCourse(row: Course) {
  courseRemoveTarget.value = row;
  courseRemoveVisible.value = true;
}

async function handleCourseRemoveConfirmed() {
  const row = courseRemoveTarget.value;
  if (!row) return;
  try {
    await removeCourse(row.id!);
    courseRemoveVisible.value = false;
    ElMessage.success(`已删除课程「${row.courseName}」`);
    await loadStored();
    await refreshAssistants();
    await runImpact();
  } catch (err) {
    ElMessage.error(err instanceof Error ? err.message : "删除失败");
  }
}

/** 课表变化对当前排班的影响（与导入路径同一套冲突/待核对判定，F06 第 3 条） */
async function runImpact() {
  const id = viewAssistantId.value;
  if (!id) {
    conflicts.value = [];
    needsReview.value = [];
    return;
  }
  const savedRules = normalizeRules(await configRepo.get<SchedulingRules>("rules"));
  const impact = await analyzeCourseImpact(id, savedRules);
  conflicts.value = impact.conflicts;
  needsReview.value = impact.needsReview;
}

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
  const files = Array.from(input.files ?? []);
  input.value = ""; // 允许重复选择同一文件
  if (files.length === 0) return;
  // 浏览器环境回退入口；Tauri 桌面端走 pickAndImport（系统文件对话框）
  if (files.length === 1) {
    await handleBuffer(await files[0].arrayBuffer());
    return;
  }
  // S2 批量导入（FE-05）：多文件逐项处理，逐项报告
  await runBatch(
    files.map((f) => ({ fileName: f.name, data: new Uint8Array() })),
    async (i) => new Uint8Array(await files[i].arrayBuffer()),
  );
}

/** Tauri 桌面端：弹出系统「打开」对话框选 xlsx（支持多选），读取后进入与浏览器一致的解析导入流程 */
async function pickAndImport() {
  const picked = await openXlsxMultiple();
  if (!picked || picked.length === 0) return; // 用户取消
  if (picked.length === 1) {
    await handleBuffer(picked[0].data.buffer as ArrayBuffer);
    return;
  }
  await runBatch(
    picked.map((p) => ({ fileName: p.name, data: new Uint8Array() })),
    async (i) => picked[i].data,
  );
}

// ---------- S2 批量导入（FE-05）：逐项结果 ----------
const batchResults = ref<BatchItemResult[]>([]);
const batchDialogVisible = ref(false);

/** 惰性读取：逐文件取内容、处理完即释放（计划 §8：不同时读取无限文件） */
async function runBatch(
  files: Array<{ fileName: string; data: Uint8Array }>,
  readAt: (index: number) => Promise<Uint8Array>,
) {
  importing.value = true;
  try {
    const results: BatchItemResult[] = [];
    for (let i = 0; i < files.length; i++) {
      const data = await readAt(i);
      const one = await importTimetableBatch([{ fileName: files[i].fileName, data }]);
      results.push(...one);
    }
    batchResults.value = results;
    batchDialogVisible.value = true;
    const ok = results.filter((r) => r.status === "ok").length;
    const bad = results.filter((r) => r.status === "failed").length;
    const skip = results.filter((r) => r.status === "skipped").length;
    ElMessage[bad > 0 ? "warning" : "success"](
      `批量导入完成：成功 ${ok}、失败 ${bad}、跳过 ${skip}`,
    );
    await refreshAssistants();
  } catch (err) {
    ElMessage.error(err instanceof Error ? err.message : "批量导入失败");
  } finally {
    importing.value = false;
  }
}

/** 解析 + 自动归档 + 冲突检测的公共主体（浏览器与 Tauri 两种取文件方式收口于此） */
async function handleBuffer(buf: ArrayBuffer) {
  importing.value = true;
  lastImport.value = null;
  conflicts.value = [];
  needsReview.value = [];
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
    needsReview.value = findDutyNeedsReview({
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
  <!-- 导入区：选文件即自动解析 + 自动归属 + 自动落库，无二次确认（支持一次多选） -->
  <el-card class="card">
    <template #header>导入课程表（学院标准 xlsx 格式，可多选批量）</template>
    <input
      ref="fileInput"
      type="file"
      accept=".xlsx,.xls"
      multiple
      class="hidden-input"
      @change="onFileChange"
    />
    <el-button
      type="primary"
      :loading="importing"
      @click="isTauri ? pickAndImport() : fileInput?.click()"
    >
      {{ importing ? "正在解析并导入…" : "选择课程表文件（可多选）" }}
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

    <!-- P05（2026-10-26）：节次无法识别的课程 × 当天有排班 → 无法判定，必须"待核对"，
         空冲突清单不等于安全 -->
    <el-alert
      v-if="needsReview.length > 0"
      type="warning"
      :closable="false"
      class="block"
    >
      <template #title>
        有 {{ needsReview.length }} 条排班与"节次无法识别"的课程同日，无法自动判定是否冲突，请人工核对
      </template>
      <div class="conflict-list">
        <div
          v-for="n in needsReview"
          :key="`${n.weekNo}-${n.dayOfWeek}-${n.timeSlot}-${n.courseName}`"
        >
          第{{ n.weekNo }}周 星期{{ n.dayOfWeek }} 第{{ n.timeSlot.slice(1) }}节
          —— 课程「{{ n.courseName }}」（节次原文：{{ n.sectionText }}）
        </div>
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

  <!-- 已存储课程表（F06：查看 + 手动编辑） -->
  <el-card class="card">
    <template #header>已存储的课程表</template>
    <div style="display: flex; gap: 8px; align-items: center">
      <el-select
        v-model="viewAssistantId"
        placeholder="选择助理查看课程表"
        style="width: 260px"
      >
        <el-option
          v-for="a in assistants"
          :key="a.id"
          :value="a.id!"
          :label="`${a.name}（${a.studentNo}）`"
        />
      </el-select>
      <el-button
        type="primary"
        :disabled="!viewAssistantId"
        @click="openCourseCreate"
        >新增课程</el-button
      >
    </div>
    <el-empty
      v-if="storedCourses.length === 0"
      description="该助理暂无课程记录（可点「新增课程」手动添加，或上方导入课表）"
      :image-size="60"
      style="margin-top: 12px"
    />
    <el-table
      v-else
      :data="storedCourses"
      border
      size="small"
      max-height="360"
      class="block"
    >
      <el-table-column prop="courseName" label="课程" min-width="140" />
      <el-table-column label="类别" width="60">
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
      <el-table-column prop="location" label="地点" min-width="140" />
      <el-table-column label="操作" width="110" fixed="right">
        <template #default="{ row }">
          <el-button link type="primary" size="small" @click="openCourseEdit(row)"
            >编辑</el-button
          >
          <el-button link type="danger" size="small" @click="askRemoveCourse(row)"
            >删除</el-button
          >
        </template>
      </el-table-column>
    </el-table>
  </el-card>

  <!-- F06 课程编辑对话框（声明式，行为与助理表单一致） -->
  <el-dialog
    v-model="courseDialogVisible"
    :title="editingCourse ? '修改课程' : '新增课程'"
    width="480px"
  >
    <el-form label-width="90px">
      <el-form-item label="课程名" required>
        <el-input v-model="courseForm.courseName" placeholder="如：软件工程" />
      </el-form-item>
      <el-form-item label="课程号">
        <el-input v-model="courseForm.courseNo" placeholder="选填" />
      </el-form-item>
      <el-form-item label="类别">
        <el-radio-group v-model="courseForm.kind">
          <el-radio value="theory">理论（本/研）</el-radio>
          <el-radio value="experiment">实验（实）</el-radio>
        </el-radio-group>
      </el-form-item>
      <el-form-item label="星期" required>
        <el-select v-model="courseForm.dayOfWeek" style="width: 140px">
          <el-option
            v-for="d in DAY_OPTIONS"
            :key="d.value"
            :value="d.value"
            :label="d.label"
          />
        </el-select>
      </el-form-item>
      <el-form-item label="节次" required>
        <el-input
          v-model="courseForm.sectionText"
          placeholder="如：第三节-中课2 / 第一节-第三节"
        />
        <div class="hint-inline">
          节次写原文；无法识别的写法会把该助理课表标记为"待核对"
        </div>
      </el-form-item>
      <el-form-item label="周次" required>
        <el-input
          v-model="courseForm.weeksText"
          placeholder="如：1-4周,6-17周 或 5-17周单周"
        />
      </el-form-item>
      <el-form-item label="地点">
        <el-input v-model="courseForm.location" placeholder="选填" />
      </el-form-item>
    </el-form>
    <template #footer>
      <el-button @click="courseDialogVisible = false">取消</el-button>
      <el-button type="primary" :loading="courseSaving" @click="saveCourse"
        >保存</el-button
      >
    </template>
  </el-dialog>

  <!-- 课程删除确认（声明式对话框） -->
  <el-dialog v-model="courseRemoveVisible" title="删除课程" width="380px">
    <span
      >确定删除课程「{{ courseRemoveTarget?.courseName }}」吗？删除后将立即重新分析对当前排班的影响。</span
    >
    <template #footer>
      <el-button @click="courseRemoveVisible = false">取消</el-button>
      <el-button type="danger" @click="handleCourseRemoveConfirmed"
        >删除</el-button
      >
    </template>
  </el-dialog>

  <!-- S2 批量导入逐项结果（FE-05） -->
  <el-dialog v-model="batchDialogVisible" title="批量导入结果" width="720px">
    <el-table :data="batchResults" border size="small" max-height="380">
      <el-table-column prop="fileName" label="文件" min-width="160" />
      <el-table-column label="结果" width="90">
        <template #default="{ row }">
          <el-tag
            :type="row.status === 'ok' ? 'success' : row.status === 'skipped' ? 'info' : 'danger'"
            size="small"
          >
            {{ row.status === "ok" ? "成功" : row.status === "skipped" ? "跳过" : "失败" }}
          </el-tag>
        </template>
      </el-table-column>
      <el-table-column label="归属" width="150">
        <template #default="{ row }">
          {{ row.studentName ? `${row.studentName}（${row.studentNo}）` : "—" }}
        </template>
      </el-table-column>
      <el-table-column prop="message" label="说明" min-width="240" />
    </el-table>
    <template #footer>
      <el-button type="primary" @click="batchDialogVisible = false"
        >知道了</el-button
      >
    </template>
  </el-dialog>
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
.hint-inline {
  color: var(--el-text-color-secondary);
  font-size: 12px;
  line-height: 1.6;
  margin-top: 2px;
}
</style>

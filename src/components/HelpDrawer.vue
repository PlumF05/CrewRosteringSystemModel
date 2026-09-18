<script setup lang="ts">
/**
 * 使用帮助侧边面板（2026-09-13 增补）。
 *
 * 入口：MainLayout 顶部的"使用帮助"按钮。内容涵盖系统功能介绍、各模块操作步骤
 * 与常见问题，分条呈现；抽屉支持关闭按钮 / ESC / 点击遮罩，关闭后回到原界面，
 * 不影响任何功能。样式沿用 Element Plus 默认风格。
 *
 * 说明内容为静态文案，集中在本组件内便于维护；若后续需要多语言或外链文档，可再抽取。
 *
 * 图文步骤（2026-09-18 增补）：「获取课程表文件」分区内嵌三张操作截图，
 * 素材位于 `src/assets/help/`，通过 ES import 引入（见下方注释的取舍说明）。
 * 截图替换方式：用同名文件覆盖即可；但 `desc` 文案引用了截图内的标注编号，
 * 若新截图的红框位置或标注编号有变化，需同步更新对应 `desc`。
 */
import { ref, watch } from "vue";

/**
 * 图片素材：从教务系统导出课程表的操作步骤（2026-09-18 增补）。
 *
 * 采用 ES import 而非 public/ 静态目录，原因有三：
 *   ① 构建期校验——文件缺失会直接导致构建失败，不会在运行时静默 404；
 *   ② 由 Vite 自动追加内容哈希，浏览器与 WebView2 的缓存可精确失效；
 *   ③ 不依赖 base / 部署路径，浏览器预览与 Tauri 桌面端表现一致。
 */
import step01 from "../assets/help/step-01-course-menu.png";
import step02 from "../assets/help/step-02-timetable-query.png";
import step03 from "../assets/help/step-03-export-excel.png";

/** 单条图文步骤 */
interface HelpStep {
  /** 步骤标题；**不含序号**，序号由 <ol> 自动生成，避免插入 / 重排时静默失配 */
  title: string;
  /** 操作说明 */
  desc: string;
  /** 步骤要点；用于图注与图片替代文本，不含序号（序号由模板派生） */
  caption: string;
  /** 已由 Vite 处理过的图片地址 */
  src: string;
}

/**
 * 「从教务系统获取课程表文件」的三步图文流程。
 * 数组顺序即操作顺序，同时决定大图预览时的翻页顺序。
 *
 * 维护提示：`desc` 引用了截图内的标注编号（"标注 1/2/3"、"红框处"），
 * 替换截图后若标注位置或编号有变化，须同步更新对应 `desc`。
 */
const COURSE_FILE_STEPS: HelpStep[] = [
  {
    title: "登录教务系统，打开顶部「课程」菜单",
    desc: "在教务系统顶部导航栏点击「课程」（图中红框处），进入课程相关功能。",
    caption: "教务系统顶部导航的「课程」入口",
    src: step01,
  },
  {
    title: "「课表查询」→「学生课程表」→「打印」",
    desc: "左侧菜单依次点击「课表查询」（标注 1）与展开后的「学生课程表」（标注 2）；右侧课表显示出来后，点击「打印」按钮（标注 3），打开课表查看页。",
    caption: "课表查询路径与「打印」入口",
    src: step02,
  },
  {
    title: "在课表查看页点击「导出 Excel」",
    desc: "在课表查看页底部工具栏点击「导出 Excel」（图中红框处），即可下载得到 xlsx 文件——该文件正是本系统「课程表管理」需要导入的文件。",
    caption: "导出 Excel，得到可导入的 xlsx",
    src: step03,
  },
];

/** 大图预览的可翻页地址列表（顺序与步骤一致，可在预览中连续浏览三张图） */
const COURSE_FILE_SRCS: string[] = COURSE_FILE_STEPS.map((s) => s.src);

/**
 * 图片预览层的 z-index —— **必须显式设置，请不要删除**。
 *
 * 依据（element-plus 2.14.5 实码核对）：
 *   · `.el-image-viewer__wrapper` 编译后的 CSS 中不含 z-index，且 `ElImageViewer`
 *     的 `zIndex` prop 没有默认值 ⇒ 不传时预览层为 `z-index: auto`；
 *   · 而抽屉经 `useDialog` → `nextZIndex()` 拿到了行内 z-index
 *     （`defaultInitialZIndex = 2000`，每打开一次浮层全局自增）。
 * 因此不设此值时，预览会被抽屉的遮罩盖住，表现为"点了图片没反应"。
 */
const PREVIEW_Z_INDEX = 3000;

const props = defineProps<{ modelValue: boolean }>();
const emit = defineEmits<{ "update:modelValue": [boolean] }>();

const visible = ref(props.modelValue);
watch(
  () => props.modelValue,
  (v) => (visible.value = v),
);

/**
 * 图片放大预览是否打开。
 *
 * 为什么需要它：Element Plus 的模态管理（`hooks/use-modal`）在**模块加载时**就于 document
 * 上注册了 keydown 监听，ESC 会关闭"模态栈顶"（此处即本抽屉），而它只调 `stopPropagation()`
 * ——不能阻止同一元素上的其它监听器；image-viewer 同样在 document 上监听 ESC 关闭自己。
 * 两者按注册顺序执行 ⇒ 不干预的话，按一次 ESC 会把预览与整个帮助面板一起关掉。
 * 解法：预览打开期间禁用抽屉的 ESC 关闭，预览关闭后自动恢复。
 */
const previewOpen = ref(false);

watch(visible, (v) => {
  // 抽屉关闭时复位，避免"预览开着 → 抽屉被关 → ESC 永久失效"的状态残留
  if (!v) previewOpen.value = false;
  emit("update:modelValue", v);
});

/**
 * 默认展开的分区：「快速上手」「获取课程表文件」「常见问题」。
 * 其余分区（助理管理 / 课程表管理 / 排班配置 / 排班表 / 数据与安全）内容较长，默认折叠。
 * 说明：图文步骤一并默认展开，是为了让「文件从哪来」这个前置问题打开帮助即可看到。
 */
const activeNames = ref<string[]>(["quick", "course-file", "faq"]);
</script>

<template>
  <el-drawer
    v-model="visible"
    title="使用帮助"
    direction="rtl"
    size="580px"
    :append-to-body="true"
    :close-on-press-escape="!previewOpen"
  >
    <div class="help">
      <el-alert
        type="success"
        :closable="false"
        title="三步生成排班：导入课程表 → 配置排班规则 → 生成并导出"
        class="intro"
      />

      <el-collapse v-model="activeNames">
        <el-collapse-item name="quick">
          <template #title><b>快速上手（四步）</b></template>
          <ol class="steps">
            <li>
              <b>新增助理</b
              >：进入「助理管理」→「新增助理」(也可直接通过导入课程表时自动新增助理)，填写姓名、学号（全表唯一）、身份类型；
              如需为该助理单独设定值班节数，展开"个性化值班节数"单独设置（不设置则跟随全局默认）。
            </li>
            <li>
              <b>导入课程表</b>：进入「课程表管理」→ 选择学院标准 xlsx
              文件，系统会按表头
              "学生：姓名(学号)"自动建档或更新，并整体替换该生课程表。
              <span class="ref"
                >（该 xlsx
                需先从教务系统导出，见下方「获取课程表文件」图文步骤）</span
              >
            </li>
            <li>
              <b>配置规则</b
              >：进入「排班配置」，设定排班周期、上班节次与各约束；默认值即可直接使用。
            </li>
            <li>
              <b>生成与导出</b>：进入「排班表」→ 选择周次 →「生成方案」预览
              →「写入全部周排班」→ 「导出第 N 周排班」（默认含值班人电话）。
            </li>
          </ol>
        </el-collapse-item>

        <el-collapse-item name="assistants">
          <template #title><b>助理管理</b></template>
          <ul class="items">
            <li>
              新增 / 编辑：姓名、学号（全表唯一）、身份类型、联系电话（11
              位）、QQ、班级。
            </li>
            <li>
              <b>个性化值班节数</b
              >：开启"单独设置"后可为该助理指定最少/最多节数，覆盖全局默认；
              开关开启时会以全局默认值预填。关闭开关即恢复跟随全局（旧覆盖值会被清除）。
            </li>
            <li>
              列表中"值班节数"列：黄色标签表示该助理已单独设置；"跟随全局"表示未设置。
            </li>
            <li>
              <b>删除</b
              >：会同时删除该助理的课程表与排班记录（级联清理、不可恢复），请谨慎操作。
            </li>
          </ul>
        </el-collapse-item>

        <el-collapse-item name="course-file">
          <template #title><b>获取课程表文件（教务系统图文步骤）</b></template>
          <p class="lead">
            本系统导入的 xlsx
            需要先从教务系统导出，按以下三步操作即可。<b>点击图片可放大查看</b>（预览中可用左右箭头连续浏览，按
            ESC 或点击空白处返回）。
          </p>
          <ol class="steps shots">
            <li v-for="(s, i) in COURSE_FILE_STEPS" :key="s.src">
              <b>{{ s.title }}</b>
              <div class="desc">{{ s.desc }}</div>
              <el-image
                class="shot"
                :src="s.src"
                :alt="s.caption"
                :preview-src-list="COURSE_FILE_SRCS"
                :initial-index="i"
                :z-index="PREVIEW_Z_INDEX"
                :preview-teleported="true"
                @show="previewOpen = true"
                @close="previewOpen = false"
              >
                <template #error>
                  <div class="shot-err">图片未加载：{{ s.caption }}</div>
                </template>
              </el-image>
              <div class="caption">图 {{ i + 1 }}　{{ s.caption }}</div>
            </li>
          </ol>
        </el-collapse-item>

        <el-collapse-item name="courses">
          <template #title><b>课程表管理（导入）</b></template>
          <ul class="items">
            <li>仅支持学院标准 <b>xlsx</b> 格式。</li>
            <li>
              导入即自动归档：该学号已存在 →
              更新姓名与身份类型（电话/QQ/班级保留不动）； 不存在 →
              直接新建助理；两种情况都会整体替换该生课程表，重复导入同一文件结果一致。
            </li>
            <li>
              导入完成后若检测到<b>已写入排班与新课程表冲突</b>（排在了有课的节次上），会列出明细，
              并提供「删除这些冲突排班」/「去排班表重新生成」两个处理动作。
            </li>
            <li>
              解析中无法识别的内容会以警告列出（不会静默丢弃），请核对后手工处理。
            </li>
            <li>
              周次写法：<code>1-4周</code>、<code>10周</code>、<code>5-17周单周</code>、<code
                >5-17周双周</code
              >
              等。
            </li>
          </ul>
        </el-collapse-item>

        <el-collapse-item name="config">
          <template #title><b>排班配置</b></template>
          <ul class="items">
            <li><b>排班周期</b>：第 1~30 周，起 ≤ 止。</li>
            <li>
              <b>每人值班节数</b
              >：全局默认的最少/最多节数；个别助理可在「助理管理」中单独设置覆盖。
            </li>
            <li><b>同时段人数</b>：同一时段最少/最多在岗人数。</li>
            <li>
              <b>工作日与上班节次</b>：默认周一~周五、上午 1~4 节与下午 6~9 节；
              各区间<b>不能重叠</b>。
            </li>
            <li><b>排班模式</b>：各周独立（按每周课程分别计算）｜各周相同。</li>
            <li><b>课程占用过滤</b>：理论课 / 实验课是否计入占用。</li>
            <li>
              <b>最少连续值班节数</b>：大于 1 时，孤立的单节值班不会被安排。
            </li>
            <li>
              修改配置后需<b>重新生成排班</b>才会生效；已写入的旧排班不会自动消失。
            </li>
          </ul>
        </el-collapse-item>

        <el-collapse-item name="schedule">
          <template #title><b>排班表（生成 / 写入 / 导出）</b></template>
          <ul class="items">
            <li>「生成方案」：一次性生成周期内全部周，仅预览、不落库。</li>
            <li>
              每周方案可查看：时段网格、未满足时段、重排变动明细、每人工时（含各自目标区间）。
            </li>
            <li>
              「写入全部周排班」：清空各周后写入（覆盖旧排班），请确认后再写入。
            </li>
            <li>
              「导出第 N 周排班」：生成 xlsx，
              默认含值班人<b>电话</b>（姓名与电话上下两行）；关闭"含电话"则只导出姓名。
            </li>
          </ul>
        </el-collapse-item>

        <el-collapse-item name="faq">
          <template #title><b>常见问题</b></template>
          <ul class="faq">
            <li>
              <b>为什么有人被排在上课时间？</b>
              多半是该课程未导入、周次不覆盖等原因。
              课程表更新后请重新生成排班；导入时系统也会提示与既有排班的冲突。
            </li>
            <li>
              <b>为什么某天 / 某时段没有人？</b>
              通常容量不足（每人最多节数、每时段人数上限）或该时段全员有课。可提高上限、
              增加助理等。
            </li>
            <li>
              <b>改了排班配置，为什么旧排班看起来变空 / 缺了几行？</b>
              排班表按当前规则显示，改过上班节次或工作日后，建议重新生成；
              已写入的数据不会丢失，重新生成即可对齐。
            </li>
            <li>
              <b>删除助理会影响什么？</b>
              其课程表与排班记录会一并删除且不可恢复；如需保留请先导出排班表备份。
            </li>
          </ul>
        </el-collapse-item>

        <el-collapse-item name="data">
          <template #title><b>数据与安全</b></template>
          <ul class="items">
            <li>
              全部数据保存在<b>本机</b>浏览器数据库（IndexedDB），不联网、不上传。
            </li>
            <li>建议定期导出排班表留存备份。</li>
            <li>清理浏览器站点数据会连带删除本系统数据，请谨慎操作。</li>
            <li>导出文件包含联系电话时，请妥善保管，避免个人信息外泄。</li>
          </ul>
        </el-collapse-item>
      </el-collapse>
    </div>
  </el-drawer>
</template>

<style scoped>
.help {
  padding: 0 4px;
}
.intro {
  margin-bottom: 12px;
}
.steps {
  margin: 0;
  padding-left: 18px;
}
.steps li {
  margin-bottom: 8px;
  line-height: 1.7;
}
.items,
.faq {
  margin: 0;
  padding-left: 18px;
}
.items li,
.faq li {
  margin-bottom: 8px;
  line-height: 1.7;
}
.faq li b {
  display: block;
  margin-bottom: 2px;
}
/* ---------- 图文步骤（从教务系统导出课程表） ---------- */
.lead {
  margin: 0 0 10px;
  line-height: 1.7;
  color: var(--el-text-color-regular);
}
.ref {
  font-size: 12px;
  color: var(--el-text-color-secondary);
}
.shots > li {
  margin-bottom: 18px;
}
.shots .desc {
  margin: 2px 0 8px;
  line-height: 1.7;
}
/* 图片按容器宽度等比铺满；未约束高度 ⇒ 不会产生 object-fit 效果，故不设 fit 属性 */
.shot {
  display: block;
  width: 100%;
  min-height: 80px;
  cursor: zoom-in;
  border: 1px solid var(--el-border-color-light);
  border-radius: 4px;
  overflow: hidden;
  background: var(--el-fill-color-lighter);
}
/* EP 默认给 __inner 的是 width:100%;height:100%；容器高度由内容决定时百分比高度会退化为
   auto。此处显式写 height:auto，让"按原图比例显示"成为明确意图，而非依赖该隐式退化 */
.shot :deep(.el-image__inner) {
  display: block;
  width: 100%;
  height: auto;
}
.caption {
  margin-top: 6px;
  text-align: center;
  font-size: 12px;
  color: var(--el-text-color-secondary);
}
.shot-err {
  padding: 28px 8px;
  text-align: center;
  font-size: 12px;
  color: var(--el-text-color-secondary);
}
code {
  background: var(--el-fill-color-light);
  padding: 0 4px;
  border-radius: 3px;
}
</style>

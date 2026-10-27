# CRSM 学习指南（AI 完成后学习版，2026-10-26）

> 本文档面向"系统已由 AI 完整实现并通过验证（FE-01~24），现在你要系统学习这套代码与设计"的读者。
> 假设：有后端基础（数据库、事务、HTTP），前端从零讲起。旧版分阶段教学契约已随 2026-10-26 目标重定向归档（git 历史）。
>
> 配套：[十分钟演示脚本](DEMO-SCRIPT.md)（先跑一遍建立直觉）｜[术语表](../GLOSSARY.md)｜[验证台账](implementation/VERIFICATION.md)（每项能力都有证据编号）。

## 一、代码地图（真实文件导航）

```text
src/
├─ algorithms/               ★ 纯函数算法层（不 import Vue/Dexie——可在 Node 直接测试）
│  ├─ types.ts               领域类型 + 规则校验(validateRules) + 8~11 歧义警告
│  ├─ greedy.ts              贪心排班：主分配 → 修复⇄撤销迭代 → 每日均衡 → 终态清理(P08)
│  ├─ evaluate.ts            ★ 独立评价器：硬违规/软缺口分级（所有写路径的终审）
│  ├─ incremental.ts         增量重排：零改动快路径 + 基准锚定 + 带原因差异(FE-13)
│  ├─ improve.ts             有界局部改良：双预算爬山，永不劣于基线(FE-14)
│  ├─ dutyConflict.ts        已写入排班 vs 新课表的冲突/待核对检测
│  └─ timetableStatus.ts     课表四分类(已导入/确认无课/待核对/未导入)
├─ db/                       数据层（Dexie/IndexedDB）
│  ├─ database.ts            schema v1→v4 迁移链（v3 清空归档的原因写在注释里）
│  ├─ repositories.ts        仓储：UI 永远经由这里，不直接碰 Dexie
│  ├─ dataRevision.ts        ★ 业务版本 CAS：所有写事务的地基(FE-11)
│  ├─ importService.ts       单文件导入（单事务原子，FE-06）
│  ├─ batchImportService.ts  批量导入：逐项结果/同内容跳过/同号冲突(FE-05)
│  ├─ courseService.ts       课程手动编辑 + 影响分析(FE-07)
│  ├─ manualAdjustService.ts 手调五操作 + 撤销日志 + 评价器差分(FE-08/10)
│  ├─ scheduleService.ts     全周期原子保存 + 锁定携带(FE-12)
│  ├─ snapshotService.ts     命名快照：创建/对比/受控恢复(FE-16)
│  └─ backupService.ts       备份/恢复：五类校验 + 恢复副本(FE-19/20)
├─ workers/                  Web Worker（FE-15）
│  ├─ scheduleJob.ts         三阶段内核（生成→改良→评价，纯函数）
│  ├─ scheduleWorker.ts      消息协议（jobId/progress/result，不写库）
│  └─ scheduleClient.ts      客户端：取消/超时/迟到消息丢弃/主线程回退
├─ templates/                双模板（FE-17）：受控字段 + 版本化 + 试解析
├─ views/                    页面（路由懒加载）；components/ 是拆出的重组件
└─ utils/                    courseParser(课表解析)/weekParser/sectionOrder(节次序号轴)/scheduleExport
```

**分层纪律**：`views → db 服务层 → repositories → Dexie`；`algorithms` 是纯函数孤岛。找不到一个"UI 直接写库"的例子——这是刻意的。

## 二、五条关键调用链（跟读代码的路线）

1. **导入一条课表**（浏览器选文件）：
   `CoursesView.handleBuffer → templateService.getActiveImportTemplate → courseParser.parseTimetableWorkbook(锚点可配) → importTimetableForStudent（withDataRevision 单事务：建档→替换课程→状态重算→日志→版本+1）→ findDutyConflicts/findDutyNeedsReview（影响反馈）`
   学习点：Dexie 事务的"表清单必须列全"（V-014 踩过坑）；同内容/同号冲突在 batchImportService。

2. **生成 17 周方案**：
   `ScheduleView.generate → 四分类过滤(schedulable) → ScheduleWorkerClient.run（Worker 或主线程回退）→ scheduleJob.runScheduleJob：scheduleAll → improveWeek×N → evaluateAllWeeks → 预览（写入时 CAS 校验 previewedRevision）`
   学习点：Worker 不写库红线；迟到消息双重防护（jobId + 闭包 done）。

3. **手动调整一格**：
   `网格点击 → ManualAdjustDialog → manualAdjustService.addManualAssignment（withDataRevision：toEvaluation 改后整周 → evaluateSchedule → diffViolations(改前 vs 改后) → 新增违规即拒）→ appendJournal（撤销日志同事务）`
   学习点：差分校验让"遗留旧问题不阻塞新操作"；短段例外只豁免连续性。

4. **增量重排**：
   `generate(增量) → incrementalSchedule：inputsUnchanged? → 零改动快路径 ：(基准行全作 keep，锁定=manual/自动=auto) scheduleAll → diffWeek(kept/added/removed/replaced + 原因)`
   学习点：KeepEntry.source 让自动安排保留后不冒充手动；范围外周直接 baselineAsWeek。

5. **备份恢复（换机）**：
   `DataManagementView → validateBackup（版本/摘要/唯一键/引用）→ 恢复副本入 recovery_backup 表 → withDataRevision 整体替换 → 重载校验记录数`
   学习点：为什么"先存副本再替换"；失败时 Dexie 回滚保住原数据。

## 三、算法讲解（为什么这样设计）

- **三层防线**（P01~P08 的教训）：入口校验（greedy 预占）→ 过程约束（修复/撤销/均衡）→ **独立终态评价**（evaluate.ts）。求解器"自称合法"不算数——所有写路径（含手调/恢复）都过同一评价器做差分。
- **节次序号轴**（utils/sectionOrder.ts）：课程表节次是"数字+中课/晚课"混排，排班表编号必须与课程表同一体系——按当日先后序号比较，且连续段不跨午休。这是历史上"在上课时间排班"缺陷的根治。
- **有界改良 = 爬山而非最优**：只在合法基线上做"严格变优才应用"的移动，双预算内停止并如实报告 stopReason——不虚称最优（FE-14 边界）。
- **增量 = 基准锚定**：把已写入方案全部作为保留项喂给求解器，非法项被入口校验拒绝并携带原因——变化自然只发生在约束被迫处；输入未变时连求解都不跑（零改动）。

## 四、事务与并发（后端类比）

- `dataRevision` ≈ 乐观锁版本列：`withDataRevision(expected, tables, fn)` 在**同一个** IndexedDB 读写事务里"校验→写→版本+1"。两个窗口基于同一旧版本保存，后提交者 StaleDataError（concurrency.test.ts 用两条真实 Dexie 连接验证过）。
- 撤销链是**日志而非状态快照**：每操作记逆操作所需信息（add 记整行、move 记双向），撤销=在新 CAS 事务里应用逆操作并再过评价器——"课程变了导致撤销会产生冲突"会被拒绝，这是快照式 undo 做不到的。

## 五、分步练习（每步都有真实代码可对照）

1. **跑通并读测试**：`npm test` → 打开 `src/algorithms/evaluate.test.ts`，改一个断言故意弄错，看哪条红线先红。
2. **加一种软缺口**：在 evaluate.ts 的 gaps 里加"单人单日超过 N 节提示"（读 metrics 已有数据，模仿 assistant-below-min 写法），补 3 个用例。
3. **给批量导入加"重试失败项"按钮**：读 batchImportService 的结果结构，在 CoursesView 只把 status==='failed' 的文件重新喂给 runBatch。
4. **体验 CAS**：开两个浏览器窗口都打开应用，两边同时手动调整同一周的同一格——后保存的一方应看到"数据已被其他窗口修改"。
5. **跑性能基准并压测**：`npx vite-node scripts/perf-bench.ts`；把 PARTS 调到 100 人×17 周重跑，记录数据填进 VERIFICATION.md 的新条目（诚实记录超标也算合格练习）。
6. **离线打包**：按 README「离线安装包构建」下载安装器 → `npm run tauri build` → 记录 SHA-256；找一台没有 WebView2 的机器（或新装虚拟机）断网安装。

## 六、项目经历事实表（写简历/答辩只用有证据的）

| 能力 | 事实与证据 |
| --- | --- |
| 约束求解 | 纯 TS 贪心+增量+有界改良三层算法；独立评价器终审；修复基线缺陷 P01~P08（V-007~V-010） |
| 数据可靠性 | IndexedDB 事务原子（导入/保存/手调/恢复）；乐观锁 CAS；双连接并发验证无丢失更新（V-016） |
| 隐私工程 | 导出隐私断言（无学号/QQ、电话开关全 sheet 生效、公式注入边界）；git 历史真实数据清洗（D-02） |
| 性能 | 50 人×17 周全链路 1250ms（口径 5s）；入口包体 -22%（V-023） |
| 工程化 | 298 项测试；GitHub Actions CI（测试+构建+性能回归）；版本化备份/恢复演练；WebView2 离线安装包（V-024） |

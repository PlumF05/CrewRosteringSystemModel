# 验证记录（VERIFICATION）

## 当前目标与最新基线（2026-10-26）

当前执行目标已改为纯前端原架构完善，见 CRSM-FRONTEND-IMPROVEMENT-PLAN.md。下面早期 Web 目标的环境阻塞和依赖计划只保留历史，不是当前完成条件。

- 复核 HEAD：3d3a44e。
- 实际执行 npm test：10 个测试文件/111 个用例通过；greedy.test.ts 因 regression-3assistants.json 缺失而无法加载，整条测试命令退出 1。此时不能声称全部 162 个用例通过。
- **2026-10-26 更新（V-005）**：缺失夹具已按计划用脱敏数据恢复，npm test **11 文件/162 用例全部通过**；npm run build 复验通过（661ms，大分块警告仍在）。
- 实际执行 npm run build：类型检查与 Vite 构建通过；仍有大分块警告，fileAccess 约 866 kB、入口约 1024 kB（压缩前）。
- 本轮功能、Tauri 安装包、原生 Worker、数据库升级和跨机恢复尚未实现或验证；新 FE-01～FE-24 均保持 pending。
- 本次产物为方案、执行目标、台账重定向与历史归档，没有修改应用源码或安装数据库。

> 每条验证记录：编号、日期、内容、命令/方式、结果、结论边界（能证明什么/不能证明什么）。
> 台账规则：ACCEPTANCE.md 中标 verified 的项必须能指回本文件的条目。

## V-001 环境探测（2026-10-24）

- Python 3.12.4（`D:\python\python.exe`）；`py` 启动器另有 3.14.0；uv 可用（0.x）。
- **Docker 不在 PATH，PostgreSQL 未安装** → PG 并发/部署/恢复类验收（A20/A21/A23/A29/A31 部署侧）暂列环境阻塞，不得用 SQLite 冒充通过。
- Node v24.18.0、npm 11.16.0。
- 前端基线：162 用例通过（原 38aaa2b，现 f86f6b6，见 D-02 映射）。
- 边界：仅证明探测当日 PATH 可见性，不证明机器绝无安装。

## V-002 git 历史清洗与强推（2026-10-26，对应 DECISIONS.md D-02）

清洗前侦察（本地执行）：

- 历史含 9 个 xlsx：3 个真实姓名文件（王五/赵四/李四.xlsx）、timeTableForStu12.xlsx(+~$锁文件)、test-export.xlsx（二进制，含真实格式手机号）、samples/示例学生A/B/C.xlsx（脱敏，保留）。
- 回归夹具 `regression-3assistants.json` 为真实课表 dump（仅姓名+课程，无电话/学号字段）。
- 提交信息 4 条含真实姓名（"Delete 王五/赵四.xlsx"）。
- 手机号模式扫描：真实格式命中均在 test-export.xlsx（二进制）与 Cargo.lock 哈希子串（误报）；测试源码仅 13800000001/2 假号码。

执行：`git filter-repo --force --invert-paths --path 王五.xlsx --path 赵四.xlsx --path 李四.xlsx --path timeTableForStu12.xlsx --path '~$timeTableForStu12.xlsx' --path test-export.xlsx --path src/algorithms/__fixtures__/regression-3assistants.json --replace-text <规则> --replace-message <规则>`

清洗后验证（全部通过）：

| 检查 | 命令（摘要） | 结果 |
|------|-------------|------|
| xlsx 残留 | `git log --all --name-only` + grep xlsx | 仅 samples/示例学生A/B/C.xlsx |
| 真实姓名 | `git log -S` + `--grep` 四个名字（blob+信息） | 零命中 |
| 手机号 | `git grep -oE '1[3-9][0-9]{9}'` 全历史 | 仅 13800000001/2 与 Cargo.lock 哈希误报 |
| 工作区 | `git status` | 干净，文件内容零变化 |
| 提交数 | `git rev-list --all --count` | 49 → 41（空提交剪除） |

推送：`git push origin --force --all` + `--force --tags` 成功；远端 main=f86f6b6、fullstack=9b75973、feat-schedule-rules-hardening=390835c、tag v0.1.0=f86f6b6（`git ls-remote` 复核）。

边界：不证明 GitHub 服务端旧对象立即消失（GC 前仍可能按 SHA 访问，见 D-02 残余风险）；不证明无人曾 clone。

## V-003 后端依赖锁定与冒烟（M0.3，已因目标重定向终止）

2026-10-26 实际执行与结果：

- `uv init --bare` 完成（backend/pyproject.toml、.python-version=3.12）；用户级 `UV_CACHE_DIR=D:\uv\cache`、`UV_PYTHON_INSTALL_DIR=D:\uv\python`（D 盘约束，旧缓存 330K 已迁移）。
- `uv add django==5.2.18 ... or-tools ...` 两次失败：报 "or-tools was not found in the package registry"（清缓存后仍复现；git-filter-repo 等小包可正常安装，原因未定位）。此时先前的 pip 版 venv 已删除，**backend/.venv 现为 uv 创建的空环境，Django 不再在其中**。
- 边界：仅记录 Web 目标终止时的环境事实；新目标（纯前端）不依赖这些组件，不再追查 or-tools 解析问题。

## V-004 → 由 V-005 承接（编号保留说明）

（台账切换期间 V-004 编号被并行会话预留又未落文；为避免歧义，夹具恢复证据直接使用 V-005。）

## V-023 S6：性能实测、包体优化、主页可行动信息、页面拆分与 CI（2026-10-26，FE-22）

- **性能基准**（新 `scripts/perf-bench.ts`，固定 seed=20261026 可复现，Node v24.18.0）：
  - ① 50 助理 × 17 周 × 5 天 × 8 节（600 门随机课/680 时段）：生成 59ms + 逐周有界改良 1178ms + 独立终态评价 13ms = **合计 1250ms ≤ 5000ms 口径 PASS**（合法=true，0 缺口）；
  - ② 标准课表解析（脱敏样例 A.xlsx，42 门课）：**9ms ≤ 3000ms PASS**（预热后计测）。
- **包体实测与优化**（先测后改，未调高警告阈值）：基线入口 1004KB → 引入 unplugin-auto-import/components + ElementPlusResolver 按需引入（移除 7 个视图的显式 ElMessage 导入，模板 slot 类型补断言，声明文件纳入 tsconfig 并随仓库分发）→ **入口 783KB（gzip ~250KB，-22%）**；xlsx 重依赖（854KB chunk）确认**不在首屏**（课程/排班页懒加载）；桌面应用为本地资源加载。构建大分块警告保留如实。
- **主页可行动信息**（DashboardView 重写）：缺课表人数、待核对人数、最近周排班缺口数、硬违规数、"输入已变化建议复核"（dataRevision≠scheduleWriteRevision）、无排班引导——逐项点击直达对应页；统计卡 + 操作日志补全全部动作文案。
- **页面拆分**：快照管理从 ScheduleView 抽出为 `ScheduleSnapshotsCard.vue`（自包含加载/对话框，restored 事件通知父层刷新）——ScheduleView 含此前 ManualAdjustDialog 共完成两处拆分。
- **CI 基础**（`.github/workflows/ci.yml`）：push/PR 触发，windows-latest + Node 22，npm ci → npm test → npm run build → 性能基准回归（超口径即失败）。
- **结果**：`npx vitest run` **298/298**；`npm run build` 通过。
- **边界**：常用页面"可交互 ≤2 秒"在桌面本地资源下由架构保证（无网络依赖），未做逐页秒表录屏——S7 安装验收时以真实桌面包复核；E2E 浏览器自动化脚本未引入（FE-22 未强制），主流程人工核验记录归 S7 演示。

## V-022 S5 第三片：备份恢复与升级兼容（2026-10-26，F05/FE-19/20/21）

- **schema v4**（database.ts）：仅新增 `recovery_backup` 表（恢复前副本，与主数据隔离），不动存量数据——升级无损。
- **备份**（新 `src/db/backupService.ts`）：跨表**只读事务**取一致快照（助理/课程/排班/命名快照/规则与模板配置；派生键 dataRevision/adjustJournal/scheduleWriteRevision 不入备份）→ 事务外序列化 + 内容摘要（FNV，仅检错）；`includesPersonalInfo` 明确标注（电话/QQ 存在即 true）；文件名 `crsm-backup-YYYYMMDD-HHmm.json`；不含原始 xlsx（界面说明）。
- **校验**：非 JSON/未知更新版本（拒绝并提示升级程序）/摘要不一致（篡改检测）/学号与排班复合键唯一/课程排班引用完整性——任一不过拒绝恢复；纯数据 JSON，不执行任何代码。
- **受控恢复**：校验 → UI 展示范围数量与个人资料警示 → ①当前数据先存 recovery_backup 独立副本（保留最近 5 份，不随主数据清空）→ ②单写事务整体替换（保留原 id）+ 撤销链重置 + dataVersion 前进 + 来源日志 → ③重载校验记录数一致。②失败 → Dexie 回滚，原数据保持（故障注入已验）。
- **UI**：新「数据管理」页（/data + 菜单）——导出备份（Tauri 另存为/浏览器下载；取消不提示成功）与从备份恢复（校验摘要确认对话框 → 恢复 → 整页重载）。
- **测试**（backupService.test.ts，6 例）：一致备份与摘要复验、五类拒绝、恢复成功（替换/撤销链重置/版本前进/副本含恢复前脏数据）、注入失败回滚原数据完整、**空库（第二台机器）恢复一致**、v3 数据经 v4 新连接打开无损 + recovery_backup 可用。**298/298**（26 文件）；build 通过。
- **边界**：恢复副本的"还原恢复副本"操作未做 UI（副本可通过开发者工具/后续版本导出）——已记录为已知限制；真实断网跨机物理演练归 FE-23。
- **边界补充（2026-10-26 自查）**：快照恢复的"复核"与"替换"是两步（复核在事务外）——两者之间发生并发写入的竞态窗口在桌面单用户场景下可接受，不引入额外锁；备份恢复同理由校验前置+单事务保证失败安全。

## V-021 S5 第二片：多周/历史导出与隐私断言（2026-10-26，F05/FE-18）

- **多周工作簿**（scheduleExport.ts 增 `buildMultiWeekWorkbook/FileBuffer`）：每周一个 sheet（「第N周」网格 + 含电话时「第N周值班明细」），版式沿用启用中的导出模板；UI：排班页「导出多周工作簿」（按当前周期已写入数据，Tauri 另存为/浏览器下载回退）。
- **历史快照导出**（snapshotService 增 `buildSnapshotExportBuffer`）：行/规则/姓名全部取自快照 meta **固定信息**（人员已删除仍显示原名、不被当前规则重解释）；快照不含联系方式 → 导出永不含电话；UI：快照表「导出」动作。
- **隐私与文本边界断言**（测试覆盖，全部 sheet 全部单元格扫描）：关电话 → 电话零出现且明细 sheet 不生成；开电话 → 电话仅出现在姓名格与明细表；两种模式下学号样式数字（/20\d{8}/）零出现；全部单元格 type≠'f'（文本按文本写出，不执行公式）——含以 `=` 开头的恶意姓名仍为文本的边界用例。
- **结果**：`npx vitest run` **292/292**（25 文件，新增多周/隐私/文本边界 4 例 + 快照固定信息 1 例）；`npm run build` 通过。
- **边界**：打印版式的视觉抽检（纸质可读性）归 FE-22/S6 人工检查项；导出日期正确性由系统时间函数保证（scheduleFileName 既有测试）。

## V-020 S5 第一片：双模板管理（2026-10-26，F07/FE-17）

- **受控字段模型**（新 `src/templates/types.ts`）：导入模板 = 解析器三锚点（表头/学生标识正则/学期正则），导出模板 = 标题模板({week} 占位)/表头首列/两档列宽/简洁打印开关——**有限配置集**，不做通用解析器/脚本（计划红线）。校验：正则可编译、占位符与列宽范围。
- **服务**（新 `src/templates/templateService.ts`）：config 键持久化；**内置模板**（学院标准导入 + 学院默认版/简洁打印版两套导出）不可改不可删、随代码升级重建；自定义模板保存即 **formatVersion+1 并入版本历史**（上限 20，恢复历史=按快照生成新版本，不改写历史）；启用切换即时生效（失效 id 自动回退内置）；**试解析**用真实文件跑启用映射、给出归属/课程预览/警告且零写入。
- **参数化**：`parseTimetableWorkbook(data, mapping?)`（非法正则安全回退默认）与 `buildScheduleWorkbook(input, style?)`（compact=无底色/无灰字）均向后兼容（40 项旧测试全绿）。
- **接线**：单文件/批量导入使用启用中的导入模板映射；排班导出使用启用中的导出模板样式。新页面 **模板管理**（路由 /templates + 菜单）：双 Tab 表格（启用单选/版本/内置标记）、编辑对话框、版本历史恢复、试解析对话框（选文件→预览前 5 条课程）。
- **测试**：templateService.test.ts 8 例（内置齐备、版本化/恢复链、内置保护、回退、受控校验、试解析真实样例零写入+错误锚点失败不抛）+ scheduleExport 增 1 例（自定义标题/表头/列宽生效、简洁版式无填充、无模板默认行为不变）。**287/287**（25 文件）；build 通过。
- **边界**：历史快照导出使用快照固定信息归 S5-2；GUI 点击流程归 S6。

## V-019 S4 第三片：排班 Web Worker（2026-10-26，FE-15）

- **计算内核**（新 `src/workers/scheduleJob.ts`，纯函数）：生成（scheduleAll）→ 逐周有界改良（improveWeek）→ 独立终态评价（evaluateAllWeeks）三阶段，带百分比进度回调；Worker 与主线程回退路径共用同一实现。
- **Worker**（新 `src/workers/scheduleWorker.ts`）：消息协议 run/progress/result/error，均携带 jobId；**只计算不 import 任何 db 模块**（不写 IndexedDB 红线）。
- **客户端**（新 `src/workers/scheduleClient.ts`）：jobId 单调递增；**旧 jobId 迟到消息丢弃 + 闭包级 done 标志**（终结后忽略一切消息，覆盖 terminate 竞态）；取消 = terminate（当前排班零改动）；超时（默认 30s）自动取消；Worker 不可用时回退主线程同一实现（协议不变）。
- **UI**：全量生成改经 Worker——进度条 + 阶段文案 + 「取消计算」按钮；取消/超时明确提示"当前排班未受影响"；结果经独立校验不合法则放弃并报错（防御性，不应触发）。
- **构建证据**：`npm run build` 产出独立 `scheduleWorker-*.js` chunk（dist/assets 实测存在）。
- **测试**（scheduleClient.test.ts，6 例，假 Worker 注入）：内核进度单调+合法、正常流转回收、取消即终止且迟到结果丢弃、旧 jobId 丢弃、超时自动取消、回退路径结果一致。**278/278**（24 文件）；build 通过。
- **边界**：浏览器/Node 层协议语义已测；**桌面生产包（Tauri WebView）内 Worker 实际运行**与断网取消实测归 FE-23/S7 安装验收。

## V-018 S4 第二片：有界局部改良（2026-10-26，F01/FE-14）

- **纯域模块**（新 `src/algorithms/improve.ts`）`improveWeek(input, week, options)`：在**合法基线**上做带预算爬山——① 缺员/空白天补位（空白天优先）② 低于下限者补位 ③ 无空可补时从高负载者**让位搬移**。每个候选先经独立评价器复算，按质量优先级（空白天→覆盖缺口→个人不足→公平方差）**严格变优才应用**——结果永不劣于基线、保留最佳合法解；操作数（默认 200）与耗时（默认 1500ms）双预算，触发预算如实记录 attempts/applied/stopReason（converged/operation-budget/time-budget）；确定性（固定遍历序 + seed 扰动），同输入同 seed 同预算结果一致。基线非法时原样返回不改良。
- **接线**：ScheduleView 全量生成后逐周应用改良；汇总提示"N 周共应用 M 次优化（X 周触及预算上限，已保留当前最佳合法解）"。
- **测试**（improve.test.ts，6 例）：不劣于基线+终态合法（含夹具 17 周全周期与连续段）、手工次优基线的补位改良、让位搬移（受限者可达上限的改善）、零预算不改动、确定性、夹具合法。**272/272**（23 文件）；build 通过。
- **边界**：不虚称最优（爬山非完备）；桌面生产包内 Worker 场景属 FE-15。

## V-017 S4 第一片：增量重排（2026-10-26，F08/FE-13）

- **纯域模块**（新 `src/algorithms/incremental.ts`）`incrementalSchedule(input, baseline, options)`：
  - **零改动快路径**：inputsUnchanged（调用方以"当前 dataRevision == scheduleWriteRevision"可验证判定）且基准全部周终态合法 → 原样返回，diff 为空；
  - **基准锚定重算**：目标周内基准行全部作为保留项传入求解——锁定行 source=manual，自动行 source=auto（KeepEntry 增可选 source，greedy 预占沿用，不冒充手动）；非法保留（新课程冲突/容量变化）被 V-009 入口校验拒绝并携带原因，由求解重新安排——变化只发生在约束被迫处；
  - **范围外周**：基准原样输出（不重算，指标经评价器复算）；
  - **差异**：按 (weekNo, dayOfWeek, slot, assistantId) 输出 kept/added/removed/replaced 与原因——原因只用可验证信息（拒绝明细/缺员补位/重新求解），不伪造唯一因果；uniform 模式明确拒绝增量。
- **服务接线**：saveFullCycle 在写事务内记录 `scheduleWriteRevision`（写入完成后的版本）；ScheduleView 增加模式切换（全量/增量 + 目标周次范围），增量结果展示零改动横幅或逐条变动明细（类型/位置/人员/原因）。
- **测试**（incremental.test.ts，7 例）：零改动原样、新课程只动冲突行（原因含"有课"、其余 kept）、范围外周逐行一致、合法锁定原位且 manual 来源/非法锁定明细拒绝、自动行保留来源仍 auto、uniform 拒绝、范围非法拒绝。**266/266**（22 文件）；build 通过。
- **边界**：有界局部改良（FE-14）与 Worker（FE-15）属 S4 后续片；GUI 层增量流程点击验证归 S6。

## V-016 S3 第三片：命名快照与双连接并发（2026-10-26，FE-16/FE-11）

- **命名快照**（新 `src/db/snapshotService.ts`）：创建走**跨表只读事务**取一致视图（整份排班行 + 当时规则 + 人员显示信息，meta.formatVersion=2，自包含——删除人员/改规则后历史快照不损坏）；逐周对比（复用 scheduleDiff）；**受控恢复**——恢复前用独立评价器按**当前**人员/课程/规则复核快照内容，缺人（明细标注"该助理已被删除"）或课程冲突即阻止且数据不动；合法则在单个 CAS 事务替换覆盖周并**重置撤销链**；旧格式快照（无 meta）界面标注限制。UI：排班页新增快照卡片（创建/对比/恢复/删除 + 受控恢复的冲突明细展示）。
- **FE-11 双连接并发**（新 `concurrency.test.ts`）：`new CrsmDatabase()` 建同名库第二条真实连接；两连接基于同一旧版本**并发**提交"检查+写入+递增"事务——恰好一个成功、另一连接 StaleDataError、版本只前进一次、失败方零写入（无丢失更新）；串行交错场景同验。
- **测试**：snapshotService.test.ts 6 例 + concurrency.test.ts 2 例。**259/259**（21 文件）；build 通过。
- **边界**：快照的历史导出（用其固定信息渲染 xlsx）归 S5 多周/历史导出；GUI 层点击流程验证归 S6 E2E；备份恢复的撤销链重置策略与快照恢复一致（S5）。

## V-015 S3 第二片：撤销 / 重做编辑链（2026-10-26，FE-10）

- **撤销日志**：每个手调操作在**同一 CAS 事务**内向 config 键 `adjustJournal` 追加条目（add/remove 携带完整行——重做按原 id 复原；move/lock/exception 携带前后值）；栈深上限 50；新操作截断 redo 分支。
- **撤销/重做**（`undoRedoAdjust(direction, expectedRevision)`）：逆/正操作先经同一评价器差分校验——**期间输入变化使逆操作会产生硬违规时拒绝**（如课程新增后撤销移动会排进有课时段）；撤销同样递增业务版本（不倒退计数、不覆盖其他窗口写入，CAS 拒绝已验证）；失效条目（行被重排覆盖）按方向语义校验行存在性后**自动跳过并清理**（add 撤销要求行存在、重做要求行不存在，remove 相反）。
- **UI**：排班表卡片头部 撤销/重做 按钮（tooltip 列最近 5 步描述）；刷新/进入页面恢复编辑链状态；调整对话框操作后同步刷新。
- **测试**：+6 例——添加→撤销→重做原 id 复原、移动/锁定撤销、redo 截断、逆操作违规拒绝且状态不变、失效条目自动跳过、撤销 CAS 拒绝。**251/251**（19 文件）；build 通过。
- **边界**：命令快照（FE-16）与双 Dexie 连接全量并发（FE-11）属 S3 第三片；撤销链在"恢复备份"后的重置策略随 S5 备份恢复一并处理。

## V-014 S3 第一片：手动调整基础（2026-10-26，F04/FE-08 核心 + FE-09 算法面）

- **schema**：DutySchedule 增非索引字段 `locked?`（锁定与来源分离；旧 manual 行按锁定回填）与 `continuityExceptionReason?`（短段例外原因，只豁免连续性）。
- **服务**（新 `src/db/manualAdjustService.ts`）：
  - `getSlotCandidates`——逐人候选与**不可排原因**（已在时段/未导课表/待核对/有课含课程名/未知节次保守阻断/时段已满/个人周上限），界面直接展示；
  - 五个原子操作（addManual 默认锁定 / remove / move / setLocked / setContinuityException），每个都是 CAS 写事务；
  - **终态校验复用独立评价器**：改后整周 evaluate 与改前做差，新增硬违规即拒绝并给明细——遗留旧问题不阻塞无关操作；手动短段无例外原因被拒、登记后放行且原因可追溯。
  - 事务表清单含 assistant/course（Dexie 事务范围教训：漏列即 TransactionInactiveError）。
- **评价器增强**：course-conflict 消息带课程名（CourseInput 增可选 courseName 透传）。
- **UI**：新组件 `ManualAdjustDialog.vue`——当前值班（来源/锁定/例外标签 + 锁定切换/移动/例外登记清除/移除）、候选选择 + 不可排原因列表、移动子表单（星期×节次）；ScheduleView 已写入网格格子可点击（悬停高亮，空格显示 ＋）；StaleDataError 提示刷新。
- **锁定链路贯穿重排**：generate 的 keep = 锁定项（旧 manual 回填为锁定）；saveFullCycle 写入行携带 locked/例外原因不丢失（ScheduleView 从重排前行按 周天时段人 匹配携带）。
- **测试**：manualAdjustService.test.ts 10 例（候选原因、添加各拒绝路径、短段例外语义、移动原子、字段维护、CAS、遗留不阻塞）+ scheduleService 增锁定持久化 1 例。**245/245**（19 文件）；build 通过。
- **边界**：undo/redo 与编辑链版本（FE-10）、命名快照（FE-16）、双连接并发全量验证（FE-11）属 S3 后续片；GUI 点击流程的浏览器自动化验证归 S6 E2E。

## V-013 S2 第三片：批量导入逐项结果（2026-10-26，F05/FE-05）

- **服务**（新 `src/db/batchImportService.ts`）：`importTimetableBatch`——逐文件顺序处理（读取即释放）；同内容重复（FNV 字节摘要）→ skipped；不同内容争同一学号 → 后者 failed 明确报冲突（先到者生效，不按先后覆盖）；文件数（>50）与单文件大小（>10MB）超限整批拒绝；每项落库沿用 V-011 单事务原子语义。
- **UI**（CoursesView）：文件选择支持多选（浏览器 `input multiple` + Tauri `openXlsxMultiple` 新增于 fileAccess.ts）；>1 文件走批量路径，惰性逐个读取；结果对话框逐项展示 文件/结果标签/归属(姓名+学号)/说明；汇总提示 成功/失败/跳过。
- **测试**（batchImportService.test.ts，4 例，使用仓库脱敏样例）：3 合法 + 1 损坏（随机字节）+ 1 同内容重复 → ok×3/failed/skipped 各自正确且只建 3 档；**同号不同内容**（合法文件尾部追加 1 字节构造：摘要变、归属不变）→ 后者明确冲突不覆盖；结果携带归属与课程数；超限整批拒绝。
- **结果**：`npx vitest run` **234/234**（18 文件）；`npm run build` 通过（690ms）。
- **边界**：批次内冲突拒绝后"用户人工核对选择保留哪份"的交互 = 直接重导单个文件（现有单文件路径支持）；GUI 层多文件对话框在桌面端的实测归 FE-22/S7 安装验收。

## V-012 S2 第二片：课程手动编辑与影响分析（2026-10-26，F06/FE-07）

- **服务**（新 `src/db/courseService.ts`）：addCourse / updateCourse / removeCourse——校验（课程名/星期 1~7/节次原文/周次文本经 parseWeekList 解析，单双周合法）→ 单写事务（写课程行 + **重算课表状态** + 日志 + 版本递增）。状态重算规则：含无法识别节次 → needs_review；删到 0 条 → confirmed_empty；否则 ready。
- **影响分析** `analyzeCourseImpact`：课程变化后对已写入排班跑与导入路径同一套冲突 + 待核对判定。
- **UI**（CoursesView）：已存储课程表加类别/操作列与「新增课程」；声明式编辑对话框（课程名/号/类别/星期/节次原文/周次/地点，含"无法识别会转待核对"提示）与删除确认；保存/删除后自动刷新课程、助理列表（状态列）并重跑影响分析（复用既有冲突/待核对警报，含"删除冲突排班/去重排"入口——F06 影响闭环）。
- **测试**（courseService.test.ts，11 例）：校验边界、状态重算三态、周次展开、冲突/待核对影响、无误报。
- **结果**：`npx vitest run` **230/230**（17 文件）；`npm run build` 通过（677ms）。
- **边界**：实验分批/单双周"不丢失"由 parseWeekList + 整体替换语义保障（解析层已有测试）；批量导入（FE-05）属 S2 第三片。

## V-011 S2 第一片：dataRevision 版本协议 + 导入/全周期保存原子化（2026-10-26）

- **版本原语**（新 `src/db/dataRevision.ts`）：config key `dataRevision` 单调递增；`withDataRevision(expected, tables, fn)` 把"版本校验 → 业务写入 → 版本+1"放进**同一个 Dexie 读写事务**（CAS）；`StaleDataError` 携带期望/实际版本。
- **导入原子化（FE-06）**：importTimetableForStudent 全部动作（建档/改名、课程整体替换、课表状态、两条操作日志、版本递增）收进单事务；解析/推导在事务外。故障注入测试：课程替换失败 → 助理/课程/日志/版本**全部回滚**；更新分支改名后状态写失败 → 姓名保持原样、旧课表未清空。
- **全周期原子保存（FE-12）**（新 `src/db/scheduleService.ts`）：`saveFullCycle(weeks, expectedRevision, meta)` 单事务替换全部周 + 日志 + 版本递增；ScheduleView.write() 从逐周 replaceWeek 切换至此，并携带预览生成时的版本——期间发生过导入/保存则拒绝并提示重新生成（StaleDataError 专项提示）。故障注入测试：第 2 周写入失败 → 两周全回滚、版本不动。
- **CAS 测试**：同旧版本连续提交第二次被拒（FE-11 的基础语义；真实双连接验证在 S3 手调提交接入后补充）。
- **结果**：`npx vitest run` **219/219**（16 文件，新增 dataRevision.test.ts 7 例 + scheduleService.test.ts 3 例）；`npm run build` 通过。
- **边界**：手调提交/撤销链的版本携带（FE-10）与真实双 Dexie 连接并发（FE-11 全量）随 S3 落地；批量导入（FE-05）与课程编辑（FE-07）属 S2 后续片。

## V-010 S1.5 课表状态四分类与 P05 待核对展示（2026-10-26）

- **四分类语义**（新 `src/algorithms/timetableStatus.ts`，纯函数）：ready（已导入且节次全部可识别）/ confirmed_empty（确认无课）/ needs_review（存在无法识别节次）/ missing（从未导入）。旧数据保守回填：无标记但有课程记录 → ready，否则 missing。"未提交课表≠全天空闲"：仅 ready 与 confirmed_empty 可参与自动排班。
- **导入接线**：importTimetableForStudent 落库后推导并持久化 `assistant.timetableStatus`（空课表→confirmed_empty、含未知节次→needs_review、否则 ready），结果与操作日志均携带状态；schema 加非索引可选字段，无需升库。
- **排班入口**（ScheduleView）：missing/needs_review 助理被排除且逐人给出原因（warning），全部不可排时给可行动错误提示；keep 同步过滤到可排人员。
- **确认入口**（AssistantsView）：课表状态列（标签）；missing→「确认无课」、needs_review→「已核对」行内动作，写操作日志。
- **P05 UI 面**：`findDutyNeedsReview`（dutyConflict.ts）——未知节次课程 × 同日排班进入"待核对"清单；CoursesView 导入后以 warning 警报展示"无法自动判定是否冲突，请人工核对"，与冲突清单并列（空冲突清单≠安全）。
- **测试**：timetableStatus.test.ts（8 例：回填/可排班/推导）、dutyConflict.test.ts 增 3 例（待核对判定与排除分支）、importService.test.ts 增 1 例（状态持久化）。`npx vitest run` **209/209**（14 文件）；`npm run build` 通过（755ms）。
- **边界**：手动建助理未导课表者现被排除出自动排班（语义变更，按计划 FE-02 执行），确认入口已提供；needs_review 的"核对后修改课表节次原文"编辑能力属 S2 课程编辑。

## V-009 S1.4 保留项（keep）安全校验与周次语义（2026-10-26，P01/P02/P03/P04）

- **P01/P02（入口校验）**：greedy 预占阶段对每条 keep 依次校验——时段合法、人员存在、课程冲突（含未知节次的保守全天占用）、时段上限、重复、个人上限；任一不过即拒绝并携带原因进入输出 `rejectedKeeps`（新字段，ScheduleOutput 扩展），不再"手动来源豁免"。合法 keep 照常保留为 manual。
- **P03（均衡不搬手动）**：`moveBlockInto` / `moveBlockIntoForce` 的候选块必须是**纯 auto 块**——含 manual 的块（含混合块）整体不参与搬移；兜底让位同样受此约束。
- **P04（周次语义）**：`KeepEntry` 增加可选 `weekNo`（缺省=全周，兼容旧调用）；greedy 按周过滤；uniform 模式下指向非模板周的保留项按明细拒绝（原因含"各周相同模式…请改用各周独立"）。**ScheduleView 修复**：keep 构造从"当前查看周、丢周次"改为"整个周期各周手动记录 + 显式 weekNo"（此前第 N 周手动安排会传播到全部周）；生成后聚合 `rejectedKeeps` 以 warning 反馈用户。
- **回归用例**：greedy.test.ts 新增 5 例，逐一对齐审计 P01（保留有课）、P02（保留爆容量）、P03（审计原场景：两天/上限一人/手动集中第一天，断言手动原位、缺口如实）、P04（第 1 周保留不传播到第 2 周）、uniform 周外拒绝。
- **结果**：`npx vitest run` **197/197**（13 文件）；`npm run build`（含 vue-tsc）通过（673ms）。
- **边界**：P01~P04 在**算法层与生成入口**关闭；评价器（V-007）作为第二道独立防线。手调 UI 的锁定/解锁交互与例外登记属 S3（FE-08/09 的 UI 面尚 pending）；P05 的冲突页展示属 S1.5。

## V-008 S1.3 严格规则校验与 8~11 歧义处理（2026-10-26，P06/P07）

- **P06**：`validateRules` 收紧——全部数值字段（周期/个人上下限/时段人数/连续节数）必须整数且在语义范围内（负数/小数被拦）；工作日必须为 1~7 整数（星期 0/8 被拦）；节次区间端点必须整数（小数节次被拦）。`src/algorithms/types.ts` + 新增 `src/algorithms/types.test.ts`（11 用例逐一覆盖审计反例）。
- **P07**：`normalizeRules` **删除**"下午 8~11 → 6~9"静默改写；新增 `rulesDataWarnings(saved)` 对歧义 8~11 返回"待核对"提示；`ScheduleConfigView` 载入时以警告条展示（用户确认后自行保存，不代为猜测）。
- **旧行为断言更新**：greedy.test.ts 中"存量配置迁移自动对齐"用例改为断言**不改写 + 警告**（计划要求不把旧行为固化为期望）；周期报错文案随整数校验更新。
- **结果**：`npx vitest run` **192/192**（13 文件）；`npm run build` 通过（650ms）。
- **边界**：P06 关闭范围是算法/配置共用校验函数（UI 输入框本身已有范围限制，服务侧口径即此函数）；P07 关闭"静默改写"，存量歧义配置的用户确认闭环依赖配置页警告条（已接入），无自动迁移日志（按计划不猜测）。

## V-007 S1.1/S1.2 独立评价器 + P08 修复（2026-10-26）

- **新增 `src/algorithms/evaluate.ts`**：单周/多周独立终态评价器。硬违规（课程冲突/重复/时段超上限/个人超上限/非法时段/未知人员/连续段破坏/锁定被破坏或越界）与软缺口（时段缺员/个人低于下限/未知节次待核对）分级；锁定与手动安排进入同一校验（不豁免课程/容量）；连续性按节次序号轴且不跨工作区段；未知节次产出 needs-review 缺口（P05 语义）；带 `continuityExceptions`（手动短段例外只豁免连续性）与带周次 `LockEntry`（P04 数据形态）。
- **测试 `src/algorithms/evaluate.test.ts`（19 用例）**：各违规/缺口语义、锁定语义、uniformMode 占用、跨午休不连续、auto 短段不豁免、夹具 17 周集成、P08 审计合成场景。
- **评价器立刻抓到真实缺陷**：对夹具 17 周输出诊断出 W3/W10/W11/W12 助理 #9 存在 auto 孤立单节（c6/c8）——即审计 P08（旧测试只查第 1 周，漏掉其余周）。
- **修复（greedy.ts）**：修复/撤销迭代后与每日均衡后各加一次"只撤销、不再补"的终态清理（`removalPass()`），孤立 auto 短段不再残留；缺口由 belowMin/unmetSlots 如实报告。
- **结果**：诊断脚本违规数 `{}`（0）；`npx vitest run` **181/181**（12 文件）；`npm run build` 通过（756ms）。
- **边界**：证明算法层 P08 关闭（含全部周次）；P01~P04 的 greedy/UI 集成路径与 P06/P07 校验仍待 S1.3/S1.4；评价器尚未接入保存/发布链路（S2/S3）。

## V-006 S0 Worker/离线安装包可行性检查（2026-10-26）

- **Tauri 构建**：`npx tauri info` 全绿——rustc/cargo 1.95.0（stable-msvc）、MSVC 2022 生成工具、WebView2 运行时 155.0.4283.62、tauri 🦀 2.11.5（@tauri-apps/cli 2.11.4）、fs/dialog 插件就位，build-type bundle。**NSIS 离线打包能力具备**。
- **WebView2 安装方式现状**：`src-tauri/tauri.conf.json` 未配置 `webviewInstallMode` → Tauri 默认 downloadBootstrapper（**依赖网络**）。S7 前需改为 `bundle.windows.webviewInstallMode = { "type": "offlineInstaller" }` 并将 WebView2 离线安装器（MicrosoftEdgeWebView2RuntimeInstallerX64.exe，约 100+ MB）放至 Tauri 约定路径随包分发；embedBootstrapper 不满足断网首装。
- **Web Worker**：项目用 rolldown-vite，支持 `new Worker(new URL('./x.ts', import.meta.url), { type: 'module' })` 标准写法；Node 测试环境无法真实运行 Worker，真实冒烟推迟到 S4（FE-15：桌面生产包内 Worker 可用为最终门槛）。S0 结论：方案可行，无阻塞性配置。
- **版本注**：tauri 全家桶有可用更新（2.12.x），不阻塞本期；是否升级在 S7 打包时一并决定。
- 边界：以上证明"能打包/能配离线"，不等于已产出安装包或断网机器验收（那是 FE-23）。

## V-024 自查修复（2026-10-26，交付审计轮）

- **缺陷 1（backupService.validateBackup）**：结构校验只查了 `assistants` 数组——损坏备份缺 `courses/dutySchedule/scheduleSnapshots/config` 任一字段时，校验器内部 `.map` 抛未捕获 TypeError（校验器崩溃而非返回错误），界面层无兜底静默无反馈。修复：五字段结构完整性前置检查 + DataManagementView 读取文件 try/catch 兜底 + 回归测试（逐字段缺失断言拒绝且不抛）。
- **缺陷 2（ManualAdjustDialog）**："移动到原位置"时服务端按设计静默无操作，但界面显示"已移动"成功提示——误导。修复：组件层前置拦截并提示"目标位置与当前位置相同"。
- **复查确认无恙的高风险路径**：撤销条目转移的结构匹配（JSON 快照比对）、恢复后 scheduleWriteRevision 对齐使增量零改动语义成立、improve 让位搬移经评价器兜底连续段、Dexie 嵌套事务表清单、worker 输入可结构化克隆、备份恢复自增 id 不复用、config 全清后重置键顺序。
- 结果：`npx vitest run` **299/299**（新增 1 例）；`npm run build` 通过。
- **第二轮（同日，代码质量轮）**：① 删除 `dutyScheduleRepo.replaceWeek`（审计 §5.2 缺陷来源、生产零引用——保留会诱导逐周替换复活；唯一测试引用改为逐条 add 构造）；② 删除 improve.ts 死代码 `scoreKey`；③ incremental.ts `baselineAsWeek` 的缺口映射改为 `actual = required - short` 恒等推导，去掉循环内重复 `buildSlots` 回查（每周最多 40 次的冗余构建）；④ 复读 scheduleDiff/scheduleGrid/dutyConflict 确认无边界问题（键去重/并集/未知节次语义一致）。`npx vitest run` **299/299**；build 通过。

## V-005 S0 夹具恢复与测试基线修复（2026-10-26，对应 FE-01）

- **背景**：V-002 历史清洗把 `src/algorithms/__fixtures__/regression-3assistants.json` 从全部历史移除时，工作树中该文件（2026-09-13 的**脱敏重建版**：示例学生A/B/C、131 条课程）也被一并删除，导致 greedy.test.ts 51 个用例无法加载（162→111）。
- **方式**：从本机备份 bundle（`C:\Users\pang\AppData\Local\Temp\crsm-pre-sanitize.bundle`，D-02 记录）提取 38aaa2b 版夹具；提取后扫描 `庞士豪|王五|赵四|李四|1[3-9][0-9]{9}` **0 匹配**；核对结构（3 助理、131 课程、rules 下午 6~9）与测试期望一致后恢复到工作树。
- **结果**：`npm test` 11 文件/162 用例全部通过（含 greedy.test.ts 51 项：补位迭代、全周期无课程冲突、第 1 周五天覆盖、均衡守恒、确定性）；`npm run build` 通过（661ms）。
- **边界**：证明算法基线恢复到清洗前水平；不证明 P01～P08 已修复（那是 S1 的任务，见 FE-03）；临时 bundle 克隆目录已删除，bundle 本体仍含旧历史（见 D-02）。


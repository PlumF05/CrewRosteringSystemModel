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

## V-005 S0 夹具恢复与测试基线修复（2026-10-26，对应 FE-01）

- **背景**：V-002 历史清洗把 `src/algorithms/__fixtures__/regression-3assistants.json` 从全部历史移除时，工作树中该文件（2026-09-13 的**脱敏重建版**：示例学生A/B/C、131 条课程）也被一并删除，导致 greedy.test.ts 51 个用例无法加载（162→111）。
- **方式**：从本机备份 bundle（`C:\Users\pang\AppData\Local\Temp\crsm-pre-sanitize.bundle`，D-02 记录）提取 38aaa2b 版夹具；提取后扫描 `庞士豪|王五|赵四|李四|1[3-9][0-9]{9}` **0 匹配**；核对结构（3 助理、131 课程、rules 下午 6~9）与测试期望一致后恢复到工作树。
- **结果**：`npm test` 11 文件/162 用例全部通过（含 greedy.test.ts 51 项：补位迭代、全周期无课程冲突、第 1 周五天覆盖、均衡守恒、确定性）；`npm run build` 通过（661ms）。
- **边界**：证明算法基线恢复到清洗前水平；不证明 P01～P08 已修复（那是 S1 的任务，见 FE-03）；临时 bundle 克隆目录已删除，bundle 本体仍含旧历史（见 D-02）。


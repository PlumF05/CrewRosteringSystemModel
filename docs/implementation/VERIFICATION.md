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

## V-005 S0 夹具恢复与测试基线修复（2026-10-26，对应 FE-01）

- **背景**：V-002 历史清洗把 `src/algorithms/__fixtures__/regression-3assistants.json` 从全部历史移除时，工作树中该文件（2026-09-13 的**脱敏重建版**：示例学生A/B/C、131 条课程）也被一并删除，导致 greedy.test.ts 51 个用例无法加载（162→111）。
- **方式**：从本机备份 bundle（`C:\Users\pang\AppData\Local\Temp\crsm-pre-sanitize.bundle`，D-02 记录）提取 38aaa2b 版夹具；提取后扫描 `庞士豪|王五|赵四|李四|1[3-9][0-9]{9}` **0 匹配**；核对结构（3 助理、131 课程、rules 下午 6~9）与测试期望一致后恢复到工作树。
- **结果**：`npm test` 11 文件/162 用例全部通过（含 greedy.test.ts 51 项：补位迭代、全周期无课程冲突、第 1 周五天覆盖、均衡守恒、确定性）；`npm run build` 通过（661ms）。
- **边界**：证明算法基线恢复到清洗前水平；不证明 P01～P08 已修复（那是 S1 的任务，见 FE-03）；临时 bundle 克隆目录已删除，bundle 本体仍含旧历史（见 D-02）。


# 决策台账（DECISIONS）

> 记录影响范围较大或不可逆的决策：背景、选项、决定、后果。编号 D-xx 递增，只追加不改写。

## D-01 演示与测试数据一律合成或脱敏（2026-10-24，M0）

- **背景**：真实课表含学生姓名、学号、联系方式；仓库曾在开发早期把真实 xlsx 与回归夹具提交进 git。
- **决定**：所有演示数据、测试夹具、样例文件只使用合成数据或脱敏数据；`samples/` 下仅保留脱敏样例（示例学生A/B/C）；`.gitignore` 已全局忽略 `*.xlsx`（samples 例外）。
- **后果**：解析器集成测试使用固定脱敏样例；真实数据永不入库。

## D-02 git 历史清洗与强推（2026-10-26，用户明确授权）

- **背景**：公开仓库 `PlumF05/CrewRosteringSystemModel` 的 git 历史中残留真实学生数据：`王五.xlsx`、`赵四.xlsx`、`李四.xlsx`、`timeTableForStu12.xlsx`（含 Excel 锁文件）、`test-export.xlsx`（含真实格式手机号与姓名）、`src/algorithms/__fixtures__/regression-3assistants.json`（真实课表 dump），以及 SRS/测试文件与 4 条提交信息中的真实姓名。
- **决定**：用户在"转私有 / 清洗历史强推 / 暂不处理"中明确选择**清洗历史并强推**，构成对目标文档"不强推或重写历史"约束的一次性明确豁免（仅限本次隐私清洗，不构成常态）。
- **执行**：`git filter-repo --force --invert-paths <7 个路径> --replace-text/--replace-message`（庞士豪→示例学生C、王五→示例学生A、赵四→示例学生B、李四→示例学生D）。49 → 41 个提交（8 个变空提交被剪除）。
- **哈希映射**：审查基线 **旧 `38aaa2b` → 新 `f86f6b6`**；`fullstack` 新提交 `9546815` → `9b75973`。所有文档后续引用新哈希。
- **验证**：历史中 xlsx 仅剩 `samples/示例学生A/B/C.xlsx`；四个真实姓名在全部 blob 与提交信息中零残留；手机号模式仅剩 `13800000001/2`（显式测试假号码）与 Cargo.lock 哈希子串误报。详见 VERIFICATION.md V-002。
- **本地备份**：清洗前全量 bundle 存于 `C:\Users\pang\AppData\Local\Temp\crsm-pre-sanitize.bundle`（含旧历史，仅本机；确认无误后可自行删除——它是旧数据在本地的最后一份副本）。
- **残余风险（诚实记录）**：GitHub 服务端旧提交对象在 GC 前仍可能通过精确 SHA 访问；若曾被 clone/fork 无法追回。如需彻底清除可联系 GitHub Support 请求 gc，用户自行决定。

## D-03 里程碑自动推送协议（2026-10-26，用户授权）

- **背景**：用户要求"根据项目进展在合适的时候自动上传 GitHub"。
- **决定**：
  1. **日常**：子里程碑完成 + 测试全绿 + 台账更新 → 自动 commit 并 push `origin/fullstack`，无需逐次确认。
  2. **main**：仅在验收节点合并后、经用户确认才推送。
  3. **禁止**：任何情形下不再强推或重写历史（D-02 豁免已用毕）；不推未过测试的状态。
- **凭据**：Windows 凭据管理器中的 PAT（已验证可免交互 push）。
- **替代方案记录**：git hooks（无测试门禁、离线即败）与定时无人值守推送（无人纠正坏状态）均被评估并否决，仅保留为可选补充。

## D-04 目标重定向：保留纯前端离线架构（2026-10-26，用户决定）

- **背景**：Web 全栈目标（旧 CRSM-ZCODE-GOAL-WEB，含 Django/MySQL/Celery 与 M0～M9/A01～A32）启动当日，用户改为主张保留 Vue/Tauri/Dexie 原架构，交付完全离线 Windows 桌面应用。新依据：新版 CRSM-ZCODE-GOAL.md + CRSM-FRONTEND-IMPROVEMENT-PLAN.md（S0～S7、FE-01～FE-24），详见 ADR-0001（docs/adr/0001-retain-frontend-desktop.md）。
- **决定**：停止一切后端开发；backend/、Python、uv（缓存已按用户要求重定向 D:\uv\cache）、MySQL80 全部**保留不删不卸**，但不再是运行依赖或阻塞；旧 Web 台账归档于 docs/implementation/archive/ 与 docs/plans/archive/。
- **环境事实更正**：backend/.venv 已在 uv 试验中重建为空环境（原 pip 版 Django 5.2.18 不再安装在内），重建配方仍在 backend/requirements-bootstrap.txt；uv add 因 or-tools 解析失败未完成锁定（V-003）。backend/pyproject.toml 清空依赖声明，仅保留项目骨架。
- **兼容性**：D-01（数据脱敏）、D-02（历史清洗）、D-03（自动推送协议）继续有效；D-03 的"测试全绿才推送"按新 FE 口径执行。

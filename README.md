# 学院行政办助理排班系统（CRSM）

> 版本 **v0.2** ｜ 作者 **PlumF** ｜ 仓库 [PlumF05/CrewRosteringSystemModel](https://github.com/PlumF05/CrewRosteringSystemModel) ｜ [变更记录](CHANGELOG.md)

面向学院行政办的学生助理排班工具：导入学生课程表 → 按规则自动/增量排班 → 手动微调 → 发布与导出 → 备份交接。
Windows 离线桌面应用（Tauri），**数据全部保存在本机 IndexedDB，无后端、无网络传输、无账号**。

> 2026-10-26 完善轮（S0~S7）已交付 F01～F08 全部能力：独立终态评价器、锁定/短段例外、撤销/重做、命名快照、增量重排、有界局部改良、Web Worker、双模板、多周/历史导出、版本化备份与受控恢复。验证证据见 [VERIFICATION](docs/implementation/VERIFICATION.md)（V-005~V-024）与 [验收矩阵](docs/implementation/ACCEPTANCE.md)（FE-01~24）。

## 功能特性

| 模块 | 能力 |
| --- | --- |
| 助理管理 | 增删改查、学号唯一、个性化值班节数覆盖全局；**课表状态四分类**（已导入/确认无课/待核对/未导入）——未导入或待核对者不参与自动排班，提供确认入口 |
| 课程表导入 | 解析学院标准 xlsx（合并单元格/单双周/实验分批/命名节次）；**单文件与多文件批量导入**——逐项结果、同内容自动跳过、不同文件争同一学号明确拒绝；导入后冲突检测 + 待核对展示 |
| 课程管理 | 手动增/改/删课程（周次文本支持"5-17周单周"写法）、保存后自动重算状态并分析对当前排班的影响（冲突/待核对） |
| 排班规则 | 严格校验（整数/范围/星期 1~7/组合）；每周"节数"口径；各周独立 / 各周相同两种模式；理论/实验课分别计入占用；最少连续节数；每日均衡；歧义旧配置（下午 8~11）不静默改写、提示待核对 |
| 自动排班 | 贪心主分配 + 修复/撤销迭代 + 每日均衡；**有界局部改良**（补位/空白天/让位搬移，双预算，永不劣于合法基线）；全部输出经**独立终态评价器**复核（硬违规拒绝、缺口如实报告） |
| 增量重排 | 以已写入方案为基准：锁定项不动、自动安排优先保留、目标周范围外保持原样；**输入未变化时零改动**；逐条输出新增/移除/替换与可验证原因 |
| 手动调整 | 点击排班表格子：添加（逐人候选与不可排原因）、移除、跨格移动、锁定/解锁、**连续短段例外登记**（需原因，只豁免连续性）；操作即校验（评价器差分） |
| 撤销/重做 | 编辑链持久化（50 步上限）、新操作截断重做、逆操作也过校验（输入变化导致撤销会产生冲突时拒绝）、失效条目自动跳过 |
| 命名快照 | 自包含保存（排班 + 当时规则 + 人员名单）；逐周对比；**受控恢复**（按当前人员/课程复核，缺人或冲突即阻止）；固定信息导出 |
| 导出 | 单周/多周工作簿（每周一 sheet）、快照导出；导出**永不写学号/QQ**，电话由开关控制且关闭后全 sheet 零出现；文本按文本写出不执行公式 |
| 模板管理 | **导入模板**（表头/学生标识/学期三锚点可配 + 试解析）与**导出模板**（标题/表头/列宽/简洁打印版式）双管理；版本化保存与历史恢复；内置学院默认版/简洁打印版 |
| 备份恢复 | 跨表一致快照导出为单个 JSON（内容摘要检错、个人资料明确标注）；恢复前五类校验、当前数据先存独立恢复副本、单事务整体替换、失败原数据保持；空库（换机）恢复一致 |
| 响应与性能 | 排班计算在 **Web Worker**（进度条/取消/超时/迟到消息丢弃，Worker 不写库）；50 人 × 17 周全链路实测 ~1.3s（口径 5s） |
| 首页 | 可行动信息：缺课表/待核对/排班缺口/硬违规/输入已变化建议复核，逐项点击直达 |

## 技术栈

| 层级 | 技术 |
| --- | --- |
| 前端 | Vue 3 + TypeScript + Vite（Rolldown）+ Element Plus（按需引入） |
| 本地存储 | IndexedDB（Dexie 4，schema v4：assistant/course/duty_schedule/config/operation_log/schedule_snapshot/recovery_backup） |
| 一致性 | 业务数据版本 `dataRevision`（CAS 写事务）；单文件导入/全周期保存/手调/恢复均为单事务原子 |
| Excel | xlsx-js-style（懒加载 chunk，不占首屏） |
| 算法 | 纯 TS：贪心 + 独立评价器 + 增量 + 有界改良（无外部求解器依赖） |
| 桌面 | Tauri v2（Rust + WebView2），NSIS 安装包，**WebView2 离线安装器随包分发** |
| 测试 | Vitest（298 项：纯函数 + fake-indexeddb 集成 + 双连接并发 + 隐私扫描） |

## 快速开始（开发）

**环境要求**：Node.js 18+；Rust（MSVC）+ VS Build Tools（C++ 桌面工作负载）；Windows 10+。

```bash
npm ci
npm test            # 全量测试
npm run build       # 类型检查 + 生产构建
npx vite-node scripts/perf-bench.ts   # 性能基准（口径回归）
npm run tauri dev   # 桌面窗口开发运行
```

## 离线安装包构建（S7/FE-23）

`src-tauri/tauri.conf.json` 已配置 `bundle.windows.webviewInstallMode = offlineInstaller`：安装包携带完整 WebView2 运行时，**目标机器断网、无 WebView2 也可首装**（downloadBootstrapper/embedBootstrapper 不满足该要求）。

构建步骤：

1. 下载 WebView2 x64 **离线安装器**（约 150MB），重命名为 `MicrosoftEdgeWebView2RuntimeInstallerX64.exe` 放入 `src-tauri/`（该文件已 gitignore，不入库）。
   获取途径：Microsoft Update Catalog 搜索 "WebView2 Runtime" → 最新 x64 更新 → 下载 `microsoftedgestandaloneinstallerx64_*.exe`。
   ⚠️ 微软旧文档的 fwlink `LinkId=2124703` 现已指向 1.9MB 在线引导器（Bootstrapper），**不是**离线安装器（2026-10 实测）。
2. `npm run tauri build`
3. 产物：`src-tauri/target/release/bundle/nsis/CRSM_0.2.0_x64-setup.exe`（SHA-256 与体积记录于 VERIFICATION.md）

数据位置说明：应用数据（IndexedDB）由 WebView 用户目录管理，安装到 D 盘不会迁移数据；升级覆盖安装保留数据；清除业务数据走应用内操作或备份恢复，与卸载互不混淆。两台电脑通过「数据管理 → 导出备份 / 从备份恢复」交接，之后为独立副本。

## 验证与质量

- [VERIFICATION.md](docs/implementation/VERIFICATION.md)：全部验证记录（V-005~V-024），含性能实测、故障注入、双连接并发、隐私扫描
- [ACCEPTANCE.md](docs/implementation/ACCEPTANCE.md)：FE-01~FE-24 验收矩阵与 F01~F08 / P01~P08 核销
- CI（GitHub Actions，windows + Node 22）：测试 → 类型检查构建 → 性能基准回归
- [TASKS.md](docs/implementation/TASKS.md) / [DECISIONS.md](docs/implementation/DECISIONS.md)：任务台账与决策记录（含 git 历史隐私清洗 D-02）

## 文档索引

- [需求规格 SRS](docs/SRS.md) ｜ [术语表](GLOSSARY.md) ｜ [ADR](docs/adr/)
- [前端完善计划](docs/plans/CRSM-FRONTEND-IMPROVEMENT-PLAN.md) ｜ [基线审计](docs/plans/CRSM-BASELINE-AUDIT-2026-10-26.md)
- [排障手册](docs/troubleshooting.md) ｜ [学习指南](docs/LEARNING-GUIDE.md)

## 隐私红线

排班导出永不包含学号/QQ；电话仅由导出开关控制（关闭后全部 sheet 零出现）。完整备份包含电话/QQ 等个人资料并明确标注。仓库样例均为脱敏数据（真实数据已于 2026-10-26 从 git 历史清除，见 DECISIONS.md D-02）。

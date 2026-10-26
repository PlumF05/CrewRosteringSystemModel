# CRSM 原架构完善任务台账

当前驱动：CRSM-ZCODE-GOAL.md + CRSM-FRONTEND-IMPROVEMENT-PLAN.md。2026-10-26 按用户要求保留纯前端架构；旧 Web 台账已归档，不再执行。

本文件状态只表示当前新目标。本文档整理完成不代表功能实现。状态：pending / in_progress / verified；verified 必须有实际证据。

## 当前基线

- HEAD：3d3a44e。业务保持 Vue/TS + Dexie + Tauri。
- npm test：**11 文件/162 用例全部通过**（2026-10-26 恢复脱敏夹具后，V-005；此前 111 用例 + greedy.test.ts 加载失败）。
- npm run build：通过，有大分块警告。
- 尚未验证：Tauri 完整构建、原生 Worker、实际桌面数据库升级、干净机断网安装。
- Python、MySQL、Docker、PostgreSQL 不再是本目标依赖或阻塞（backend/ 与工具保留，D-04；uv 缓存已重定向 D:\uv\cache，backend/.venv 现为空环境）。

| 阶段 | 任务 | 状态 | 证据 |
| --- | --- | --- | --- |
| S0 | 合成夹具、恢复测试、需求同步、最小离线包/Worker 冒烟 | **verified** | V-005（夹具+162 绿，FE-01 verified）+ V-006（tauri info 全绿，NSIS 能力具备；WebView2 需 S7 改 offlineInstaller） |
| S1 | 严格规则、独立评价器、P01～P08、输入状态与版本 | **verified** | V-007~V-010：评价器（硬违规/软缺口/锁定/待核对）+ P08 终态清理 + P06/P07 严格校验与 8~11 不静默改写 + P01~P04 keep 安全校验与周次语义 + 课表四分类与确认入口；209/209 绿 |
| S2 | 原子归档、批量导入、课程手改、profile 底层 | **verified** | V-011~V-013：dataRevision CAS + 导入/全周期保存单事务原子（FE-06/12）+ 课程增改删与影响闭环（FE-07）+ 批量导入逐项结果（FE-05）；234/234 绿 |
| S3 | 手调、锁定、undo/redo、命名快照、陈旧写入保护 | pending | |
| S4 | 增量/全量、局部改良、质量差异、Worker 取消超时 | pending | |
| S5 | 双模板、多周/历史导出、备份恢复、升级兼容 | pending | |
| S6 | 拆分大页面、性能、E2E/CI、帮助和文档 | pending | |
| S7 | 完整离线安装包、干净机/跨机恢复、交付学习材料 | pending | |

下一步：S0 收尾——① Worker/离线安装可行性冒烟（tauri.conf 现为默认 WebView2 在线引导器，S7 需 offlineInstaller，V-006 记录）；② 进入 S1：独立评价器 evaluateSchedule + 严格规则校验（P06/P07）+ P01～P08 回归。不能恢复旧真实数据或删除失败测试。后续按阶段继续，不逐模块等用户学习确认。

旧任务记录：[历史 Web 台账](archive/TASKS-WEB-2026-10-26.md)。旧授权记录本身不构成本轮额外行动授权。

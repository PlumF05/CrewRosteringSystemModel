# 保留纯前端业务与本地桌面架构

状态：已采纳的范围决定；功能实现待完成。日期：2026-10-26。

用户明确取消整体重构，选择沿用 Vue/TypeScript、Dexie/IndexedDB 和 Tauri，只做功能完善与优化。因此本轮在原架构内完成 F01～F08、约束正确性、增量重排、Worker 响应性、备份恢复及离线安装，不再实施 Python/Web 服务端或内置 Python 后端。

曾考虑集中式 Django/MySQL 和内置 Python/SQLite：前者要求服务端运行，后者增加运行时与进程打包维护；这些取舍不符合本轮保留原技术方案的决定。已有 Python、MySQL 和 backend 文件保留，但不作为当前产品依赖。

项目深度以可验证的排班优化、事务完整性、陈旧写入保护、文件兼容与离线交付体现。多人在线协作和独立数据副本自动同步不在本轮范围。详细依据见 [原架构完善计划](../plans/CRSM-FRONTEND-IMPROVEMENT-PLAN.md)。

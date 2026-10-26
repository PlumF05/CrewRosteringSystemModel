# 实施任务台账（TASKS）

> 由 CRSM-ZCODE-GOAL.md 驱动。状态：pending / in_progress / blocked / verified。
> verified 标准（计划 §13.3）：代码、页面/API、必要数据迁移、业务验证及文档都齐。
> 本文件是跨会话恢复的入口：切换会话后先读本文件与 ACCEPTANCE.md，不重新规划。

## 环境事实（M0.3 探测，2026-10-24）

- Python 3.12.4（`D:\python\python.exe`）；py 启动器另有 3.14.0；uv 0.x 可用
- **Docker 不在 PATH；PostgreSQL 未安装** → PG 并发/部署/恢复类验收暂列为环境阻塞，持续记录
- Node v24.18.0、npm 11.16.0；前端基线 162 用例通过（原 38aaa2b，历史清洗后映射为 **f86f6b6**，见 DECISIONS.md D-02）
- 依赖锁定：见 `backend/pyproject.toml` 与 VERIFICATION.md 版本记录
- 2026-10-26 完成 git 历史隐私清洗并强推（用户授权，D-02）；**此后不再强推**；里程碑自动推送协议生效（D-03：测试全绿即 push origin/fullstack，main 仅验收节点经确认）

## M0 基线与设计

| # | 任务 | 状态 | 说明/产出 |
|---|------|------|----------|
| M0.1 | 复核 HEAD 与审查反例 P01~P08 | verified | 审计文档已载；HEAD==f86f6b6（原 38aaa2b，D-02 映射）无代码漂移 |
| M0.2 | O/R/N 需求矩阵与台账 | verified | ACCEPTANCE/VERIFICATION/DECISIONS/TASKS 四台账齐备 |
| M0.3 | 锁依赖、探测环境、演示数据规则 | in_progress | 环境见上；后端依赖以 uv 锁定；演示数据一律合成/脱敏（DECISIONS.md D-01） |
| M0.4 | 全栈 SRS + 架构/算法/版本 ADR | in_progress | docs/architecture/ADR-003~005 草案随 M1 代码落地补全 |

## M1 最小全栈纵切

| # | 任务 | 状态 | 说明/产出 |
|---|------|------|----------|
| M1.1 | Django/PG(暂SQLite开发)/迁移/配置骨架 | pending | backend/ 目录；PG 部署配置写好待环境 |
| M1.2 | 登录、CSRF、三角色与老师学期权限 | pending | Session+CSRF；accounts app |
| M1.3 | 学期/当期人员 API + Vue 页面接通 | pending | academics app；前端 features/terms |
| M1.4 | OpenAPI(drf-spectacular)/TS 类型/CI 基础 | pending | |

## M2~M9

按计划 §11 顺序：M2 课表可靠导入 → M3 评价器/贪心 → M4 手调/发布 → M5 CP-SAT/增量 → M6 任务恢复 → M7 学生协作 → M8 双模板/迁移 → M9 交付。随推进在此展开子任务（先建骨架行）。

| 阶段 | 一句话范围 | 状态 |
|------|-----------|------|
| M2 | 时间/周次模型、解析器迁移、原子归档、课程手改、profile 版本 | pending |
| M3 | 规则/策略/预检、纯 Python 贪心、独立评价器、P01~P08 回归 | pending |
| M4 | 草稿/版本链、手调/锁定/例外/undo-redo、发布门禁与并发 | pending |
| M5 | CP-SAT 模型/目标、全量/增量/部分周、差异解释、oracle 基准 | pending |
| M6 | Job+outbox+dispatcher、Celery、恢复/重复投递测试 | pending |
| M7 | 学生端、请假、调班审批、通知 | pending |
| M8 | 导入/导出双模板、多周/历史导出、旧版迁移、备份恢复 | pending |
| M9 | 优化、E2E/性能/CI/部署、需求清零、演示与学习材料 | pending |

## 下一步（恢复会话从这里继续）

1. M0.3：用 uv 初始化 backend 项目并安装锁定依赖，冒烟 Django+OR-Tools import（记录版本）
2. M0.4：写 ADR-003（全栈架构替代关系）/ADR-004（双求解器与评价器）/ADR-005（版本协议）
3. M1.1：Django config + apps 骨架 + 首个迁移（开发期 SQLite，PG 验收挂起待环境）

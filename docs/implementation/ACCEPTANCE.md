# CRSM 原架构完善验收台账

当前依据：[原架构完善计划](../plans/CRSM-FRONTEND-IMPROVEMENT-PLAN.md) §13 与当前 CRSM-ZCODE-GOAL.md。旧 Web A01～A32 已归档，不再作为当前目标。

原始 F01～F08 必须全部完成；P01～P08 必须按新语义复核关闭。状态 pending 不表示功能已实现；verified 必须链接 VERIFICATION.md 的真实证据。

| 编号 | 验收摘要 | 状态 | 证据 |
| --- | --- | --- | --- |
| FE-01 | 合成夹具恢复算法测试，全量测试/构建通过 | verified | V-005：脱敏夹具恢复，162/162 + build 通过 |
| FE-02 | 严格规则、周次/节次和课表状态 | pending | |
| FE-03 | P01～P08 修复后验证与独立终态评价 | pending | |
| FE-04 | 缺口、均衡取舍、策略说明 | pending | |
| FE-05 | 批量混合结果、去重/重试、归属冲突 | pending | |
| FE-06 | 导入与课程修改原子回滚 | pending | |
| FE-07 | 课程手改、实验分批与影响分析 | pending | |
| FE-08 | 手调增删移动、安全检查、短段例外 | pending | |
| FE-09 | 按周锁定、均衡保护、uniform 冲突 | pending | |
| FE-10 | undo/redo 持久、版本递增与陈旧操作拒绝 | pending | |
| FE-11 | 双 Dexie 连接竞争时无丢失更新 | pending | |
| FE-12 | 全周期保存原子 | pending | |
| FE-13 | 增量少改动、范围与差异正确 | pending | |
| FE-14 | 有界改良/小实例/确定性与合法基线比较 | pending | |
| FE-15 | 原生 Worker、取消/超时/迟到消息无落库 | pending | |
| FE-16 | 快照自包含、历史导出与受控恢复 | pending | |
| FE-17 | 导入/导出双模板管理与版本 | pending | |
| FE-18 | 单周/多周/历史导出、隐私和文本边界 | pending | |
| FE-19 | 一致备份、版本/关联/摘要与保存取消 | pending | |
| FE-20 | 恢复回滚、独立恢复副本与跨机恢复 | pending | |
| FE-21 | schema3 无损升级、旧版本保全与未知格式拒绝 | pending | |
| FE-22 | 性能/包体、可行动首页与异常界面 | pending | |
| FE-23 | 干净机器断网安装到首次完整流程 | pending | |
| FE-24 | 文档、演示和学习资料真实，无必需网络服务 | pending | |

| 原始需求 | 对应当前验收 |
| --- | --- |
| F01 | FE-02/03/04/14/15 |
| F02 | FE-02/06/16 |
| F03 | FE-02/04/09 |
| F04 | FE-08/09/10/11/16 |
| F05 | FE-05/17/18 |
| F06 | FE-06/07 |
| F07 | FE-17/18 |
| F08 | FE-09/12/13/14 |

| 基线缺陷 | 状态 | 证据 |
| --- | --- | --- |
| P01 keep 绕过课程冲突 | **closed（算法层）** | V-009 入口校验 + V-007 评价器独立复核 |
| P02 keep 绕过时段上限 | **closed（算法层）** | V-009 |
| P03 均衡搬移手动项 | **closed（算法层）** | V-009（纯 auto 块才可搬） |
| P04 keep 缺周次跨周传播 | **closed** | V-009（KeepEntry.weekNo + 视图全周期构造） |
| P05 未知节次空冲突=安全 | in_progress | 算法保守占用 + 评价器 needs-review（V-007）；**冲突页 UI 待接** |
| P06 validateRules 接受非法组合 | **closed** | V-008（整数/范围/星期 1~7） |
| P07 normalize 改写自定义 8~11 | **closed** | V-008（不改写 + 待核对警告） |
| P08 修复轮残留孤立单节 | **closed（算法层）** | V-007（终态清理 + 全周评价） |

旧记录：[Web 验收台账归档](archive/ACCEPTANCE-WEB-2026-10-26.md)。保留其历史，不把旧状态挪作当前通过证据。

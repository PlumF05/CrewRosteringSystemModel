# CRSM 项目自主执行计划（阶段 1 → 阶段 8）

## 新工作契约（先固化到 docs/LEARNING-GUIDE.md）

1. **模块内自主决策**：设计方案、文件结构、技术细节由我决定并在模块报告中说明理由，不再模块内逐项确认；
2. **每模块自检自测**：单元测试（Vitest + fake-indexeddb）+ 构建验证 + 浏览器 GUI 自动走查（browser-use 模拟真实点击/输入验证 UI）全部通过才算模块完成；
3. **模块边界暂停**：每模块结束时给出报告（成果清单 / 自测结果 / 关键决策与理由 / 代码详细讲解 / git 状态），等你回复"继续"才进入下一模块；
4. **Git 纪律**：每模块一个 `feat/mXX-*` 分支，模块完成时合并回 main，约定式提交信息；
5. 保留：详细代码讲解、报错排查流程、文档与代码同步原则。

## 预备：阶段 0 收尾

- 提交当前全部文档与脚手架（feat/m00-scaffold → main），补 `docs/troubleshooting.md`（记录字体安装路径坑、Rust 改名坑）。

## 阶段 1：数据层（Dexie）

- `src/db/schema.ts`：Assistant/Course/DutySchedule/Config/OperationLog/ScheduleSnapshot 六个 TS 接口（对齐 ADR-002 5.2）；
- `src/db/database.ts`：Dexie 实例 + version(1).stores 索引声明；
- `src/db/repositories.ts`：六组 CRUD 仓储（唯一约束：学号查重）；
- 自测：Vitest + fake-indexeddb 仓储单测（增删改查/学号重复拦截），`npm run build` 通过。

## 阶段 2：路由骨架 + 助理信息管理（SRS F02）

- vue-router 五页面骨架（仪表盘/助理/课程表/排班配置/排班表）+ 侧边栏布局；
- `AssistantList.vue`（el-table + 搜索）+ `AssistantForm.vue`（el-dialog + 校验：姓名必填、学号唯一、手机正则、身份枚举）；
- 自测：浏览器 GUI 走查增删改查与非法输入拦截；构建通过。

## 阶段 3：课程表导入（F05/F06）

- 周次解析纯函数（"1-4周"/"10周"/单双周变体 → 数组）+ 全边界单测；
- xlsx 解析器：表头定位 → 合并单元格展开 → 单元格多行文本解析（对照 SRS 附录 A 实测格式）→ 行级错误收集；
- 导入预览页（成功/失败行列表，确认后入库）；支持按学生姓名+学号自动匹配助理；
- 自测：用根目录 timeTableForStu12.xlsx 真实文件写解析集成测试；GUI 走查导入流程。

## 阶段 4：排班算法（F01/F03）

- `src/algorithms/types.ts`（与数据层解耦的输入/输出类型）+ `greedy.ts`（空闲矩阵 → 时段按约束紧度排序 → 候选按空闲度分配 → 工时校验局部调整 → 未满足清单）；
- 排班规则配置页（F03：工时上下限、同时段人数、周期）写入 config 表；
- 自测：小型固定用例单测（含无解场景）、10 助理×17 周全量计时（要求毫秒级，SRS 限 5 秒）。

## 阶段 5：排班表 UI 与手动调整（F04）

- Pinia store（当前排班 + undo/redo 快照栈，深拷贝快照）；
- 周视图表格（时段×星期），指派/移除操作 + 实时约束校验警告 + 操作日志落库；
- 自测：store 单测（快照往返一致性）、GUI 走查"自动排班→手改→撤销→重做"。

## 阶段 6：导出与重新排班（F05/F08）

- SheetJS 导出（表头合并、冻结、列宽），导出后用脚本读回校验；兼容 Excel/WPS 打开；
- 重排：保留 source=manual 记录，其余重算；新旧快照 diff 三色对比视图；
- 自测：导出读回断言 + diff 逻辑单测 + GUI 走查。

## 阶段 7：Tauri 桌面化

- 安装 plugin-dialog/plugin-fs，capabilities 补权限，导入导出改走系统文件对话框；
- `npm run tauri build` 打包（首次 Rust 编译 5~15 分钟，属正常）；
- 自测：dist 产物存在 + exe 生成 + 版本信息正确。

## 阶段 8：收尾

- SRS 4.1 性能指标逐条验证清单、README 定稿（截图）、数据备份/恢复功能（风险 R03）、全量测试、tag v1.0.0。

## 执行方式

批准后我立即开始：阶段 0 提交 → 阶段 1 → …→ 每完成一个模块停下来给报告，你回复"继续"我就做下一模块；任一模块你可以要求返工或调整方向。
# 验证记录（VERIFICATION）

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

## V-003 后端依赖锁定与冒烟（M0.3，待填）

- 待执行：uv 初始化、依赖安装、Django/OR-Tools import 冒烟、版本记录。

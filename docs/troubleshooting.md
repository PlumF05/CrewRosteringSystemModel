# 排错手册（troubleshooting）

> 按步骤书 0.3 节，项目中有价值的坑位记录于此。格式：现象 → 根因 → 解决 → 教训。

---

## T-001 字体安装后 VS Code 不生效

- **现象**：按 JetBrains Mono 扩展的字体包设置 `editor.fontFamily`，编辑器字体不变。
- **根因**：用命令行注册用户字体时路径拼接少了一个反斜杠（`...\Windows\FontsJetBrainsMono-Regular.ttf`），字体从未真正注册，VS Code 静默回退到备选字体 Consolas，无任何报错。
- **解决**：清理错误注册表项（`HKCU\...\Fonts` 下 `JetBrains Mono *`），用 PowerShell 脚本以 `Join-Path` 拼路径重新复制+注册，并调用 `AddFontResource` + 广播 `WM_FONTCHANGE`；随后**完全退出** VS Code 再启动（Electron 进程只在启动时枚举字体，Reload Window 不够）。
- **教训**：① 字体"静默回退"不报错，排查必须查 GDI 注册结果而不是只看配置；② 跨 shell 拼 Windows 路径时用脚本文件而不是内联命令，避免多层转义；③ 用户字体注册在 `HKCU`，系统级在 `HKLM`，前者无需管理员。

## T-002 Rust 侧重命名需要三处同步

- **现象**：把脚手架 `scaffold-tmp` 改名为 `crsm` 时，若只改 `Cargo.toml` 的 package name，`main.rs` 里的 `scaffold_tmp_lib::run()` 编译报"找不到 crate"。
- **根因**：Tauri 项目 `Cargo.toml` 中 `[lib] name`（如 `crsm_lib`）与 `main.rs` 的调用点、`tauri.conf.json` 的 productName/identifier 是三组独立标识。
- **解决**：package/lib name、lib 调用、productName（安装包名）、identifier（应用唯一 ID）、窗口标题全部同步改。
- **教训**：Rust 编译器会拦住不一致，所以这类问题必现必报——比前端"静默 undefined"友好；改名后先 `cargo check` 再继续。

## T-003 Vue 模板模板编译错误的定位方式

- **现象**：`npm run build` 失败在 `vue-tsc` 阶段，报错行号指向编译产物。
- **解决**：先单独跑 `npx vue-tsc --noEmit` 拿到 .vue 源文件级别的报错行号，再修；不要直接读 vite 打包日志。
- **教训**：前端构建链分"类型检查（vue-tsc）→ 转译打包（vite）"两层，分别排查。

## T-004 Dexie `delete()` 后实例不会自动重开

- **现象**：单测 `beforeEach` 中 `await db.delete()` 后，首个数据库操作抛 `DatabaseClosedError: Database has been closed`，全部用例连挂。
- **根因**：原以为 Dexie 实例在 delete 后的下次操作会自动重开（autoOpen），实测（fake-indexeddb 环境，探针验证）delete 后实例保持 closed，autoOpen 不触发。
- **解决**：`await db.delete()` 之后显式 `await db.open()`。
- **教训**：对库的行为假设要用最小探针验证（10 行代码），而不是凭印象写 12 个用例再全挂；探针法把 30 分钟排查压缩成 1 次 15ms 的运行。

## T-005 管道吞掉命令退出码，带病提交

- **现象**：`npm run build | tail -3 && git commit` 在构建失败（TS6196 未使用类型）时依然执行了提交。
- **根因**：bash 管道的退出码默认取最后一个命令（tail 总是成功），`&&` 判断失真。
- **解决**：验证类命令要么单独跑，要么 `set -o pipefail`；提交前以"重新单独运行验证"为准。
- **教训**：自动化脚本里，`命令 | 美化输出 && 后续动作` 是经典陷阱；验证与提交必须解耦。

## T-006 弹窗表单残留上次数据（watch prop 失效）

- **现象**：GUI 走查发现，连续两次打开"新增助理"弹窗，第二次的表单里残留上一次填写（或编辑）的手机号、班级。
- **根因**：表单初始化写在 `watch(() => props.assistant)` 里。连续新增时该 prop 一直是 `null`，引用未变 → watch 不触发 → 表单不复位。
- **解决**：改为 `watch(visible)`（监听弹窗打开动作）在打开瞬间按 `props.assistant` 重置表单，并 `clearValidate()` 清除上次校验痕迹。
- **教训**：`watch` 依赖的是"值的变化"，`null → null` 不算变化；"打开容器"这类事件语义的状态（布尔量）才是正确的触发源。父组件必须保证先改 `assistant` 再改 `visible`。

## T-007 GUI 自动化中的"僵尸页面"：HMR 与浏览器缓存的混合劣化

- **现象**：开发服务器多次 HMR 后，浏览器内自动化（IAB）出现大面积诡异：Playwright 点击全部 actionability 超时、CUA 键盘事件（Enter/Ctrl+F5）不到达、截图失败、按钮原生 .click() 后 Vue 处理函数不执行、页面运行的模块版本落后于服务端。
- **根因**：长时间会话中 HMR 多次热替换 + guest 页面缓存，导致"服务端代码 / 页面运行代码 / 输入事件通道"三方不一致。表现为任何单一角度的排查都自相矛盾（编辑按钮好用、删除按钮不好用）。
- **解决**：完全重启 Vite（注意 git-bash 的 kill 杀不掉 Windows 进程，要用 `taskkill //F //PID`）→ 浏览器新开标签页 → 加临时 console.log 探针确认运行的代码版本 → 全绿。
- **教训**：① 排查"灵异问题"前先确认三方版本一致（服务器/页面/事件通道）；② `console.log` 探针是判定"代码版本"的最快手段；③ git-bash 下杀 Windows 进程用 taskkill；④ 将 ElMessageBox（命令式服务）替换为声明式 el-dialog 后，确认框行为一致且在该环境下可测——命令式服务在自动化环境中更脆弱。

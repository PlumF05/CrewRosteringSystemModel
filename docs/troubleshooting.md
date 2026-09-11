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

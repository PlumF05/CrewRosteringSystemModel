# Tauri 桌面化打包指南（v1.0）

> 适用：D:\CRSM（Tauri v2 + Vue 3 + Vite）。所有命令在**项目根目录**执行。
> 版本信息已就位：`package.json` / `src-tauri/Cargo.toml` / `src-tauri/tauri.conf.json` 均为 1.0.0。

## 0. 前置检查（一次性）

```powershell
cargo --version     # 需 1.7x+，MSVC 工具链（本项目 target/ 已有编译产物，说明已装）
node --version      # 18+
```

若 `cargo` 不存在：安装 rustup（https://rustup.rs），并确保 Visual Studio Build Tools（C++ 工作负载）已装。Windows 11 自带 WebView2，无需另装。

## 1. 安装插件（npm + cargo 各一次）

```powershell
npm install @tauri-apps/plugin-dialog @tauri-apps/plugin-fs
cd src-tauri
cargo add tauri-plugin-dialog tauri-plugin-fs
cd ..
```

## 2. Rust 侧注册插件：`src-tauri/src/lib.rs`

```rust
tauri::Builder::default()
    .plugin(tauri_plugin_opener::init())
    .plugin(tauri_plugin_dialog::init())   // 新增
    .plugin(tauri_plugin_fs::init())       // 新增
    .invoke_handler(tauri::generate_handler![greet])
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
```

## 3. capabilities 补权限：`src-tauri/capabilities/default.json`

在 `permissions` 数组中追加（保留原有条目）：

```json
"dialog:default",
{ "identifier": "fs:allow-read-file",  "allow": [{ "path": "**" }] },
{ "identifier": "fs:allow-write-file", "allow": [{ "path": "**" }] }
```

`path: "**"` = 允许读写用户通过对话框选中的任意路径（对话框选择的路径由用户授权，属常规做法）。

## 4. 前端接入系统文件对话框

**新增 `src/utils/fileAccess.ts`**（Tauri/浏览器双环境自适应）：

```ts
export const isTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window

/** Tauri：弹出系统"另存为"对话框并写文件；浏览器返回 false 由调用方走下载 */
export async function saveXlsx(fileName: string, data: Uint8Array): Promise<boolean> {
  if (!isTauri) return false
  const { save } = await import('@tauri-apps/plugin-dialog')
  const { writeFile } = await import('@tauri-apps/plugin-fs')
  const path = await save({ defaultPath: fileName, filters: [{ name: 'Excel 工作簿', extensions: ['xlsx'] }] })
  if (!path) return false // 用户取消
  await writeFile(path, data)
  return true
}

/** Tauri：弹出系统"打开"对话框并读文件；浏览器返回 null 由调用方走 <input type="file"> */
export async function openXlsx(): Promise<{ name: string; data: Uint8Array } | null> {
  if (!isTauri) return null
  const { open } = await import('@tauri-apps/plugin-dialog')
  const { readFile } = await import('@tauri-apps/plugin-fs')
  const picked = await open({ multiple: false, filters: [{ name: 'Excel 工作簿', extensions: ['xlsx'] }] })
  if (typeof picked !== 'string') return null
  return { name: picked.split(/[\\/]/).pop() ?? picked, data: await readFile(picked) }
}
```

**导出侧**：`src/utils/scheduleExport.ts` 已有 `buildScheduleWorkbook`，补一个产出二进制的函数：

```ts
export function buildScheduleFileBuffer(input: ExportInput): Uint8Array {
  return new Uint8Array(XLSX.write(buildScheduleWorkbook(input), { bookType: 'xlsx', type: 'array' }))
}
```

`ScheduleView.vue` 的导出处理改为：

```ts
const data = buildScheduleFileBuffer({ /* 原 ExportInput 参数不变 */ })
const saved = await saveXlsx(fileName, data)
if (!saved && !isTauri) exportScheduleFile(input, fileName) // 浏览器回退：原下载逻辑
```

**导入侧**：`CoursesView.vue` 把现有"选文件 → parseTimetableWorkbook → importTimetableForStudent"主体抽成 `handleBuffer(buf: Uint8Array)`；点击导入按钮时：

```ts
const picked = await openXlsx()
if (picked) await handleBuffer(picked.data)
// isTauri 为 false 时保持原有 <input type="file"> 流程
```

## 5. 打包

```powershell
npm run tauri build
```

- 首次 Rust 全量编译 **5~15 分钟属正常**（增量编译后续只需几十秒）。
- 若 MSI（WiX）下载失败，把 `tauri.conf.json` 的 `bundle.targets` 由 `"all"` 改为 `["nsis"]`（NSIS 安装包足够）。
- 可选建议：`app.windows` 里 800×600 偏小，可改 `"width": 1280, "height": 820`。

## 6. 自测清单

| 项 | 位置 | 判定 |
|---|---|---|
| 前端产物 | `dist/` | 存在且为新构建 |
| 主程序 | `src-tauri/target/release/crsm.exe` | 双击可运行 |
| 安装包 | `src-tauri/target/release/bundle/nsis/CRSM_1.0.0_x64-setup.exe` | 存在 |
| 版本信息 | 启动程序 → 侧栏「关于系统」 | 显示 v1.0 / PlumF |
| 导入 | 导入课程表 | 弹出系统"打开"对话框，选 xlsx 后正常导入 |
| 导出 | 导出排班表 | 弹出系统"另存为"对话框，保存后用 Excel/WPS 可打开、样式正常 |
| 数据 | 重启程序 | 排班/助理数据仍在（IndexedDB 本地持久化） |

## 7. 常见问题

- **杀毒软件拦截未签名 exe**：正常现象，添加信任或先跑 `npm run tauri dev` 验证功能。
- **端口 1420 被占用**（`tauri dev` 时）：本项目 Vite 配了 `strictPort`，先停掉旧 dev 进程。
- **改了前端但 exe 没变**：`tauri build` 每次都会先执行 `npm run build` 重新产出 dist，无需手动清。

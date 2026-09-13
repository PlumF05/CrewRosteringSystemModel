/**
 * 文件访问封装（2026-09-13，Tauri 桌面化阶段）：
 * 同一套业务代码在两种环境下自适应——
 *   • Tauri（Windows 桌面）：导入/导出走**系统文件对话框**（plugin-dialog + plugin-fs）；
 *   • 普通浏览器：返回 null/false，由调用方回退到原有流程（<input type="file"> / 浏览器下载）。
 *
 * 环境检测：Tauri v2 WebView 中存在 `__TAURI_INTERNALS__`（注入于页面脚本之前）。
 * 插件 JS 包按需动态 import，避免浏览器端加载无关代码。
 */
export const isTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window

const XLSX_FILTER = [{ name: 'Excel 工作簿', extensions: ['xlsx'] }]

/**
 * Tauri：弹出系统「另存为」对话框并把 xlsx 二进制写入所选路径。
 * @returns true=已保存；false=用户取消或非 Tauri 环境（调用方走浏览器下载回退）
 */
export async function saveXlsx(fileName: string, data: Uint8Array): Promise<boolean> {
  if (!isTauri) return false
  const { save } = await import('@tauri-apps/plugin-dialog')
  const { writeFile } = await import('@tauri-apps/plugin-fs')
  const path = await save({
    defaultPath: fileName,
    filters: XLSX_FILTER,
  })
  if (!path) return false
  await writeFile(path, data)
  return true
}

export interface PickedFile {
  /** 文件名（不含路径），用于展示与日志 */
  name: string
  data: Uint8Array
}

/**
 * Tauri：弹出系统「打开」对话框并读取所选 xlsx。
 * @returns 所选文件；null=用户取消或非 Tauri 环境（调用方走 <input type="file"> 回退）
 */
export async function openXlsx(): Promise<PickedFile | null> {
  if (!isTauri) return null
  const { open } = await import('@tauri-apps/plugin-dialog')
  const { readFile } = await import('@tauri-apps/plugin-fs')
  const picked = await open({ multiple: false, filters: XLSX_FILTER })
  if (typeof picked !== 'string') return null
  const data = await readFile(picked)
  return { name: picked.split(/[\\/]/).pop() ?? picked, data }
}

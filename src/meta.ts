/**
 * 应用元信息（2026-09-13 增补）——界面"关于"弹窗与文档展示的单一数据源。
 *
 * ⚠ 同步约定：`package.json`、`src-tauri/Cargo.toml`、`src-tauri/tauri.conf.json`
 * 三处的版本号需与本文件的 version 保持一致（当前 0.1.0，对外展示为 v0.1），
 * 修改版本时请一并更新。
 */
export const APP_META = {
  /** 系统全名 */
  name: "学院行政办助理排班系统",
  /** 简称（包名 / 仓库名） */
  shortName: "CRSM",
  /** 对外展示的版本号 */
  version: "v0.1",
  /** 作者 */
  author: "PlumF",
  /**
   * GitHub 仓库地址（占位符，待仓库建立后填写，如 https://github.com/PlumF/CRSM）。
   * 为空字符串时界面显示"待填写"。
   */
  repository: "",
  /** 一句话简介 */
  description:
    "面向学院行政办的学生助理排班工具：导入课程表、自动排班、手动调整(未实现),Excel 导出。单机桌面应用(Windows)，数据保存在本机。(大部分代码由AI生成 :P)",
} as const;

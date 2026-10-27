/**
 * 排班 Web Worker（S4 第三片 / FE-15，2026-10-26，计划 §5.5）。
 *
 * 协议：
 *   主线程 → Worker：{ type: 'run', jobId, input }
 *   Worker → 主线程：{ type: 'progress', jobId, progress } | { type: 'result', jobId, result }
 *                          | { type: 'error', jobId, message }
 *
 * 红线：Worker **只计算**，不 import 任何 db/仓储模块——不写 IndexedDB；
 * 取消/超时由主线程 terminate 完成；旧 jobId 的迟到消息在客户端被丢弃。
 */
import { runScheduleJob, type ScheduleJobInput, type ScheduleJobProgress, type ScheduleJobResult } from './scheduleJob'

export interface RunMessage {
  type: 'run'
  jobId: number
  input: ScheduleJobInput
}
export type WorkerOutMessage =
  | { type: 'progress'; jobId: number; progress: ScheduleJobProgress }
  | { type: 'result'; jobId: number; result: ScheduleJobResult }
  | { type: 'error'; jobId: number; message: string }

const post = (msg: WorkerOutMessage) => self.postMessage(msg)

self.onmessage = (e: MessageEvent<RunMessage>) => {
  const { type, jobId, input } = e.data
  if (type !== 'run') return
  try {
    const result = runScheduleJob(input, (progress) => post({ type: 'progress', jobId, progress }))
    post({ type: 'result', jobId, result })
  } catch (err) {
    post({ type: 'error', jobId, message: err instanceof Error ? err.message : '排班计算失败' })
  }
}

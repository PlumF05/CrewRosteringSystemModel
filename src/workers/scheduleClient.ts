/**
 * 排班 Worker 客户端（S4 第三片 / FE-15，2026-10-26）。
 *
 * 职责（主线程侧）：
 * - 管理单个 Worker 的生命周期；jobId 单调递增，**旧 jobId 的迟到消息一律丢弃**
 *   （取消/超时后 Worker 重新创建，旧实例即使抢在 terminate 前发出结果也不会落库）；
 * - 取消 = terminate Worker（计算即刻停止，当前排班零改动）并标记 cancelled；
 *   超时（默认 30s）自动取消；
 * - Worker 创建失败（环境不支持）时回退到主线程同步执行同一 runScheduleJob
 *   （协议不变，界面无感；进度直接回调）。
 *
 * 可测试性：Worker 工厂可注入（Vitest 用假 Worker 验证协议语义）。
 */
import { runScheduleJob, type ScheduleJobInput, type ScheduleJobProgress, type ScheduleJobResult } from './scheduleJob'
import type { WorkerOutMessage } from './scheduleWorker'

export type MinimalWorker = {
  postMessage: (msg: unknown) => void
  terminate: () => void
  addEventListener: (type: 'message', cb: (e: { data: WorkerOutMessage }) => void) => void
}

export type WorkerFactory = () => MinimalWorker | null

export const defaultWorkerFactory: WorkerFactory = () => {
  if (typeof Worker === 'undefined') return null
  try {
    return new Worker(new URL('./scheduleWorker.ts', import.meta.url), { type: 'module' }) as unknown as MinimalWorker
  } catch {
    return null
  }
}

export interface ScheduleClientOptions {
  /** 超时毫秒（默认 30_000；超时自动取消） */
  timeoutMs?: number
  /** 测试注入 */
  createWorker?: WorkerFactory
}

export class ScheduleWorkerClient {
  private worker: MinimalWorker | null = null
  private jobId = 0
  private cancelled = false
  /** 当前任务的终结回调（取消/超时经此收敛）；null = 无任务在跑 */
  private currentFinish: (() => void) | null = null

  constructor(private options: ScheduleClientOptions = {}) {}

  get isBusy(): boolean {
    return this.worker !== null
  }

  /**
   * 运行一次排班任务。
   * @returns 结果；若被取消/超时返回 null（当前排班不受任何影响——Worker 不写库）。
   */
  run(
    input: ScheduleJobInput,
    handlers: {
      onProgress?: (p: ScheduleJobProgress) => void
      onDone?: (r: ScheduleJobResult) => void
      onCancelled?: (reason: 'user' | 'timeout') => void
      onError?: (message: string) => void
    } = {},
  ): void {
    if (this.worker !== null) throw new Error('已有排班任务在运行（请先取消）')
    this.cancelled = false
    const jobId = ++this.jobId
    const factory = this.options.createWorker ?? defaultWorkerFactory
    const timeout = this.options.timeoutMs ?? 30_000

    // 本次运行的闭包级终结标志：旧任务（含被取消的）监听器与本任务互不干扰
    let done = false
    const finish = () => {
      done = true
      this.currentFinish = null
      if (this.timer !== null) clearTimeout(this.timer)
      this.timer = null
      if (this.worker) {
        this.worker.terminate()
        this.worker = null
      }
    }
    this.currentFinish = finish

    this.timer = setTimeout(() => {
      if (this.worker === null) return
      this.cancelled = true
      finish()
      handlers.onCancelled?.('timeout')
    }, timeout)

    const worker = factory()
    if (worker === null) {
      // 回退：主线程同步执行同一实现（含进度回调），协议一致
      finish()
      try {
        const result = runScheduleJob(input, (p) => handlers.onProgress?.(p))
        handlers.onDone?.(result)
      } catch (err) {
        handlers.onError?.(err instanceof Error ? err.message : '排班计算失败')
      }
      return
    }
    this.worker = worker

    worker.addEventListener('message', (e) => {
      const msg = e.data
      if (done) return // 本任务已终结（取消/超时/完成）：任何后续消息一律丢弃
      if (msg.jobId !== jobId) return // 旧 jobId 的迟到消息：丢弃（FE-15 红线）
      if (msg.type === 'progress') {
        handlers.onProgress?.(msg.progress)
      } else if (msg.type === 'result') {
        const result = msg.result
        finish()
        handlers.onDone?.(result)
      } else if (msg.type === 'error') {
        finish()
        handlers.onError?.(msg.message)
      }
    })

    worker.postMessage({ type: 'run', jobId, input } satisfies { type: 'run'; jobId: number; input: ScheduleJobInput })
  }

  /** 用户取消：终止计算，当前排班零改动 */
  cancel(): void {
    if (this.worker === null) return
    this.cancelled = true
    this.currentFinish?.()
  }

  get wasCancelled(): boolean {
    return this.cancelled
  }

  private timer: ReturnType<typeof setTimeout> | null = null
}

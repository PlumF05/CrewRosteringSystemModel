/**
 * Worker 客户端协议测试（S4 第三片 / FE-15，2026-10-26）。
 * 用假 Worker 验证：结果/进度流转、取消即终止且零副作用、超时自动取消、
 * 旧 jobId 迟到消息丢弃、Worker 不可用时回退主线程同一实现。
 */
import { describe, expect, it, vi } from 'vitest'
import { ScheduleWorkerClient, type MinimalWorker, type WorkerFactory } from './scheduleClient'
import { runScheduleJob, type ScheduleJobInput, type ScheduleJobProgress } from './scheduleJob'
import { DEFAULT_RULES, type WeeklySchedule } from '../algorithms/types'

const input = (): ScheduleJobInput => ({
  rules: { ...DEFAULT_RULES, weekEnd: 2 },
  assistants: [
    { id: 1, name: '甲', identity: 'undergrad' },
    { id: 2, name: '乙', identity: 'undergrad' },
  ],
  courses: [],
})

/** 假 Worker：记录 postMessage，允许测试手动注入回发消息与检查 terminate */
class FakeWorker implements MinimalWorker {
  terminated = false
  received: unknown[] = []
  private listeners: Array<(e: { data: unknown }) => void> = []
  postMessage(msg: unknown): void {
    this.received.push(msg)
  }
  terminate(): void {
    this.terminated = true
  }
  addEventListener(_type: 'message', cb: (e: { data: unknown }) => void): void {
    this.listeners.push(cb)
  }
  emit(data: unknown): void {
    for (const l of this.listeners) l({ data })
  }
}

describe('runScheduleJob（Worker 内核，纯函数）', () => {
  it('产出全部周 + 独立评价合法 + 进度单调推进', () => {
    const progresses: ScheduleJobProgress[] = []
    const r = runScheduleJob(input(), (p) => progresses.push(p))
    expect(r.weeks).toHaveLength(2)
    expect(r.legal).toBe(true)
    const percents = progresses.map((p) => p.percent)
    for (let i = 1; i < percents.length; i++) expect(percents[i]).toBeGreaterThanOrEqual(percents[i - 1])
    expect(progresses[0].stage.stage).toBe('generating')
  })
})

describe('ScheduleWorkerClient（协议语义）', () => {
  it('正常流转：run → progress → result，完成后 Worker 被回收', () => {
    const fw = new FakeWorker()
    const client = new ScheduleWorkerClient({ createWorker: () => fw })
    const onProgress = vi.fn()
    const onDone = vi.fn<(r: { weeks: WeeklySchedule[] }) => void>()
    client.run(input(), { onProgress, onDone })
    expect(fw.received[0]).toMatchObject({ type: 'run', jobId: 1 })

    const jobId = (fw.received[0] as { jobId: number }).jobId
    fw.emit({ type: 'progress', jobId, progress: { percent: 50, message: 'x', stage: { stage: 'generating', detail: '' } } })
    fw.emit({ type: 'result', jobId, result: { weeks: [], reports: [], legal: true, elapsedMs: 1 } })

    expect(onProgress).toHaveBeenCalledTimes(1)
    expect(onDone).toHaveBeenCalledTimes(1)
    expect(fw.terminated).toBe(true)
    expect(client.isBusy).toBe(false)
  })

  it('取消：terminate 立即执行、不再接受结果、cancelled 标记', () => {
    const fw = new FakeWorker()
    const client = new ScheduleWorkerClient({ createWorker: () => fw })
    const onDone = vi.fn()
    const onCancelled = vi.fn()
    client.run(input(), { onDone, onCancelled })
    client.cancel()
    expect(fw.terminated).toBe(true)
    expect(client.wasCancelled).toBe(true)
    // 取消后旧 jobId 的迟到结果被丢弃
    const jobId = (fw.received[0] as { jobId: number }).jobId
    fw.emit({ type: 'result', jobId, result: { weeks: [], reports: [], legal: true, elapsedMs: 1 } })
    expect(onDone).not.toHaveBeenCalled()
  })

  it('旧 jobId 迟到消息丢弃（新任务启动后，旧 Worker 消息不影响）', () => {
    const fw = new FakeWorker()
    const client = new ScheduleWorkerClient({ createWorker: () => fw })
    const onDone = vi.fn()
    client.run(input(), { onDone })
    client.cancel()
    client.run(input(), { onDone }) // jobId=2
    // 旧 jobId=1 的消息
    fw.emit({ type: 'result', jobId: 1, result: { weeks: [], reports: [], legal: true, elapsedMs: 0 } })
    expect(onDone).not.toHaveBeenCalled()
    // 正确 jobId=2 的消息
    fw.emit({ type: 'result', jobId: 2, result: { weeks: [], reports: [], legal: true, elapsedMs: 0 } })
    expect(onDone).toHaveBeenCalledTimes(1)
  })

  it('超时：自动取消并回调 onCancelled("timeout")', () => {
    vi.useFakeTimers()
    const fw = new FakeWorker()
    const client = new ScheduleWorkerClient({ createWorker: () => fw, timeoutMs: 100 })
    const onDone = vi.fn()
    const onCancelled = vi.fn()
    client.run(input(), { onDone, onCancelled })
    vi.advanceTimersByTime(150)
    expect(fw.terminated).toBe(true)
    expect(onCancelled).toHaveBeenCalledWith('timeout')
    expect(onDone).not.toHaveBeenCalled()
    vi.useRealTimers()
  })

  it('Worker 不可用 → 回退主线程同一实现（结果一致）', () => {
    const client = new ScheduleWorkerClient({ createWorker: () => null })
    const onDone = vi.fn<(r: ReturnType<typeof runScheduleJob>) => void>()
    client.run(input(), { onDone })
    expect(onDone).toHaveBeenCalledTimes(1)
    expect(onDone.mock.calls[0][0].weeks).toHaveLength(2)
    expect(onDone.mock.calls[0][0].legal).toBe(true)
  })
})

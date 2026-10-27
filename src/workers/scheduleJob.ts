/**
 * 排班任务的可运行单元（S4 第三片 / FE-15，2026-10-26，计划 §5.5）。
 *
 * 从 Worker 消息协议中剥离出来：**纯函数**（不碰 Worker API、不碰数据库），
 * Worker 内核与主线程回退路径共用同一实现，可在 Vitest 里直接测试。
 * Worker 只做计算与进度上报，**永不写业务数据库**（计划红线）。
 */
import { evaluateAllWeeks } from '../algorithms/evaluate'
import { scheduleAll } from '../algorithms/greedy'
import { improveWeek } from '../algorithms/improve'
import type { BaseScheduleInput, KeepEntry, WeeklySchedule } from '../algorithms/types'
import type { EvaluationReport } from '../algorithms/evaluate'

export interface ScheduleJobInput {
  rules: BaseScheduleInput['rules']
  assistants: BaseScheduleInput['assistants']
  courses: BaseScheduleInput['courses']
  keep?: KeepEntry[]
  /** 是否逐周做有界局部改良（默认 true） */
  improve?: boolean
}

export type ScheduleJobStage =
  | { stage: 'generating'; detail: string }
  | { stage: 'improving'; detail: string; weekNo: number }
  | { stage: 'evaluating'; detail: string }

export interface ScheduleJobResult {
  weeks: WeeklySchedule[]
  reports: EvaluationReport[]
  legal: boolean
  elapsedMs: number
}

export interface ScheduleJobProgress {
  /** 0~100 */
  percent: number
  message: string
  stage: ScheduleJobStage
}

/** 计算主体；onProgress 由 Worker（或同步调用方）用来上报阶段与百分比 */
export function runScheduleJob(
  input: ScheduleJobInput,
  onProgress: (p: ScheduleJobProgress) => void,
): ScheduleJobResult {
  const t0 = performance.now()
  onProgress({ percent: 5, message: '正在生成基线方案…', stage: { stage: 'generating', detail: '贪心主分配' } })
  const base = { rules: input.rules, assistants: input.assistants, courses: input.courses, keep: input.keep }
  const raw = scheduleAll(base)

  let weeks = raw
  if (input.improve !== false) {
    const total = raw.length || 1
    weeks = raw.map((w, i) => {
      const r = improveWeek(base, w)
      onProgress({
        percent: 10 + Math.floor(((i + 1) / total) * 70),
        message: `正在优化第 ${w.weekNo} 周方案…`,
        stage: { stage: 'improving', detail: `第 ${w.weekNo} 周`, weekNo: w.weekNo },
      })
      return r.week
    })
  }

  onProgress({ percent: 90, message: '正在独立校验最终方案…', stage: { stage: 'evaluating', detail: '终态评价' } })
  const { legal, reports } = evaluateAllWeeks(
    weeks.map((w) => ({ ...base, weekNo: w.weekNo, assignments: w.assignments })),
  )

  return { weeks, reports, legal, elapsedMs: performance.now() - t0 }
}

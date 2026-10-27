/**
 * 性能基准（S6 / FE-22，2026-10-26）：计划口径——
 *   ① 50 助理 × 17 周 × 5 天 × 8 节（默认 上午1~4/下午6~9）：生成 + 逐周改良 + 独立终态评价 总耗时 ≤ 5 秒
 *   ② 标准课表解析 ≤ 3 秒（仓库脱敏样例）
 * 固定 seed（可复现）；输出机器无关的计数与真实毫秒数，供 VERIFICATION 记录。
 * 运行：npx vite-node scripts/perf-bench.ts
 */
import { readFileSync, existsSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { scheduleAll } from '../src/algorithms/greedy'
import { improveWeek } from '../src/algorithms/improve'
import { evaluateAllWeeks } from '../src/algorithms/evaluate'
import { DEFAULT_RULES } from '../src/algorithms/types'
import { parseTimetableWorkbook } from '../src/utils/courseParser'
import type { CourseInput } from '../src/algorithms/types'

const here = dirname(fileURLToPath(import.meta.url))

// ---- ① 排班与评价 ----
const A = 50
const rules = { ...DEFAULT_RULES } // 17 周 × 工作日 1~5 × 上午1~4+下午6~9 = 8 节/天
let seed = 20261026
const rand = (n: number) => ((seed = (seed * 1103515245 + 12345) % 2147483648) % n)

const assistants = Array.from({ length: A }, (_, i) => ({
  id: i + 1,
  name: `助理${i + 1}`,
  identity: 'undergrad' as const,
}))
const courses: CourseInput[] = []
for (const a of assistants) {
  for (let k = 0; k < 12; k++) {
    // 每人 12 门课：随机星期/节次/周次区间/类别——制造 realistic 占用密度
    const day = rand(5) + 1
    const start = rand(2) === 0 ? 1 + rand(2) : 6 + rand(2)
    const len = 1 + rand(3)
    const w1 = 1 + rand(16)
    const w2 = Math.min(17, w1 + rand(6))
    courses.push({
      assistantId: a.id,
      kind: rand(2) === 0 ? 'theory' : 'experiment',
      dayOfWeek: day,
      sectionText: `第${start}节-第${Math.min(13, start + len - 1)}节`,
      weekRanges: [[w1, w2]],
    })
  }
}
const base = { rules, assistants, courses } as const
const totalSlots = 17 * 5 * 8

const t0 = performance.now()
const raw = scheduleAll({ ...base })
const tGen = performance.now() - t0

const t1 = performance.now()
const improved = raw.map((w) => improveWeek({ ...base }, w).week)
const tImprove = performance.now() - t1

const t2 = performance.now()
const { legal, reports } = evaluateAllWeeks(improved.map((w) => ({ ...base, weekNo: w.weekNo, assignments: w.assignments })))
const tEval = performance.now() - t2

const total = tGen + tImprove + tEval
const totalAssignments = improved.reduce((s, w) => s + w.assignments.length, 0)
const unmetTotal = reports.reduce((s, r) => s + r.gaps.filter((g) => g.type === 'slot-understaffed').length, 0)

console.log('=== ① 排班与评价（50 人 × 17 周 × 5 天 × 8 节）===')
console.log(`输入：${A} 助理 / ${courses.length} 门课 / ${totalSlots} 时段`)
console.log(`生成（scheduleAll）：${tGen.toFixed(0)} ms`)
console.log(`逐周有界改良（17 周）：${tImprove.toFixed(0)} ms`)
console.log(`独立终态评价（17 周）：${tEval.toFixed(0)} ms`)
console.log(`合计：${total.toFixed(0)} ms（口径 ≤ 5000 ms）→ ${total <= 5000 ? 'PASS' : 'FAIL'}`)
console.log(`结果：${totalAssignments} 条安排 / 合法=${legal} / 缺口时段 ${unmetTotal}/${totalSlots}`)

// ---- ② 课表解析 ----
const SAMPLE = resolve(here, '../samples/示例学生A.xlsx')
if (existsSync(SAMPLE)) {
  const data = new Uint8Array(readFileSync(SAMPLE))
  // 预热一次（JIT/模块加载不计入口径）
  parseTimetableWorkbook(data)
  const t3 = performance.now()
  const r = parseTimetableWorkbook(data)
  const tParse = performance.now() - t3
  console.log('\n=== ② 标准课表解析（脱敏样例 A.xlsx）===')
  console.log(`解析：${tParse.toFixed(0)} ms（口径 ≤ 3000 ms）→ ${tParse <= 3000 ? 'PASS' : 'FAIL'}（${r.courses.length} 门课）`)
} else {
  console.log('\n（样例缺失，跳过解析基准）')
}

console.log(`\n机器：Node ${process.version}；seed=20261026（可复现）`)
process.exit(total <= 5000 ? 0 : 1)

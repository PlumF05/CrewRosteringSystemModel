import { describe, expect, it } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseTimetableWorkbook } from './courseParser'

/**
 * 课程表解析器集成测试（SRS 附录 A 格式定义的回归锚点）。
 *
 * 夹具来源：`samples/` 下三份**脱敏**学院课程表——由真实课程表转录而来，
 * 个人信息（学生姓名/学号、上课教师、文档属性制作者）已全部替换为占位符，
 * 课程/周次/节次/地点等教学数据保持原样。
 * （原始文件不入库；脱敏口径与踩坑记录见 docs/troubleshooting.md T-013）
 *
 * 断言分两层：「结构不变式」不依赖具体数据（任何合法课表都应符合）；
 * 「冻结基线」锁定三份夹具的实测值（条数/警告数/代表条目），解析行为一旦漂移立即报警。
 * 夹具缺失时整组跳过，不使测试套件失败。
 */
const here = dirname(fileURLToPath(import.meta.url))
const SAMPLES_DIR = resolve(here, '../../samples')

interface SampleSpec {
  file: string
  studentName: string
  studentNo: string
  /** 冻结基线：实测课程条数 */
  courses: number
  /** 冻结基线：无法解析的条目数（进入 problems） */
  problems: number
}

const SAMPLES: SampleSpec[] = [
  { file: '示例学生A.xlsx', studentName: '示例学生A', studentNo: '2026000001', courses: 42, problems: 2 },
  { file: '示例学生B.xlsx', studentName: '示例学生B', studentNo: '2026000002', courses: 48, problems: 2 },
  { file: '示例学生C.xlsx', studentName: '示例学生C', studentNo: '2026000003', courses: 41, problems: 1 },
]

const missing = SAMPLES.filter((s) => !existsSync(resolve(SAMPLES_DIR, s.file)))
const describeSamples = missing.length === 0 ? describe : describe.skip

if (missing.length > 0) {
  console.warn(
    `[courseParser.test] 跳过集成测试：缺少夹具 ${missing.map((m) => m.file).join('、')}（应位于 samples/）`,
  )
}

const parse = (file: string) =>
  parseTimetableWorkbook(new Uint8Array(readFileSync(resolve(SAMPLES_DIR, file))))

/** 每个样本只解析一次，供各用例复用 */
const cache = new Map<string, ReturnType<typeof parse>>()
const resultOf = (spec: SampleSpec) => {
  if (!cache.has(spec.file)) cache.set(spec.file, parse(spec.file))
  return cache.get(spec.file)!
}

const EXPECTED_SLOT_LABELS = [
  '第一节-第二节',
  '第三节-第五节',
  '中课1-中课2',
  '第六节-第八节',
  '第九节-第十节',
  '晚课-晚课',
  '第十一节-第十三节',
]

describeSamples('parseTimetableWorkbook（脱敏样例集成测试）', () => {
  for (const spec of SAMPLES) {
    describe(spec.file, () => {
      it('解析出学生占位信息与学期（脱敏后不含真实个人信息）', () => {
        const r = resultOf(spec)
        expect(r.studentName).toBe(spec.studentName)
        expect(r.studentNo).toBe(spec.studentNo)
        expect(r.semester).toBe('2026-2027-1')
      })

      it('解析出全部 7 个时段块标签（含中课/晚课命名节次）', () => {
        const r = resultOf(spec)
        expect(r.slotLabels).toEqual(EXPECTED_SLOT_LABELS)
      })

      it('课程条数与无法解析的条目数符合冻结基线', () => {
        const r = resultOf(spec)
        expect(r.courses.length).toBe(spec.courses)
        expect(r.problems.length).toBe(spec.problems)
      })

      it('结构不变式：星期合法、周次非空、节次原文保留、课程号存在', () => {
        const r = resultOf(spec)
        expect(r.courses.length).toBeGreaterThan(0)
        for (const c of r.courses) {
          expect(c.dayOfWeek).toBeGreaterThanOrEqual(1)
          expect(c.dayOfWeek).toBeLessThanOrEqual(7)
          expect(c.weekRanges.length).toBeGreaterThan(0)
          for (const [s, e] of c.weekRanges) {
            expect(s).toBeGreaterThanOrEqual(1)
            expect(e).toBeGreaterThanOrEqual(s)
            expect(e).toBeLessThanOrEqual(17)
          }
          expect(c.sectionText).toBeTruthy()
          expect(c.courseNo).toBeTruthy()
          expect(c.courseName).toBeTruthy()
          expect(['theory', 'experiment']).toContain(c.kind)
        }
      })

      it('确定性：同一文件重复解析结果一致', () => {
        const r = resultOf(spec)
        const again = parse(spec.file)
        expect(JSON.stringify(again.courses)).toBe(JSON.stringify(r.courses))
        expect(again.problems.length).toBe(r.problems.length)
      })
    })
  }

  describe('内容细项（示例学生A，覆盖各类节次与条目形态）', () => {
    const r = () => resultOf(SAMPLES[0])

    it('理论课：软件工程 10125121047 / 星期1 / 第一节-第二节 / 1-4周', () => {
      const se = r().courses.find((c) => c.courseNo === '10125121047')
      expect(se).toBeTruthy()
      expect(se!.courseName).toBe('软件工程')
      expect(se!.kind).toBe('theory')
      expect(se!.dayOfWeek).toBe(1)
      expect(se!.sectionText).toBe('第一节-第二节')
      expect(se!.weekRanges).toContainEqual([1, 4])
      expect(se!.location).toContain('博学东楼')
    })

    it('多段周次：数据库系统综合实验 10124214068 含 10-17周', () => {
      const dbLab = r().courses.find((c) => c.courseNo === '10124214068')
      expect(dbLab).toBeTruthy()
      expect(dbLab!.kind).toBe('theory')
      expect(dbLab!.sectionText).toBe('第一节-第四节')
      expect(dbLab!.weekRanges).toContainEqual([10, 17])
    })

    it('实验课：课程号 20261-07741 的 8 个批次，实验项目存入 note', () => {
      const exp = r().courses.filter((c) => c.courseNo === '20261-07741')
      expect(exp.length).toBe(8)
      expect(exp.every((c) => c.kind === 'experiment')).toBe(true)
      expect(exp.some((c) => c.note?.includes('索引和完整性语言'))).toBe(true)
      const weeks = exp.flatMap((c) => c.weekRanges.map(([s]) => s)).sort((a, b) => a - b)
      expect(weeks).toEqual([10, 11, 12, 13, 14, 15, 16, 17])
    })

    it('命名节次：含「第三节-中课2」的条目，数字侧可解析、命名侧保留原文', () => {
      const mid = r().courses.find((c) => c.sectionText === '第三节-中课2')
      expect(mid).toBeTruthy()
      expect(mid!.sectionStart).toBe(3)
      expect(mid!.sectionEnd).toBeNull()
      expect(mid!.kind).toBe('experiment')
      expect(mid!.courseNo).toBe('20261-01999')
    })

    it('星期日条目正常解析（机器学习，dayOfWeek = 7）', () => {
      const sun = r().courses.find((c) => c.dayOfWeek === 7)
      expect(sun).toBeTruthy()
      expect(sun!.courseName).toBe('机器学习')
      expect(sun!.weekRanges).toEqual([[2, 2]])
    })

    it('未确定时间的课程进入 problems，且不污染课程列表', () => {
      const p = r().problems
      expect(p.some((x) => x.text.includes('操作系统课程设计'))).toBe(true)
      expect(p.some((x) => x.text.includes('编译原理课程设计'))).toBe(true)
      expect(p.every((x) => x.reason && x.text)).toBe(true)
    })

    it('无个人信息泄漏：姓名为占位符，课程数据不含手机号、邮箱、QQ', () => {
      const all = r()
      expect(all.studentName).toBe('示例学生A')
      expect(all.studentNo).toBe('2026000001')
      const blob = JSON.stringify(all.courses)
      expect(blob).not.toMatch(/1[3-9]\d{9}/)
      expect(blob).not.toMatch(/@/)
      expect(blob).not.toMatch(/QQ/i)
    })
  })
})

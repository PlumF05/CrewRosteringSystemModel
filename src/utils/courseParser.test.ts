import { describe, expect, it } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseTimetableWorkbook } from './courseParser'

/**
 * 用真实样例文件做集成测试（仓库根目录 timeTableForStu12.xlsx）。
 * 这是对 SRS 附录 A 格式定义的回归锚点：样例变了一点点，测试立刻报警。
 *
 * 2026-09-13：样例含真实学生个人信息，已从仓库移除（见 Git 历史）。样例缺失时
 * 本组用例**整体跳过**而非报错——把文件放回根目录即可恢复完整的集成覆盖；
 * 其余解析行为由构造数据用例（本目录其他断言与夹具级测试）继续守护。
 */
const here = dirname(fileURLToPath(import.meta.url))
const sample = resolve(here, '../../timeTableForStu12.xlsx')
const hasSample = existsSync(sample)
const result = hasSample
  ? parseTimetableWorkbook(new Uint8Array(readFileSync(sample)))
  : (null as unknown as ReturnType<typeof parseTimetableWorkbook>)

const describeRealSample = hasSample ? describe : describe.skip

describeRealSample('parseTimetableWorkbook（真实样例集成测试）', () => {
  it('解析出学生与学期信息', () => {
    expect(result.studentName).toBe('庞士豪')
    expect(result.studentNo).toBe('1024005228')
    expect(result.semester).toBe('2026-2027-1')
  })

  it('解析出 7 个时段块标签', () => {
    expect(result.slotLabels).toHaveLength(7)
    expect(result.slotLabels).toContain('第一节-第二节')
    expect(result.slotLabels).toContain('中课1-中课2')
    expect(result.slotLabels).toContain('晚课-晚课')
    expect(result.slotLabels).toContain('第十一节-第十三节')
  })

  it('解析出全部课程条目（含实验课）', () => {
    // 样例实测：理论课 22 条 + 实验课 20 条 = 42 条（重复去重后）
    expect(result.courses.length).toBeGreaterThanOrEqual(40)
    // 理论课：软件工程 1-4周 星期1
    const se = result.courses.find((c) => c.courseName === '软件工程' && c.weekRanges[0][0] === 1)
    expect(se).toBeTruthy()
    expect(se!.courseNo).toBe('10125121047')
    expect(se!.className).toBe('02')
    expect(se!.weekRanges).toEqual([[1, 4]])
    expect(se!.dayOfWeek).toBe(1)
    expect(se!.sectionText).toBe('第一节-第二节')
    expect(se!.location).toContain('博学东楼-303')
  })

  it('多周次区间条目（信息安全：1-4周,6-9周 + 10周单列）', () => {
    const info = result.courses.filter((c) => c.courseName === '信息安全')
    expect(info.length).toBe(2)
    const long = info.find((c) => c.weekRanges.length === 2)!
    expect(long.weekRanges).toEqual([[1, 4], [6, 9]])
    expect(long.sectionText).toBe('第三节-第五节')
    const single = info.find((c) => c.weekRanges.length === 1)!
    expect(single.weekRanges).toEqual([[10, 10]])
    expect(single.sectionText).toBe('第三节-第四节')
  })

  it('实验课条目：批次号课程号 + 实验项目存 note', () => {
    // 10-17周共 8 个实验批次（E9 与 E15 各出现一次，去重后 8 条）
    const exp = result.courses.filter((c) => c.courseNo === '20261-07741')
    expect(exp.length).toBe(8)
    const one = exp.find((c) => c.note?.includes('索引和完整性语言'))!
    expect(one.courseName).toBe('数据库系统综合实验')
    expect(one.weekRanges).toEqual([[10, 10]])
    // 另一门实验课（华为云），节次含非数字标签
    const hw = result.courses.filter((c) => c.courseNo === '20261-01999')
    expect(hw.length).toBeGreaterThanOrEqual(1)
    expect(hw[0].note).toContain('基于华为云的系统分析')
  })

  it('非数字节次标签（中课/晚课）→ section 为 null 但保留原文', () => {
    const mid = result.courses.find((c) => c.sectionText === '第三节-中课2')!
    expect(mid).toBeTruthy()
    expect(mid.sectionStart).toBe(3)
    expect(mid.sectionEnd).toBeNull()
    // "晚课"只是网格行标签；晚课格子里的课程写的是真实节次"第九节-第十一节"
    const night = result.courses.find((c) => c.sectionText === '第九节-第十一节')!
    expect(night).toBeTruthy()
    expect(night.sectionStart).toBe(9)
    expect(night.sectionEnd).toBe(11)
  })

  it('星期日条目正常解析（星期7）', () => {
    const sun = result.courses.find((c) => c.dayOfWeek === 7)
    expect(sun).toBeTruthy()
    expect(sun!.courseName).toBe('机器学习')
  })

  it('未确定时间的课程进入 problems 而非课程列表', () => {
    expect(result.problems.some((p) => p.text.includes('操作系统课程设计'))).toBe(true)
    expect(result.problems.some((p) => p.text.includes('编译原理课程设计'))).toBe(true)
    expect(result.courses.every((c) => c.weekRanges.length > 0)).toBe(true)
  })

  it('所有课程 dayOfWeek 均在 1-7', () => {
    expect(result.courses.every((c) => c.dayOfWeek >= 1 && c.dayOfWeek <= 7)).toBe(true)
  })
})

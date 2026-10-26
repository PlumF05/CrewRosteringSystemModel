/**
 * 课表状态四分类测试（S1，2026-10-26，FE-02）。
 * 覆盖：旧数据保守回填、可排班判定、导入状态推导（空课表/未知节次/正常）。
 */
import { describe, expect, it } from 'vitest'
import {
  TIMETABLE_STATUS_LABEL,
  deriveImportStatus,
  isSchedulableStatus,
  timetableStatusOf,
} from './timetableStatus'

describe('运行时状态判定（含旧数据回填）', () => {
  it('无标记 + 有课程记录 → 保守回填为 ready（确实提交过课表）', () => {
    expect(timetableStatusOf({}, true)).toBe('ready')
  })
  it('无标记 + 无课程记录 → missing（未提交课表≠全天空闲）', () => {
    expect(timetableStatusOf({}, false)).toBe('missing')
  })
  it('已持久化的三态原样读取', () => {
    expect(timetableStatusOf({ timetableStatus: 'ready' }, false)).toBe('ready')
    expect(timetableStatusOf({ timetableStatus: 'confirmed_empty' }, false)).toBe('confirmed_empty')
    expect(timetableStatusOf({ timetableStatus: 'needs_review' }, true)).toBe('needs_review')
  })
  it('可排班 = ready / confirmed_empty；missing 与 needs_review 不可排班', () => {
    expect(isSchedulableStatus('ready')).toBe(true)
    expect(isSchedulableStatus('confirmed_empty')).toBe(true)
    expect(isSchedulableStatus('missing')).toBe(false)
    expect(isSchedulableStatus('needs_review')).toBe(false)
  })
  it('四态均有展示文案', () => {
    for (const s of ['ready', 'confirmed_empty', 'needs_review', 'missing'] as const) {
      expect(TIMETABLE_STATUS_LABEL[s].length).toBeGreaterThan(0)
    }
  })
})

describe('导入状态推导', () => {
  it('正常课程（数字/中课/晚课均可识别）→ ready', () => {
    expect(
      deriveImportStatus([{ sectionText: '第一节-第二节' }, { sectionText: '中课1-晚课' }]),
    ).toBe('ready')
  })
  it('存在无法识别的节次 → needs_review（P05：不能当安全）', () => {
    expect(deriveImportStatus([{ sectionText: '第一节-第二节' }, { sectionText: '待定' }])).toBe(
      'needs_review',
    )
  })
  it('空课表 → confirmed_empty（文件本身就是无课的证据）', () => {
    expect(deriveImportStatus([])).toBe('confirmed_empty')
  })
})

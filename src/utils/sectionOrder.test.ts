import { describe, expect, it } from 'vitest'
import {
  SECTION_SEQUENCE,
  ordinalOverlaps,
  sectionNumber,
  sectionOrdinal,
  sectionOrdinalRange,
} from './sectionOrder'

/**
 * 节次序号轴测试（2026-09-13 增补）。
 * 这是"课程表节次 ↔ 排班表节次"对齐的基础，任何偏差都会导致在课上排班，
 * 因此对序号映射逐项锁定。
 */

describe('sectionNumber（课表原文里的数字节号，仅用于展示）', () => {
  it('阿拉伯数字与中文数字写法', () => {
    expect(sectionNumber('1')).toBe(1)
    expect(sectionNumber('第6节')).toBe(6)
    expect(sectionNumber('三')).toBe(3)
    expect(sectionNumber('第十节')).toBe(10)
    expect(sectionNumber('十一')).toBe(11)
    expect(sectionNumber('十三')).toBe(13)
  })

  it('命名节次不属于数字序列 → null', () => {
    expect(sectionNumber('中课1')).toBeNull()
    expect(sectionNumber('中课2')).toBeNull()
    expect(sectionNumber('晚课')).toBeNull()
  })
})

describe('sectionOrdinal（当日先后序号）', () => {
  it('序列与课程表 A 列时段块的实测顺序一致', () => {
    expect(SECTION_SEQUENCE).toEqual([
      '1', '2', '3', '4', '5', '中课1', '中课2', '6', '7', '8', '9', '10', '晚课', '11', '12', '13',
    ])
  })

  it('上午数字节次的序号即节号', () => {
    expect(sectionOrdinal('第1节')).toBe(1)
    expect(sectionOrdinal('第四节')).toBe(4)
    expect(sectionOrdinal('第5节')).toBe(5)
  })

  it('命名节次有确定序号：中课1=6、中课2=7、晚课=13', () => {
    expect(sectionOrdinal('中课1')).toBe(6)
    expect(sectionOrdinal('中课2')).toBe(7)
    expect(sectionOrdinal('晚课')).toBe(13)
  })

  it('下午节次序号 = 节号 + 2（中课1/中课2 占了两个位置）——这是本次修复的关键换算', () => {
    expect(sectionOrdinal('第6节')).toBe(8)
    expect(sectionOrdinal('第7节')).toBe(9)
    expect(sectionOrdinal('第8节')).toBe(10)
    expect(sectionOrdinal('第9节')).toBe(11)
    expect(sectionOrdinal('第10节')).toBe(12)
  })

  it('晚上节次序号在晚课之后', () => {
    expect(sectionOrdinal('第11节')).toBe(14)
    expect(sectionOrdinal('第12节')).toBe(15)
    expect(sectionOrdinal('第13节')).toBe(16)
  })

  it('无法识别的写法返回 null（调用方须保守处理，不得静默放过）', () => {
    expect(sectionOrdinal('待定')).toBeNull()
    expect(sectionOrdinal('')).toBeNull()
    expect(sectionOrdinal('第99节')).toBeNull()
  })
})

describe('sectionOrdinalRange（节次原文 → 序号区间）', () => {
  it('数字节次与命名节次的各种组合', () => {
    expect(sectionOrdinalRange('第六节-第八节')).toEqual({ start: 8, end: 10 })
    expect(sectionOrdinalRange('第九节-第十节')).toEqual({ start: 11, end: 12 })
    expect(sectionOrdinalRange('中课1-中课2')).toEqual({ start: 6, end: 7 })
    expect(sectionOrdinalRange('中课1-第七节')).toEqual({ start: 6, end: 9 })
    expect(sectionOrdinalRange('第三节-中课2')).toEqual({ start: 3, end: 7 })
    expect(sectionOrdinalRange('第九节-晚课')).toEqual({ start: 11, end: 13 })
  })

  it('单节写法两端取同值', () => {
    expect(sectionOrdinalRange('第9节')).toEqual({ start: 11, end: 11 })
    expect(sectionOrdinalRange('晚课')).toEqual({ start: 13, end: 13 })
  })

  it('分隔符兼容 - ~ —', () => {
    expect(sectionOrdinalRange('第6节~第7节')).toEqual({ start: 8, end: 9 })
    expect(sectionOrdinalRange('第六节—第八节')).toEqual({ start: 8, end: 10 })
  })

  it('任一侧无法识别 → null', () => {
    expect(sectionOrdinalRange('待定')).toBeNull()
    expect(sectionOrdinalRange('第一节-待定')).toBeNull()
    expect(sectionOrdinalRange('')).toBeNull()
  })
})

describe('ordinalOverlaps', () => {
  it('排班时段为单节，命中区间才视为占用', () => {
    expect(ordinalOverlaps({ start: 8, end: 10 }, { start: 9, end: 9 })).toBe(true)
    expect(ordinalOverlaps({ start: 8, end: 10 }, { start: 8, end: 8 })).toBe(true)
    expect(ordinalOverlaps({ start: 8, end: 10 }, { start: 11, end: 11 })).toBe(false)
    expect(ordinalOverlaps({ start: 8, end: 10 }, { start: 7, end: 7 })).toBe(false)
  })
})

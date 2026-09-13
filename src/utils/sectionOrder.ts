/**
 * 学院节次体系（2026-09-13 增补，依据真实课程表 A 列时段块实测归纳）。
 *
 * 课程表的节次**不是纯数字连续**，而是"数字节次 + 命名节次"混排：
 *
 *   上午：第1节 ~ 第5节
 *   午间：中课1、中课2
 *   下午：第6节 ~ 第10节
 *   傍晚：晚课
 *   晚上：第11节 ~ 第13节
 *
 * 为什么必须有这一层：课程表与排班表若各用一套节次编号，同一节真实课程会被
 * 判成两个不同的节（实测冲突：课程表"第6节"是下午第一节，而排班表把下午第一节
 * 编号为"第8节"）。算法按节号比较区间时会漏判——例如课程"第六节-第八节"只与
 * 排班"第8节"相交，"第9节""第10节"被当成空闲，于是**在学生上课时间排班**。
 *
 * 因此本模块提供唯一可信的**节次序号轴**（按当日先后，1 起）：
 *   数字节次与命名节次都被换算成同一个序号，课程占用与排班时段都在该轴上比较。
 * 排班表的上班节次编号也已对齐为课程表的编号（上午 1~4、下午 6~9，见 algorithms/types.ts）。
 */

/**
 * 节次全序列（按当日先后顺序）。
 * 顺序取自课程表 A 列时段块的实测排列：
 *   第一节-第二节 | 第三节-第五节 | 中课1-中课2 | 第六节-第八节
 *   | 第九节-第十节 | 晚课-晚课 | 第十一节-第十三节
 */
export const SECTION_SEQUENCE: readonly string[] = [
  '1', '2', '3', '4', '5', '中课1', '中课2', '6', '7', '8', '9', '10', '晚课', '11', '12', '13',
]

const CN_NUM: Record<string, number> = {
  一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9,
}

/** 去掉"第""节"与空白，得到纯记号（"第6节" → "6"） */
function normalizeToken(token: string): string {
  return token.replace(/^第/, '').replace(/节$/, '').trim()
}

/**
 * 节次记号 → **数字节号**（支持阿拉伯数字与中文数字：3 / 三 / 十三 / 第6节）。
 * 命名节次（中课1、中课2、晚课）不属于数字序列，返回 null。
 * 该函数产出的是"课表原文里的节号"，仅用于展示与定位，**不可用于跨体系比较**。
 */
export function sectionNumber(token: string): number | null {
  const t = normalizeToken(token)
  if (!t) return null
  if (/^\d+$/.test(t)) return Number(t)
  if (t === '十') return 10
  const m1 = t.match(/^十(.)$/)
  if (m1 && CN_NUM[m1[1]]) return 10 + CN_NUM[m1[1]]
  const m2 = t.match(/^(.)十$/)
  if (m2 && CN_NUM[m2[1]]) return CN_NUM[m2[1]] * 10
  if (CN_NUM[t]) return CN_NUM[t]
  return null
}

/**
 * 节次记号 → **序号**（1 起，按当日先后）。
 * 命名节次同样有确定序号（中课1 = 6、中课2 = 7、晚课 = 13）。
 * 无法识别返回 null，调用方应退化为保守处理（视为整日占用），不得静默放过。
 */
export function sectionOrdinal(token: string): number | null {
  const raw = token.trim()
  if (!raw) return null
  // 优先按原文精确匹配（涵盖"中课1""晚课"这类命名节次）
  const direct = SECTION_SEQUENCE.indexOf(raw)
  if (direct >= 0) return direct + 1
  // 再兼容"第6节"/"6"/"六"等写法：先取数字节号，再回到序列里定位
  const num = sectionNumber(raw)
  if (num === null) return null
  const pos = SECTION_SEQUENCE.indexOf(String(num))
  return pos >= 0 ? pos + 1 : null
}

/**
 * 解析"节次原文"为**序号区间**，如：
 *   "第三节-中课2"  → { start: 3, end: 7 }
 *   "中课1-第七节"  → { start: 6, end: 9 }
 *   "第六节-第八节" → { start: 8, end: 10 }
 *   "第九节-晚课"   → { start: 11, end: 13 }
 * 分隔符兼容 - ~ —；单侧缺失时取与另一侧同值；
 * 任一侧无法识别则返回 null（调用方退化为一整天占用）。
 */
export function sectionOrdinalRange(sectionText: string): { start: number; end: number } | null {
  const parts = sectionText
    .split(/[-~—]/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
  if (parts.length === 0) return null
  const a = sectionOrdinal(parts[0])
  const b = parts.length > 1 ? sectionOrdinal(parts[1]) : a
  if (a === null || b === null) return null
  return { start: Math.min(a, b), end: Math.max(a, b) }
}

/** 两个序号区间是否相交（排班时段为单节，因此区间长度为 1） */
export function ordinalOverlaps(
  a: { start: number; end: number },
  b: { start: number; end: number },
): boolean {
  return a.start <= b.end && a.end >= b.start
}

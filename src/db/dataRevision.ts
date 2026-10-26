/**
 * 业务数据版本（dataRevision，S2 / 计划 §6）。
 *
 * 语义：config 表 key='dataRevision' 存一个单调递增整数；**每次改变业务数据的写事务**
 * （导入、全周期保存、课程编辑、手调提交……）在同一事务内将其 +1。
 * 读方（生成预览、手调界面、撤销栈）记录"当时"的版本，提交时携带期望版本——
 * 版本不一致即说明中间发生过其他写入（另一窗口/另一次导入），必须刷新重校验，
 * 不允许旧操作覆盖新数据（FE-10/FE-11 的判定基础）。
 *
 * 并发保证：校验与写入发生在**同一个 Dexie 读写事务**里，两个连接基于同一旧版本
 * 提交时，后提交者的事务会因版本已变而失败——最多一个成功，无丢失更新。
 *
 * expectedRevision 传 null 表示"强制写"（不需要乐观校验的内部维护操作）。
 */
import type { Table } from 'dexie'
import { db } from './database'

export const DATA_REVISION_KEY = 'dataRevision'

/** 版本冲突：期望的版本不是当前版本（数据已被其他写入改变） */
export class StaleDataError extends Error {
  constructor(
    public expected: number,
    public actual: number,
  ) {
    super(`数据已变化：操作基于版本 ${expected}，当前已是版本 ${actual}。请刷新后重试`)
    this.name = 'StaleDataError'
  }
}

/** 当前业务数据版本；从未写入过时为 0 */
export async function getDataRevision(): Promise<number> {
  const entry = await db.config.get(DATA_REVISION_KEY)
  return (entry?.value as number | undefined) ?? 0
}

/**
 * 带版本校验的写事务：校验 → 业务写入 → 版本 +1，三者原子。
 * @param expectedRevision 期望的当前版本；null = 不校验（强制写）
 * @param tables 业务写入涉及的表（config 一定包含）
 * @returns 业务写入的返回值 + 事务提交后的新版本号
 */
export async function withDataRevision<T>(
  expectedRevision: number | null,
  tables: Table[],
  fn: () => Promise<T>,
): Promise<{ result: T; revision: number }> {
  return db.transaction('rw', [db.config, ...tables], async () => {
    const cur = await getDataRevision()
    if (expectedRevision !== null && expectedRevision !== cur) {
      throw new StaleDataError(expectedRevision, cur)
    }
    const result = await fn()
    const next = cur + 1
    await db.config.put({ key: DATA_REVISION_KEY, value: next })
    return { result, revision: next }
  })
}

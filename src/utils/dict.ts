/** 字典：枚举值 → 中文显示文案。集中管理避免各页面硬编码散落 */
import type { Identity } from '../db/schema'

export const IDENTITY_LABEL: Record<Identity, string> = {
  undergrad: '本科生',
  graduate: '研究生',
}

export const IDENTITY_OPTIONS = (Object.keys(IDENTITY_LABEL) as Identity[]).map((v) => ({
  value: v,
  label: IDENTITY_LABEL[v],
}))

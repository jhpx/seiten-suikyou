/*
 * 路径 / query 取参 —— 只有三个控制器都会用的那点事，放一处。
 *
 * `:uid{[0-9]+}` 已在路由模板里限死数字（非数字路径压根不匹配），所以这里不再校验，
 * 直接 Number()。locale 认不出会退回默认语言，由 i18n.resolveLocale 归一。
 */
import type { Context } from 'hono'

import * as i18n from '../common/i18n.ts'

/** 路径里的数字段 */
export const num = (c: Context, name: string): number => Number(c.req.param(name))

/** query 里的语言 */
export const localeOf = (c: Context): string => i18n.resolveLocale(c.req.query('locale'))

/*
 * 系统信息控制器：/api/meta（语言表 + 界面文案 + 权重筛选项）、/api/health（探活）。
 * 这两条不碰业务数据，故意不挂限流 —— 探活被限会误报故障。
 */
import type { Context, Handler } from 'hono'

import * as i18n from '../common/i18n.ts'
import type { ApiContext } from '../service/context.ts'
import { ok } from './reply.ts'

/* query 里的语言（认不出会退回默认语言） */
const localeOf = (c: Context): string => i18n.resolveLocale(c.req.query('locale'))

export const meta = (ctx: ApiContext): Handler => (c) => {
  const loc = localeOf(c)
  return ok(c, {
    locales: i18n.locales(),
    defaultLocale: i18n.DEFAULT_LOCALE,
    /* 表还没同步时为 false —— 页面据此提示「只有中文」 */
    i18nReady: i18n.available(),
    ui: i18n.uiTable(loc),
    /* 首页「按属性权重筛选」的选项名，跟着语言一起给 —— 前端不写死词条名 */
    weightOptions: ctx.meta.weightOptions(loc)
  })
}

export const health = (ctx: ApiContext): Handler => (c) => ok(c, { uids: ctx.accounts.count() })

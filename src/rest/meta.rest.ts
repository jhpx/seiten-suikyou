/*
 * 系统信息控制器：/api/meta（语言表 + 界面文案 + 权重筛选项）、
 * /api/health（后端存活探针）、/api/region（数据源在线状态快照）、
 * /api/stats（uid 使用统计）。
 * 这几条不碰业务数据，故意不挂限流 —— 状态探针被限会误报故障。
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

/* 「看后端是否正常」—— 纯存活探针：能回这个接口就说明后端活着。
   不碰数据库、不查上游，所以数据源挂了也不影响它（数据源状态见 /api/region）。 */
export const health = (ctx: ApiContext): Handler => (c) => ok(c, {
  status: ctx.health.live() ? 'ok' : 'degraded'
})

/* 「看数据源是否正常」—— Enka 官方各区分服 + MicroGG 镜像两服的在线状态。
   后端每 5 分钟同步一次 status.enka.network 的快照，前端进页面读一次铺成指示灯。
   不在用户点刷新时查 —— 这是「一眼看见」用的常驻标识。 */
export const region = (ctx: ApiContext): Handler => (c) => ok(c, {
  regions: ctx.region.regions(),
  microggServers: ctx.region.microggServers()
})

/* uid 使用统计 —— 与 region 无关，单独成接口。只读 fetch_log 现算，不新增表 / 列。 */
export const stats = (ctx: ApiContext): Handler => (c) => ok(c, ctx.stats.uidStats())

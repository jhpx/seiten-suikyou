/*
 * GET /api/meta   —— 进页面时调一次：语言表、界面文案、权重筛选项。
 * GET /api/health —— 存活探针 / 部署自检：回库里的 uid 数。
 *
 * 两个都是「系统信息」：只读元数据与库概况，不碰业务数据，所以不限流
 * （探活被限住会误报故障）。放一个文件是因为它们就十来行，各占一个文件只是多两份 import。
 */
import { i18n } from '../../index.ts'
import { weightFilterOptions } from '../../view/shape.ts'
import * as repo from '../../store/repo.ts'
import { sendJson } from '../http.ts'
import type { Endpoint } from './context.ts'

export const meta: Endpoint = (_ctx, _req, res, url) => {
  const loc = i18n.resolveLocale(url.searchParams.get('locale'))
  sendJson(res, 200, {
    ok: true,
    data: {
      locales: i18n.locales(),
      defaultLocale: i18n.DEFAULT_LOCALE,
      /* 表还没同步时为 false —— 页面据此提示「只有中文」 */
      i18nReady: i18n.available(),
      /* 归一化过一遍，'zh-cn' 也能落到 chs */
      ui: i18n.uiTable(loc),
      /* 首页「按属性权重筛选」的选项名，跟着语言一起给 —— 前端不写死词条名 */
      weightOptions: weightFilterOptions(loc)
    }
  })
}

export const health: Endpoint = (ctx, _req, res) => {
  sendJson(res, 200, { ok: true, data: { uids: repo.listUids(ctx.db).length } })
}

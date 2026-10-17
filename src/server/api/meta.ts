/*
 * GET /api/meta —— 进页面时调一次：语言表、界面文案、权重筛选项。
 * 界面文案和权重选项一起给，前端切语言就不用再问一次。
 */
import { i18n } from '../../index.ts'
import { weightFilterOptions } from '../../view/shape.ts'
import { sendJson } from '../http.ts'
import type { Handler } from './context.ts'

export const meta: Handler = (_ctx, _req, res, url) => {
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

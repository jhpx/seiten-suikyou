/*
 * URL 表 —— 这个文件只有一件事：哪个方法 + 哪条路径 + 哪个限流档，交给哪个控制器。
 *
 * 处理逻辑一律在 rest/ 顶层（拿参数、判 404、拼响应都在那边，一个资源一个文件）。
 * 想改接口路由，只动这里；想改某个接口的行为，去 rest/<资源>.rest.ts。
 *
 * 路径规矩：资源复数，层级只到资源 —— /api/accounts、/api/accounts/:uid、
 * 其下的 /characters/:avatarId/damage；抓取挂成动作子资源 /refresh。
 *
 * `:uid{[0-9]+}` 把动态段限死数字：非数字的路径根本匹配不上（直接 404），
 * 端点里就不用再校验一遍 id 合不合法。也正因为参数都在 URL 里，没有任何接口需要请求体。
 *
 * 限流档位写在每条路由自己的中间件上：read = 只读库；fetch = 会联网打 enka，最紧；
 * 不挂 = 不限（探活与元信息）。
 */
import type { Hono } from 'hono'

import type { ApiContext, Guard } from '../service/context.ts'
import * as account from '../rest/account.rest.ts'
import * as character from '../rest/character.rest.ts'
import * as meta from '../rest/meta.ts'

export function mountRoutes (app: Hono, ctx: ApiContext, guard: Guard): void {
  /* —— 系统：语言表 / 界面文案 / 探活（不碰业务数据，故意不限流） —— */
  app.get('/api/meta', meta.meta(ctx))
  app.get('/api/health', meta.health(ctx))

  /* —— 账号：列表 → 单账号 → 刷新 → 其下的角色 —— */
  app.get('/api/accounts', guard('read'), account.list(ctx))
  app.get('/api/accounts/:uid{[0-9]+}', guard('read'), account.detail(ctx))

  /* 唯一会联网写库的接口，走抓取档 */
  app.post('/api/accounts/:uid{[0-9]+}/refresh', guard('fetch'), account.refresh(ctx))

  app.get('/api/accounts/:uid{[0-9]+}/characters/:avatarId{[0-9]+}/damage',
    guard('read'), character.damage(ctx))

  /* —— 模拟比对：换一套配装，重算面板与伤害 ——
     ⚠️ 模拟是全站第一个收请求体的接口（配装是结构化对象，塞 URL 既超长又不可读）。
        路径参数与语言照旧走 URL，响应包络不变。 */
  app.get('/api/accounts/:uid{[0-9]+}/characters/:avatarId{[0-9]+}/simulator',
    guard('read'), character.simCatalog(ctx))
  app.post('/api/accounts/:uid{[0-9]+}/characters/:avatarId{[0-9]+}/simulator',
    guard('read'), character.simulate(ctx))
}

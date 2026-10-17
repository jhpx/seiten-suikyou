/*
 * 接口层的共用类型 —— 路由匹配到之后，handler 从这里取「库 / 视图 / 抓取」。
 *
 * handler 不必知道这些怎么装配：db 从哪来、并发抓取怎么合并，都留在 server/index.ts。
 */
import type { IncomingMessage, ServerResponse } from 'node:http'

import type { DatabaseSync } from '../../store/db.ts'
import type { buildAccountView } from '../../view/shape.ts'
import type { IngestResult } from '../../adapter/ingest.ts'

/** handler 能看到的三件事：库、整包视图、抓取动作 */
export interface ApiContext {
  db: DatabaseSync
  /** 库 → 视图对象；库里没有这个 uid 时返回 null */
  viewOf: (uid: number, locale: string) => ReturnType<typeof buildAccountView> | null
  /** 抓一次 enka 并落库（同一个 uid 的并发请求已合并） */
  handleFetch: (uid: number) => Promise<IngestResult>
}

/** 路径里的动态段（`:uid` / `:avatarId`）。模板只收数字，所以这里直接是 number。 */
export type RouteParams = Record<string, number>

/** 统一签名：路由负责匹配与取参，handler 只管「拿数据、回响应」。 */
export type Handler = (
  ctx: ApiContext,
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  params: RouteParams
) => void | Promise<void>

/** 「库里没这个账号」的 404 文案 —— 顺带告诉调用方怎么把数据弄进来。
 *  接口路径只写在这一处，改路径不用满仓库找提示语。 */
export const noData = (uid: number): string =>
  `库里没有 uid ${uid}。先抓一次：POST /api/accounts/${uid}/refresh`

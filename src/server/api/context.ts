/*
 * 接口层的共用上下文 —— 路由匹配到之后，各 handler 从这里取「库 / 视图 / 抓取」。
 *
 * 这样 handler 不必知道这些是怎么装配的：db 从哪来、并发抓取怎么合并，
 * 都留在 server/index.ts。handler 只负责「拿数据、回响应」。
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

/** 统一签名：路由负责匹配，handler 只管回响应。params 是正则捕获组（uid / avatarId）。 */
export type Handler = (
  ctx: ApiContext,
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  params: string[]
) => void | Promise<void>

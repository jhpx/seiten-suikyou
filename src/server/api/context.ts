/*
 * 接口层的共用类型 —— 路由匹配到之后，端点函数从这里取「库 / 视图 / 抓取」。
 *
 * 端点不必知道这些怎么装配：db 从哪来、并发抓取怎么合并，都留在 server/index.ts。
 */
import type { IncomingMessage, ServerResponse } from 'node:http'

import type { DatabaseSync } from '../../store/db.ts'
import type { buildAccountView } from '../../view/shape.ts'
import type { IngestResult } from '../../adapter/ingest.ts'

/** 端点函数能看到的三件事：库、整包视图、抓取动作 */
export interface ApiContext {
  db: DatabaseSync
  /** 库 → 视图对象；库里没有这个 uid 时返回 null */
  viewOf: (uid: number, locale: string) => ReturnType<typeof buildAccountView> | null
  /** 抓一次 enka 并落库（同一个 uid 的并发请求已合并） */
  handleFetch: (uid: number) => Promise<IngestResult>
}

/** 路径里的动态段（`:uid` / `:avatarId`）。模板只收数字，所以这里直接是 number。 */
export type RouteParams = Record<string, number>

/**
 * 接口实现函数的签名 —— 不是事件回调，是路由表里每一行「这个路径由谁来做」。
 * 标上它，各资源文件里的端点函数就不用手写五个形参类型；signature 写错也会当场报错。
 * 职责只有两件：拿数据、回响应。匹配、取参、限流都在外面。
 */
export type Endpoint = (
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

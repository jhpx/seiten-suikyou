/*
 * 响应原语。整个服务只有一种成功形状和一种失败形状：
 *   成功 { ok: true, data }（可选 meta）   失败 { ok: false, error: { code, message } }
 * 前端只认这两种。server/ 的兜底（notFound / onError）也借它保持同一种形状。
 */
import type { Context } from 'hono'

export const ok = (c: Context, data: unknown, meta?: unknown) =>
  c.json(meta === undefined ? { ok: true, data } : { ok: true, data, meta })

export const fail = (c: Context, status: 400 | 403 | 404 | 405 | 429 | 500 | 502, code: string, message: string, headers?: Record<string, string>) =>
  c.json({ ok: false, error: { code, message } }, status, headers)

/* 「库里没这个账号」的 404 文案 —— 顺带告诉调用方怎么把数据弄进来。
   接口路径只写这一处，改路径不用满仓库找提示语。 */
export const noData = (uid: number): string =>
  `库里没有 uid ${uid}。先抓一次：POST /api/accounts/${uid}/refresh`

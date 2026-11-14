/*
 * 上游取数的 HTTP 原语：GET、跟随重定向、解压 body，只暴露 ok / status / text / json。
 *
 * 用 node:https 而不是全局 fetch：fetch 没法按次放宽 TLS 校验，这里把开关做成
 * insecureTls 参数，默认 false。开启后中间人可以伪造响应，只在确认链路可信时使用。
 * AbortSignal 触发时抛 AbortError，让上层把「超时」和「连不上」分开说。
 */

import { request as httpRequest, type IncomingMessage } from 'node:http'
import { request as httpsRequest, type RequestOptions } from 'node:https'
import { brotliDecompressSync, gunzipSync, inflateSync } from 'node:zlib'

export interface HttpResponse {
  ok: boolean
  status: number
  text: () => Promise<string>
  json: () => Promise<unknown>
}

export interface HttpInit {
  headers?: Record<string, string>
  signal?: AbortSignal
  /** 跳过 TLS 证书校验；默认 false */
  insecureTls?: boolean
}

/** 取数函数的形状。测试可以塞假的进来，见 test/enka.ts 的 spy()。 */
export type HttpGet = (url: string, init?: HttpInit) => Promise<HttpResponse>

const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308])
const MAX_REDIRECTS = 5

/* 上游平时回的是 identity，但 gzip 之类也照解，免得哪天开了压缩就静默解析失败 */
function decodeBody (buf: Buffer, encoding: string): string {
  switch (encoding) {
    case 'gzip': return gunzipSync(buf).toString('utf8')
    case 'deflate': return inflateSync(buf).toString('utf8')
    case 'br': return brotliDecompressSync(buf).toString('utf8')
    default: return buf.toString('utf8')
  }
}

/** 发一次 GET，把响应体整段读回来（上游响应都在几十 KB 量级）。 */
function requestOnce (
  url: URL,
  init: HttpInit
): Promise<{ status: number; location?: string; body: string }> {
  return new Promise((resolve, reject) => {
    const options: RequestOptions = {
      protocol: url.protocol,
      hostname: url.hostname,
      port: url.port || undefined,
      path: `${url.pathname}${url.search}`,
      method: 'GET',
      headers: { 'accept-encoding': 'identity', ...init.headers },
      /* 只有调用方明确要求时才不校验；默认沿用 Node 的正常校验 */
      ...(init.insecureTls ? { rejectUnauthorized: false } : {})
    }

    const onResponse = (res: IncomingMessage) => {
      const chunks: Buffer[] = []
      res.on('data', (chunk: Buffer) => chunks.push(chunk))
      res.on('error', reject)
      res.on('end', () => {
        try {
          resolve({
            status: res.statusCode ?? 0,
            location: res.headers.location,
            body: decodeBody(Buffer.concat(chunks), String(res.headers['content-encoding'] ?? '').toLowerCase())
          })
        } catch (e) { reject(e) }
      })
    }

    /* 上层用 AbortController 做超时。抛出的错误必须叫 AbortError——
       enka.fetch.ts 靠这个名字把「超时」和「连不上」分开说。 */
    const onAbort = () => {
      req.destroy(Object.assign(new Error('This operation was aborted'), { name: 'AbortError' }))
    }

    const req = url.protocol === 'https:'
      ? httpsRequest(options, onResponse)
      : httpRequest(options, onResponse)

    req.on('error', reject)
    if (init.signal?.aborted) { onAbort(); return }
    init.signal?.addEventListener('abort', onAbort, { once: true })
    req.on('close', () => init.signal?.removeEventListener('abort', onAbort))
    req.end()
  })
}

async function follow (url: string, init: HttpInit, left: number): Promise<HttpResponse> {
  const target = new URL(url)
  const { status, location, body } = await requestOnce(target, init)

  /* fetch 默认跟重定向，这里照做；换成 https 的裸请求后得自己补上 */
  if (location && REDIRECT_STATUS.has(status)) {
    if (left <= 0) throw new Error(`重定向次数过多：${url}`)
    return follow(new URL(location, target).href, init, left - 1)
  }

  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => body,
    json: async () => JSON.parse(body) as unknown
  }
}

/** 取一个上游 URL。默认校验证书；`insecureTls` 才放宽。 */
export function httpGet (url: string, init: HttpInit = {}): Promise<HttpResponse> {
  return follow(url, init, MAX_REDIRECTS)
}

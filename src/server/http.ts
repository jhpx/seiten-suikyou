/*
 * HTTP 响应原语 —— 发 JSON、发文件、读请求体。
 *
 * 只跟 ServerResponse / IncomingMessage 打交道，不认识业务：谁调用、回什么状态码由上层决定。
 * 静态托管（static.ts）和接口（api/）都从这里取件，所以它属于 server 层，不属于 api 层。
 */
import fs from 'node:fs'
import path from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'

/** 额外的响应头（按需） */
export type Headers = Record<string, string>

const BODY_LIMIT = 64 * 1024

/** 扩展名 → Content-Type。静态页与素材共用一张表，改这里一处生效。 */
export const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff'
}

/* catch 到的一律是 unknown（TS 从 4.4 起）—— 取人话消息统一走这里 */
export const errMessage = (e: unknown): string => (e instanceof Error ? e.message : String(e))

export function sendJson (res: ServerResponse, status: number, obj: unknown, headers?: Headers): void {
  const body = JSON.stringify(obj)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    ...(headers || {})
  })
  res.end(body)
}

/* 失败一律走这个形状：{ ok:false, error:{ code, message } } */
export function sendError (res: ServerResponse, status: number, code: string, message: string, headers?: Headers): void {
  sendJson(res, status, { ok: false, error: { code, message } }, headers)
}

export function sendFile (res: ServerResponse, file: string, { cache = 'no-cache' }: { cache?: string } = {}): void {
  const buf = fs.readFileSync(file)
  res.writeHead(200, {
    'Content-Type': MIME_TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream',
    'Content-Length': buf.length,
    'Cache-Control': cache
  })
  res.end(buf)
}

/* 请求体 JSON —— 形状由各接口自己认（这里只保证「是个对象」）。空体回 {}，坏 JSON 抛错。 */
export function readBody (req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => {
      size += c.length
      if (size > BODY_LIMIT) { reject(new Error('请求体过大')); req.destroy(); return }
      chunks.push(c)
    })
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8').trim()
      if (!raw) return resolve({})
      try { resolve(JSON.parse(raw)) } catch { reject(new Error('请求体不是合法 JSON')) }
    })
    req.on('error', reject)
  })
}

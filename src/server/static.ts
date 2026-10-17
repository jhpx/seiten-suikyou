/*
 * 静态托管 —— 页面文件与图片素材都在 web/（前端子仓库 seiten-suikyou-web 的检出）。
 *
 * 两个入口同一套防护：扩展名白名单 + 目录穿越 + 不存在即 404。
 * 为什么不用通用静态服务：这里只要「能按路径找到文件就发」，自己写这几十行比引中间件更省。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ServerResponse } from 'node:http'

import { MIME_TYPES, sendError, sendFile, sendJson } from './http.ts'

const HERE = path.dirname(fileURLToPath(import.meta.url))

/** 前端静态目录（index.html / *.js / *.css / assets/）—— 即 web/ 子模块。index.ts 发首页时也用它。 */
export const PUBLIC = path.resolve(HERE, '../../web')
const ASSETS_DIR = path.join(PUBLIC, 'assets')
const ASSETS_ROOT = path.resolve(ASSETS_DIR)

/* 图片素材：扩展名白名单 + 目录穿越防护 */
export function serveAsset (res: ServerResponse, pathname: string): void {
  const ext = path.extname(pathname).toLowerCase()
  if (!MIME_TYPES[ext]) {
    sendError(res, 404, 'asset_type', `不支持的资源类型：${ext}`)
    return
  }
  const rel = decodeURIComponent(pathname.slice('/assets/'.length))
  const filePath = path.resolve(path.join(ASSETS_DIR, rel))
  if (!filePath.startsWith(ASSETS_ROOT + path.sep) && filePath !== ASSETS_ROOT) {
    sendError(res, 403, 'asset_escape', '路径不合法')
    return
  }
  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    sendError(res, 404, 'asset_missing', '资源不存在')
    return
  }
  sendFile(res, filePath, { cache: 'public, max-age=86400' })
}

/* 通用静态页：按扩展名安全托管整个 public 目录（前端拆成多个 ES 模块后，写死白名单会 404）。
   目录穿越防护 + 扩展名白名单 + 不存在即 404，与 serveAsset 同一套思路。 */
export function servePublic (res: ServerResponse, pathname: string): void {
  const rel = decodeURIComponent(pathname.replace(/^\/+/, ''))
  const filePath = path.resolve(PUBLIC, rel)
  if (filePath !== PUBLIC && !filePath.startsWith(PUBLIC + path.sep)) {
    sendJson(res, 404, { ok: false })
    return
  }
  if (!MIME_TYPES[path.extname(filePath).toLowerCase()]) {
    sendJson(res, 404, { ok: false })
    return
  }
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    sendJson(res, 404, { ok: false })
    return
  }
  sendFile(res, filePath)
}

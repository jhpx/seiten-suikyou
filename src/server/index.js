/*
 * HTTP 服务 —— 把 store + materialize + i18n 串成一个能看的页面和一组接口
 *
 * 启动：
 *   node --disable-warning=ExperimentalWarning src/server/index.js
 *   node src/server/index.js --port 8787 --db data/gs.db
 *   （或 npm run server）
 *
 * 为什么不用 Fastify（README 里那句旧计划）：
 *   本项目有条硬约束 —— 运行时依赖只有 lodash，`test/arch.mjs` 里直接断言
 *   `dependencies === ['lodash']`。而这里要的东西很薄（几个 JSON 接口 + 三个静态文件），
 *   node:http 完全够用。为了省一张路由表就把「零依赖」这条线破掉，不划算。
 *
 * 分层：这一层只做「HTTP ⇄ 视图对象」的翻译，不碰 SQL、不碰评分算法。
 *   路由 → repo（读库）/ enka（抓数）→ view/shape（成型 + 本地化）→ JSON。
 */
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { i18n } from '../index.js'
import { openDb } from '../store/db.js'
import * as repo from '../store/repo.js'
import { fetchEnka } from '../adapter/enka.js'
import { ingestPayload } from '../adapter/ingest.js'
import { buildAccountView } from '../view/shape.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PUBLIC = path.join(HERE, 'public')

/* 静态文件白名单。不做通用静态服务 —— 三个文件而已，白名单顺手把目录穿越问题也解决了。 */
const STATIC = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/index.html': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/style.css': ['style.css', 'text/css; charset=utf-8']
}

const ASSETS_DIR = path.join(PUBLIC, 'assets')

const MIME_TYPES = {
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

const BODY_LIMIT = 64 * 1024

/* ---------------- HTTP 小工具 ---------------- */

function sendJson (res, status, obj) {
  const body = JSON.stringify(obj)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store'
  })
  res.end(body)
}

/* 失败一律走这个形状：{ ok:false, error:{ code, message } } */
function sendError (res, status, code, message) {
  sendJson(res, status, { ok: false, error: { code, message } })
}

function readBody (req) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (c) => {
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

/* ---------------- 应用 ---------------- */

/**
 * 组装一个服务实例（不开监听），方便测试直接拿来做内存请求。
 * @param {object} opts
 * @param {string} opts.dbFile   SQLite 文件，默认 data/gs.db
 * @param {Function} opts.fetchImpl  允许替换 enka 抓取（测试用）
 */
export function createApp ({ dbFile = path.join('data', 'gs.db'), fetchImpl = fetchEnka } = {}) {
  const db = openDb(dbFile)
  /* 同一个 uid 同时来两次抓取请求时，共用一个 promise，别把 enka 打两遍 */
  const inflight = new Map()

  /* 库里的行 → 视图对象。locale 认不出会退回默认语言（i18n.resolveLocale 负责）。*/
  function viewOf (uid, locale) {
    const { account, avatars: rows } = repo.loadUid(db, uid)
    if (!rows.length && !account) return null
    return buildAccountView({
      account,
      rows,
      locale,
      fetchedAt: repo.lastFetch(db, uid)?.fetched_at || null
    })
  }

  async function handleFetch (uid) {
    if (inflight.has(uid)) return inflight.get(uid)
    const task = (async () => {
      const payload = await fetchImpl(uid)
      const summary = ingestPayload(payload, { source: 'enka' })
      repo.saveFetch(db, { ...summary, stamp: new Date().toISOString() })
      return summary
    })()
    inflight.set(uid, task)
    try {
      return await task
    } finally {
      inflight.delete(uid)
    }
  }

  async function route (req, res, url) {
    const { pathname } = url

    /* ---- 静态图片资源 ---- */
    if (req.method === 'GET' && pathname.startsWith('/assets/')) {
      /* 只认白名单里的扩展名，拒绝目录穿越 */
      const ext = path.extname(pathname).toLowerCase()
      if (!MIME_TYPES[ext]) {
        sendError(res, 404, 'asset_type', `不支持的资源类型：${ext}`)
        return
      }
      const rel = decodeURIComponent(pathname.slice('/assets/'.length))
      const filePath = path.resolve(path.join(ASSETS_DIR, rel))
      const root = path.resolve(ASSETS_DIR)
      if (!filePath.startsWith(root + path.sep) && filePath !== root) {
        sendError(res, 403, 'asset_escape', '路径不合法')
        return
      }
      if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
        sendError(res, 404, 'asset_missing', '资源不存在')
        return
      }
      const buf = fs.readFileSync(filePath)
      res.writeHead(200, {
        'Content-Type': MIME_TYPES[ext],
        'Content-Length': buf.length,
        'Cache-Control': 'public, max-age=86400'
      })
      res.end(buf)
      return
    }

    /* ---- 静态页 ---- */
    if (req.method === 'GET' && STATIC[pathname]) {
      const [file, mime] = STATIC[pathname]
      const buf = fs.readFileSync(path.join(PUBLIC, file))
      res.writeHead(200, { 'Content-Type': mime, 'Content-Length': buf.length, 'Cache-Control': 'no-cache' })
      res.end(buf)
      return
    }

    /* ---- 元信息：有哪些语言、表在不在 ---- */
    if (req.method === 'GET' && pathname === '/api/meta') {
      sendJson(res, 200, {
        ok: true,
        data: {
          locales: i18n.locales(),
          defaultLocale: i18n.DEFAULT_LOCALE,
          /* 表还没同步时为 false —— 页面据此提示「只有中文」 */
          i18nReady: i18n.available(),
          /* 界面文字也一并返回：切语言不用再问后端一次。
             归一化过一遍，'zh-cn' 这种写法也能落到 chs。 */
          ui: i18n.uiTable(i18n.resolveLocale(url.searchParams.get('locale')))
        }
      })
      return
    }

    if (req.method === 'GET' && pathname === '/api/health') {
      sendJson(res, 200, { ok: true, data: { uids: repo.listUids(db).length } })
      return
    }

    /* ---- 库里有哪些 uid ---- */
    if (req.method === 'GET' && pathname === '/api/uids') {
      const list = repo.listUids(db).map(uid => {
        const acc = repo.getAccount(db, uid)
        const last = repo.lastFetch(db, uid)
        return {
          uid,
          nickname: acc?.nickname ?? null,
          level: acc?.level ?? null,
          worldLevel: acc?.world_level ?? null,
          avatarCount: repo.listAvatarIds(db, uid).length,
          fetchedAt: last?.fetched_at ?? null
        }
      })
      sendJson(res, 200, { ok: true, data: list })
      return
    }

    /* ---- 一个 uid 的完整视图 ---- */
    const mUid = pathname.match(/^\/api\/uid\/(\d+)$/)
    if (req.method === 'GET' && mUid) {
      const uid = Number(mUid[1])
      const locale = url.searchParams.get('locale') || i18n.DEFAULT_LOCALE
      const view = viewOf(uid, locale)
      if (!view) {
        sendError(res, 404, 'no_data', `库里没有 uid ${uid}。先抓一次：POST /api/fetch {"uid":${uid}}`)
        return
      }
      sendJson(res, 200, { ok: true, data: view })
      return
    }

    /* ---- 抓数据（会联网打 enka）---- */
    if (req.method === 'POST' && pathname === '/api/fetch') {
      let body
      try { body = await readBody(req) } catch (e) { sendError(res, 400, 'bad_body', e.message); return }
      const uid = Number(body.uid)
      if (!Number.isInteger(uid) || uid <= 0) {
        sendError(res, 400, 'bad_uid', '请求体里要有一个正整数 uid')
        return
      }
      const locale = body.locale || url.searchParams.get('locale') || i18n.DEFAULT_LOCALE
      try {
        const summary = await handleFetch(uid)
        const view = viewOf(uid, locale)
        sendJson(res, 200, {
          ok: true,
          data: view,
          meta: { fetched: summary.avatarCount, source: summary.source }
        })
      } catch (e) {
        /* enka 的业务错误（未公开 / 查不到 / 太频繁）在 message 里已经是人话了，
           对浏览器来说这类都是「上游没给数据」，用 502 表达「网关上游失败」最贴切。*/
        sendError(res, 502, 'fetch_failed', e.message)
      }
      return
    }

    sendError(res, 404, 'not_found', `没有这个接口：${req.method} ${pathname}`)
  }

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost')
    route(req, res, url).catch((e) => {
      sendError(res, 500, 'internal', e.message)
    })
  })

  return { server, db, viewOf, close: () => server.close() }
}

/** 起监听。默认只绑本机 —— 这是个人工具，不该顺手暴露到局域网。 */
export function startServer ({ port = 8787, host = '127.0.0.1', dbFile, fetchImpl } = {}) {
  const app = createApp({ dbFile, fetchImpl })
  return new Promise((resolve) => {
    /* port 传 0 = 让系统随便挑一个空闲端口，测试里就这么用 */
    app.server.listen(port, host, () => {
      const actual = app.server.address().port
      resolve({ ...app, port: actual, url: `http://${host}:${actual}` })
    })
  })
}

/* ---------------- 命令行入口 ---------------- */

function parseArgs (argv) {
  const out = {}
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) continue
    const key = argv[i].slice(2)
    const next = argv[i + 1]
    if (next === undefined || next.startsWith('--')) out[key] = true
    else { out[key] = next; i++ }
  }
  return out
}

/* 只有被当成脚本跑时才起服务；被 import 时（测试）什么都不做 */
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = parseArgs(process.argv.slice(2))
  const port = Number(args.port || process.env.PORT || 8787)
  const host = args.host || '127.0.0.1'
  const dbFile = args.db || path.join('data', 'gs.db')
  const app = await startServer({ port, host, dbFile })
  console.log(`星天水镜 · 服务已启动  ${app.url}`)
  console.log(`  库文件  ${dbFile}`)
  if (!i18n.available()) {
    console.log('  提示    多语言表还没同步（只有中文）。跑一次：I18N_PROXY=socks5h://127.0.0.1:4080 python tools/sync_i18n.py')
  } else {
    console.log(`  语言    ${i18n.locales().map(l => l.code).join(', ')}`)
  }
  console.log('  Ctrl+C 停止')
}

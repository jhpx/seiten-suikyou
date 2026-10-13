/*
 * HTTP 服务 —— 把 store + materialize + i18n 串成一个能看的页面和一组接口
 *
 * 为什么用 node:http 手写而不引框架：`test/arch.ts` 锁死了「运行时依赖只有 lodash」，而这里要的东西
 * 很薄（几个 JSON 接口 + 几个静态文件），不值得为省一张路由表把那条线破掉。
 * 分层：这一层只做「HTTP ⇄ 视图对象」的翻译，不碰 SQL、不碰评分算法。
 */
import http from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import type { NetworkInterfaceInfo } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { i18n } from '../index.ts'
import { openDb } from '../store/db.ts'
import * as repo from '../store/repo.ts'
import { fetchEnka } from '../adapter/enka.ts'
import type { FetchEnkaOpts } from '../adapter/enka.ts'
import { ingestPayload } from '../adapter/ingest.ts'
import type { IngestResult } from '../adapter/ingest.ts'
import { buildAccountView, fmtTime, weightFilterOptions } from '../view/shape.ts'
import { createRateGate } from './rate-limit.ts'
import type { RateRules } from './rate-limit.ts'
import { argValue, parseArgs } from '../shared/util.ts'
import type { EnkaPayload } from '../domain/enka.ts'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PUBLIC = path.join(HERE, 'public')
const ASSETS_DIR = path.join(PUBLIC, 'assets')
const ASSETS_ROOT = path.resolve(ASSETS_DIR)

/* 静态页白名单。不做通用静态服务 —— 几个文件而已，白名单顺手把目录穿越也解决了。 */
const STATIC: Record<string, string> = {
  '/': 'index.html',
  '/index.html': 'index.html',
  '/app.js': 'app.js',
  '/style.css': 'style.css',
  '/miao.css': 'miao.css'      /* 评分卡样式（miao 结果图移植版），和外壳样式分开管 */
}

const MIME_TYPES: Record<string, string> = {
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

/* ---------------- 小工具 ---------------- */

/** 额外的响应头（按需） */
type Headers = Record<string, string>

/* catch 到的一律是 unknown（TS 从 4.4 起）—— 取人话消息统一走这里 */
const errMessage = (e: unknown): string => (e instanceof Error ? e.message : String(e))

function sendJson (res: ServerResponse, status: number, obj: unknown, headers?: Headers): void {
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
function sendError (res: ServerResponse, status: number, code: string, message: string, headers?: Headers): void {
  sendJson(res, status, { ok: false, error: { code, message } }, headers)
}

function sendFile (res: ServerResponse, file: string, { cache = 'no-cache' }: { cache?: string } = {}): void {
  const buf = fs.readFileSync(file)
  res.writeHead(200, {
    'Content-Type': MIME_TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream',
    'Content-Length': buf.length,
    'Cache-Control': cache
  })
  res.end(buf)
}

/* 请求体 JSON —— 形状由各接口自己认（这里只保证「是个对象」）。空体回 {}，坏 JSON 抛错。 */
function readBody (req: IncomingMessage): Promise<Record<string, unknown>> {
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

/* 图片素材：扩展名白名单 + 目录穿越防护 */
function serveAsset (res: ServerResponse, pathname: string): void {
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

/* ---------------- 应用 ---------------- */

/** createApp / startServer 的选项（后三个都能直接透传，加选项不用改两处签名） */
export interface AppOptions {
  /** SQLite 文件，默认 data/gs.db */
  dbFile?: string
  /** 允许替换 enka 抓取（测试用） */
  fetchImpl?: (uid: number | string, opts?: FetchEnkaOpts) => Promise<unknown>
  /** 认不认转发头（挂在反向代理后面时开），默认 false */
  trustProxy?: boolean
  /** 覆盖限流档位（{ fetch:{limit,windowMs}, … }）；传 false = 不限流 */
  rateLimit?: Partial<RateRules> | false
}

/** 组装一个服务实例（不开监听），方便测试直接拿来做内存请求 */
export function createApp ({
  dbFile = path.join('data', 'gs.db'),
  fetchImpl = fetchEnka,
  trustProxy = false,
  rateLimit
}: AppOptions = {}) {
  const db = openDb(dbFile)
  /* 同一个 uid 同时来两次抓取请求时共用一个 promise，别把 enka 打两遍 */
  const inflight = new Map<number, Promise<IngestResult>>()
  /* 限流闸门。rateLimit 传 false 就没有闸门（本地调试用），后面判一下 null 即可 */
  const gate = createRateGate({ trustProxy, rules: rateLimit })

  /* 库里的数据 → 视图对象。locale 认不出会退回默认语言（i18n.resolveLocale 负责）。 */
  function viewOf (uid: number, locale: string) {
    const account = repo.loadAccountWithCharacters(db, uid)
    if (!account) return null
    return buildAccountView({ account, locale, fetchedAt: repo.lastFetch(db, uid)?.fetched_at || null })
  }

  function handleFetch (uid: number): Promise<IngestResult> {
    let p = inflight.get(uid)
    if (!p) {
      p = (async () => {
        const payload = await fetchImpl(uid)
        /* 抓回来的就是 enka 原始响应；形状由 ingestPayload 校验（缺 playerInfo 会抛） */
        const summary = ingestPayload(payload as EnkaPayload, { source: 'enka' })
        repo.saveFetch(db, { ...summary, stamp: new Date().toISOString() })
        return summary
      })().finally(() => inflight.delete(uid))
      inflight.set(uid, p)
    }
    return p
  }

  async function route (req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const { pathname } = url
    const isGet = req.method === 'GET'

    /* 限流卡在所有业务之前 —— 坏请求也得占配额，否则刷 400 比刷 200 还省 */
    if (gate) {
      const wait = gate.check(req, pathname)
      if (wait) {
        return sendError(res, 429, 'rate_limited', '请求太频繁了，过一会儿再试',
          { 'Retry-After': String(wait) })
      }
    }

    if (isGet && pathname.startsWith('/assets/')) return serveAsset(res, pathname)
    if (isGet && STATIC[pathname]) return sendFile(res, path.join(PUBLIC, STATIC[pathname]))

    /* ---- 元信息：有哪些语言、表在不在 ---- */
    if (isGet && pathname === '/api/meta') {
      const loc = i18n.resolveLocale(url.searchParams.get('locale'))
      sendJson(res, 200, {
        ok: true,
        data: {
          locales: i18n.locales(),
          defaultLocale: i18n.DEFAULT_LOCALE,
          /* 表还没同步时为 false —— 页面据此提示「只有中文」 */
          i18nReady: i18n.available(),
          /* 界面文字也一并返回（切语言不用再问后端一次）；归一化过一遍，'zh-cn' 也能落到 chs */
          ui: i18n.uiTable(loc),
          /* 首页「按属性权重筛选」的四个选项名，跟着语言一起给 —— 前端不写死词条名 */
          weightOptions: weightFilterOptions(loc)
        }
      })
      return
    }

    if (isGet && pathname === '/api/health') {
      sendJson(res, 200, { ok: true, data: { uids: repo.listUids(db).length } })
      return
    }

    /* ---- 库里有哪些 uid ---- */
    if (isGet && pathname === '/api/uids') {
      const list = repo.listUids(db).map(uid => {
        const acc = repo.loadAccount(db, uid)
        return {
          uid,
          nickname: acc?.nickname ?? null,
          level: acc?.level ?? null,
          worldLevel: acc?.worldLevel ?? null,
          avatarCount: repo.listCharacterIds(db, uid).length,
          fetchedAt: fmtTime(repo.lastFetch(db, uid)?.fetched_at)   /* ISO UTC → 本地时区文本 */
        }
      })
      sendJson(res, 200, { ok: true, data: list })
      return
    }

    /* ---- 一个 uid 的完整视图 ---- */
    const mUid = isGet && pathname.match(/^\/api\/uid\/(\d+)$/)
    if (mUid) {
      const uid = Number(mUid[1])
      const view = viewOf(uid, url.searchParams.get('locale') || i18n.DEFAULT_LOCALE)
      if (!view) {
        sendError(res, 404, 'no_data', `库里没有 uid ${uid}。先抓一次：POST /api/fetch {"uid":${uid}}`)
        return
      }
      sendJson(res, 200, { ok: true, data: view })
      return
    }

    /* ---- 抓数据（会联网打 enka）---- */
    if (req.method === 'POST' && pathname === '/api/fetch') {
      /* 客户端给的体：只有 uid / locale 两个字段，都在这里当场认形状 */
      let body: Record<string, unknown>
      try { body = await readBody(req) } catch (e) { sendError(res, 400, 'bad_body', errMessage(e)); return }
      const uid = Number(body.uid)
      if (!Number.isInteger(uid) || uid <= 0) {
        sendError(res, 400, 'bad_uid', '请求体里要有一个正整数 uid')
        return
      }
      const locale = (typeof body.locale === 'string' ? body.locale : null) ||
        url.searchParams.get('locale') || i18n.DEFAULT_LOCALE
      try {
        const summary = await handleFetch(uid)
        sendJson(res, 200, {
          ok: true,
          data: viewOf(uid, locale),
          meta: { fetched: summary.characterCount, source: summary.source }
        })
      } catch (e) {
        /* enka 的业务错误（未公开 / 查不到 / 太频繁）在 message 里已经是人话了，
           对浏览器来说这类都是「上游没给数据」，用 502 表达「网关上游失败」最贴切。 */
        sendError(res, 502, 'fetch_failed', errMessage(e))
      }
      return
    }

    sendError(res, 404, 'not_found', `没有这个接口：${req.method} ${pathname}`)
  }

  const server = http.createServer((req: IncomingMessage, res: ServerResponse) => {
    route(req, res, new URL(req.url || '/', 'http://localhost')).catch((e: unknown) => {
      sendError(res, 500, 'internal', errMessage(e))
    })
  })

  return { server, db, viewOf, rules: gate?.rules ?? null, close: () => server.close() }
}

/**
 * 起监听。其余选项原样转给 createApp。
 *
 * host 默认**回环**而不是 0.0.0.0：调用方有两类 —— 一类是已经想清楚要暴露到哪的（文件末尾的 CLI
 * 入口，显式传 0.0.0.0），另一类是测试和脚本，后者不传 host 时不该在不知情的情况下开一个局域网端口
 * （测试的内存库里有真实 UID 数据）。对外服务是正式入口的显式决定，不是库的默认。
 */
export function startServer ({ port = 8787, host = '127.0.0.1', ...appOpts }: { port?: number; host?: string } & AppOptions = {}): Promise<ReturnType<typeof createApp> & { port: number; url: string }> {
  const app = createApp(appOpts)
  return new Promise((resolve) => {
    /* port 传 0 = 让系统随便挑一个空闲端口，测试里就这么用 */
    app.server.listen(port, host, () => {
      const addr = app.server.address()
      const actual = addr && typeof addr === 'object' ? addr.port : port
      resolve({ ...app, port: actual, url: `http://${host}:${actual}` })
    })
  })
}

/* ---------------- 命令行入口 ---------------- */

/* 只有被当成脚本跑时才起服务；被 import 时（测试）什么都不做 */
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = parseArgs(process.argv.slice(2))
  /* 正式入口默认对外（局域网服务）。要只给本机用就 --host 127.0.0.1。 */
  const host = argValue(args.host) || '0.0.0.0'
  const dbFile = argValue(args.db) || path.join('data', 'gs.db')
  /* 挂在反向代理后面（Cloudflare Tunnel、nginx）时必须开：那种拓扑下 TCP 对端永远是代理自己
     （走 Tunnel 时全是 127.0.0.1），不认转发头的话限流会把所有访客当成一个人。 */
  const trustProxy = args['trust-proxy'] === true || process.env.TRUST_PROXY === '1'
  /* 本地调试想完全不管限流就加 --no-rate-limit */
  const noLimit = args['no-rate-limit'] === true || process.env.NO_RATE_LIMIT === '1'

  const app = await startServer({
    port: Number(args.port || process.env.PORT || 8787),
    host, dbFile, trustProxy,
    rateLimit: noLimit ? false : undefined
  })

  /* 绑 0.0.0.0（默认）时把各网卡地址列出来 —— 手机要访问得知道往哪打。
     虚拟机网卡（VMware / WSL）也在里面，扫一眼就能认出哪个是 Wi-Fi 的。 */
  const lanIps = host === '0.0.0.0'
    ? [...new Set(Object.values(os.networkInterfaces()).flat()
        .filter((i): i is NetworkInterfaceInfo => !!i && i.family === 'IPv4' && !i.internal)
        .map(i => i.address))]
    : []

  console.log(lanIps.length
    ? `星天水镜 · 服务已启动  监听 ${host}:${app.port}（局域网可达）`
    : `星天水镜 · 服务已启动  ${app.url}`)
  if (lanIps.length) {
    console.log('  局域网地址（手机连同一个 Wi-Fi 就能打开）')
    for (const ip of lanIps) console.log(`    http://${ip}:${app.port}`)
    console.log('  注意    同网段任何人可访问（本服务无登录鉴权）；只给本机用就 --host 127.0.0.1')
  }
  console.log(`  库文件  ${dbFile}`)
  console.log(app.rules
    ? `  限流    抓取 ${app.rules.fetch.limit} 次/分（每 IP）· 全局 ${app.rules.fetchAll.limit} 次/分 · 读 ${app.rules.read.limit} 次/分`
    : '  限流    已关闭（--no-rate-limit）')
  console.log(`  客户端  ${trustProxy
    ? '按转发头认（CF-Connecting-IP / X-Forwarded-For）'
    : '按 TCP 对端地址认（挂代理后面要加 --trust-proxy，否则限流形同虚设）'}`)
  if (!i18n.available()) {
    console.log('  提示    多语言表还没同步（只有中文）。跑一次：I18N_PROXY=socks5h://127.0.0.1:4080 python tools/sync_i18n.py')
  } else {
    console.log(`  语言    ${i18n.locales().map(l => l.code).join(', ')}`)
  }
  console.log('  Ctrl+C 停止')
}

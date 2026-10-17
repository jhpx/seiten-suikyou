/*
 * HTTP 服务 —— 把 store + materialize + i18n 串成一个能看的页面和一组接口
 *
 * 为什么用 node:http 手写而不引框架：`test/arch.ts` 锁死了「运行时依赖只有 lodash」，而这里要的东西
 * 很薄（几个 JSON 接口 + 几个静态文件），不值得为省一张路由表把那条线破掉。
 * 分层：本文件只做**装配** —— 起服务、限流、按前缀分派；具体接口在 api/，
 * 静态托管在 static.ts，跨域在 cors.ts，响应原语在 http.ts。接口层只管「算数据 + 回响应」。
 */
import http from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'
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
import { buildAccountView } from '../view/shape.ts'
import { createRateGate } from './rate-limit.ts'
import type { RateRules } from './rate-limit.ts'
import { argValue, parseArgs } from '../shared/util.ts'
import type { EnkaPayload } from '../domain/enka.ts'
import { errMessage, sendError, sendFile } from './http.ts'
import { applyCors } from './cors.ts'
import { PUBLIC, serveAsset, servePublic } from './static.ts'
import { matchRoute } from './api/index.ts'
import type { ApiContext } from './api/context.ts'

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
  /** 跨域白名单（来访的 Origin 一字不差地对上才给 CORS 头）；留空 = 不开跨域（默认）。
      前端单独托管（GitHub Pages 之类）+ 后端另放一台机器时才需要，见 docs/DEPLOY.md。 */
  corsOrigins?: string[]
}

/** 组装一个服务实例（不开监听），方便测试直接拿来做内存请求 */
export function createApp ({
  dbFile = path.join('data', 'gs.db'),
  fetchImpl = fetchEnka,
  trustProxy = false,
  rateLimit,
  corsOrigins = []
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

  /* 接口层只拿这三样：库、视图、抓取。跨域 / 限流 / 静态托管都留在这层的外面。 */
  const ctx: ApiContext = { db, viewOf, handleFetch }

  async function route (req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const { pathname } = url
    const isGet = req.method === 'GET'

    /* ---- 跨域：预检就地回完，业务响应挂上许可头（没配白名单时等于什么都没有）。
       必须排在限流前面，原因写在 cors.ts。 ---- */
    if (applyCors(req, res, corsOrigins)) return

    /* ---- 静态：素材、首页、public/ 下其余文件 ---- */
    if (isGet && pathname.startsWith('/assets/')) return serveAsset(res, pathname)
    if (isGet && (pathname === '/' || pathname === '/index.html')) return sendFile(res, path.join(PUBLIC, 'index.html'))
    /* 前端拆成多个 ES 模块后，写死白名单会 404，所以通用托管整个 public 目录。
       但 /api/* 是接口，绝不能让静态分支抢走（否则 /api/health 等 GET 接口会被当文件 404）。 */
    if (isGet && !pathname.startsWith('/api/')) return servePublic(res, pathname)

    /* ---- 接口：先匹配路由，再按那条路由标的档位过闸门，最后跑 handler ----
       顺序为什么是这样：限流档位写在路由表里（它是接口的属性），所以得先知道命中谁。
       但闸门仍然卡在 handler 前面 —— 坏请求只要命中了路由就照样占配额，
       否则拿着 /refresh 刷 400 比刷 200 还省。 */
    const hit = matchRoute(req.method, pathname)
    if (!hit) return sendError(res, 404, 'not_found', `没有这个接口：${req.method} ${pathname}`)

    if (gate && hit.limit !== 'none') {
      const wait = gate.check(req, hit.limit)
      if (wait) {
        return sendError(res, 429, 'rate_limited', '请求太频繁了，过一会儿再试',
          { 'Retry-After': String(wait) })
      }
    }

    await hit.handler(ctx, req, res, url, hit.params)
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
  /* 跨域白名单：只有「前端单独托管 + 后端另放一台机器」才用得上。
     逗号分隔，如 --cors-origin https://xxx.github.io 或 CORS_ORIGIN=https://a.com,https://b.com。
     留空 = 不开（默认；本地运行就是这样）。 */
  const corsOrigins = (argValue(args['cors-origin']) || process.env.CORS_ORIGIN || '')
    .split(',').map(s => s.trim()).filter(Boolean)

  const app = await startServer({
    port: Number(args.port || process.env.PORT || 8787),
    host, dbFile, trustProxy, corsOrigins,
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
  console.log(`  跨域    ${corsOrigins.length
    ? corsOrigins.join(' ')
    : '关闭（本地运行不需要；前端单独托管时要加 --cors-origin <前端地址>）'}`)
  if (!i18n.available()) {
    console.log('  提示    多语言表还没同步（只有中文）。跑一次：I18N_PROXY=socks5h://127.0.0.1:4080 python tools/sync_i18n.py')
  } else {
    console.log(`  语言    ${i18n.locales().map(l => l.code).join(', ')}`)
  }
  console.log('  Ctrl+C 停止')
}

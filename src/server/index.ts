/*
 * HTTP 服务装配 —— 起服务、挂中间件、分派到路由，外加命令行入口。**只装配，不写业务**。
 *
 * `server/` 和 `cli/` 是一对：两个进程入口，一个对外（HTTP），一个对内（命令行）。
 * 装配之外的东西都不该长在这里 —— 接口实现去 rest/，用例去 service/。
 *
 * 目录速查：
 *   server/      装配（createApp / startServer / CLI 入口）+ URL 表（routes）+ 限流
 *   rest/        控制器：一个资源一个文件（account / character，.rest.ts 后缀）+ meta.ts / reply.ts 系统与共用件
 *   service/     用例编排 + 视图组装：account / character（.service.ts，领域三层对照）+ context.ts 契约
 *   domain/      领域模型：Account / Character / Weapon / Artifact
 *   config/      存储基建：constants（全局默认值）+ schema / db / store（表定义、连接、聚合读写）
 *   repository/  一张表一行：account.repo.ts / character.repo.ts
 *   upstream/    对外部数据源：抓取（enka）+ 原始响应翻译成实体（enka-account）
 *   kernel/      对 miao 评分内核：materialize（实体 → profile）、damage（伤害出口）
 *   common/      i18n（多语言门面）、names（官方文案表）、ui（界面文案）、util
 *
 * 装配顺序：cors 必须在限流前（预检不占配额），静态托管必须在路由后
 * （能命中接口的路径先被路由回掉，剩下的才当文件找）。
 */
import os from 'node:os'
import type { NetworkInterfaceInfo } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { serve } from '@hono/node-server'
import { serveStatic } from '@hono/node-server/serve-static'
import type { MiddlewareHandler } from 'hono'

import { i18n } from '../index.ts'
import { openDb } from '../config/db.ts'
import { accountView, countAccounts, createIngestService, listAccounts } from '../service/account.service.ts'
import type { FetchImpl } from '../service/account.service.ts'
import { characterDamage, characterSim, simCatalogOf, weightFilterOptions } from '../service/character.service.ts'
import { argValue, errMessage, parseArgs } from '../common/util.ts'
import { DEFAULT_DB_FILE, DEFAULT_HOST, DEFAULT_PORT, LOCAL_HOST } from '../config/constants.ts'
import { clientIp, createRateGate } from './rate-limit.ts'
import type { RateRules } from './rate-limit.ts'
import { mountRoutes } from './routes.ts'
import { fail } from '../rest/reply.ts'
import type { ApiContext } from '../service/context.ts'

const HERE = path.dirname(fileURLToPath(import.meta.url))

/** 前端静态目录（index.html / *.js / *.css / assets/）—— 即 web/ 子模块的检出 */
export const PUBLIC = path.resolve(HERE, '../../web')

/* ---------------- 应用 ---------------- */

/** createApp / startServer 的选项（后三个直接透传，加选项不用改两处签名） */
export interface AppOptions {
  /** SQLite 文件，默认 data/gs.db */
  dbFile?: string
  /** 允许替换 enka 抓取（测试用） */
  fetchImpl?: FetchImpl
  /** 认不认转发头（挂在反向代理后面时开），默认 false */
  trustProxy?: boolean
  /** 覆盖限流档位（{ fetch:{limit,windowMs}, … }）；传 false = 不限流 */
  rateLimit?: Partial<RateRules> | false
  /** 跨域白名单（来访的 Origin 一字不差地对上才给 CORS 头）；留空 = 不开跨域（默认）。
      写 `'*'` = 任何来源都放行（先跑通用的，正式上线建议对准具体域名）。
      前端单独托管（GitHub Pages 之类）+ 后端另放一台机器时才需要，见 docs/DEPLOY.md。 */
  corsOrigins?: string[]
}

/** 组装一个服务实例（不开监听），方便测试直接拿来做内存请求 */
export function createApp ({
  dbFile = path.join('data', 'gs.db'),
  fetchImpl,
  trustProxy = false,
  rateLimit,
  corsOrigins = []
}: AppOptions = {}) {
  const db = openDb(dbFile)
  /* 限流闸门。rateLimit 传 false 就没有闸门（本地调试用），guard 也就变成空中间件 */
  const gate = createRateGate({ rules: rateLimit })
  const ingest = createIngestService({ db, fetchImpl })

  /* 控制器要的能力集 —— 实现都在 service 层，这里只是接起来 */
  const ctx: ApiContext = {
    meta: { weightOptions: weightFilterOptions },
    accounts: {
      list: () => listAccounts(db),
      count: () => countAccounts(db),
      view: (uid, locale) => accountView(db, uid, locale)
    },
    characters: {
      damage: (uid, avatarId) => characterDamage(db, uid, avatarId),
      simCatalog: (uid, avatarId, locale) => simCatalogOf(db, uid, avatarId, locale),
      simulate: (uid, avatarId, req, locale) => characterSim(db, uid, avatarId, req, locale)
    },
    ingest: ingest.fetch
  }

  const app = new Hono()

  /* 跨域必须排在限流前面：浏览器发带自定义头的跨域请求时会先探一发 OPTIONS，
     这里不回 204 真正的请求根本发不出去；预检也不该占限流配额。
     没配白名单就压根不挂这个中间件 —— 少一层，也不给任何许可头。

     白名单里写 `*` 是「谁都行」：这里必须转成字符串 `'*'` 再交给 hono。
     因为 hono 收到**数组**时只做字面量比对（`includes(origin)`），`['*']` 对任何真实
     Origin 都匹配不上，等于没开跨域 —— 这个坑实测过，别改回去。 */
  if (corsOrigins.length) {
    const anyOrigin = corsOrigins.includes('*')
    app.use('*', cors({
      origin: anyOrigin ? '*' : corsOrigins,
      allowMethods: ['GET', 'POST', 'OPTIONS'],
      maxAge: 86400
    }))
  }

  /* 每条路由自己挂限流档位；闸门关掉时 guard 是空中间件，调用点不用分支 */
  const guard = (tier: 'read' | 'fetch'): MiddlewareHandler => async (c, next) => {
    if (!gate) return next()
    const wait = gate.check(clientIp(c, trustProxy), tier)
    if (!wait) return next()
    return fail(c, 429, 'rate_limited', '请求太频繁了，过一会儿再试', { 'Retry-After': String(wait) })
  }

  mountRoutes(app, ctx, guard)

  /* 同一个 web/ 目录既给本地服务、也给静态托管。这里把「部署用」的 env.js 覆盖成空配置：
     前端读到空值就回退同源 /api。静态托管（Pages）才是原样发仓库里那份带远端地址的。
     必须排在 serveStatic 前面，否则会被同名静态文件先抢走。 */
  app.get('/env.js', c => c.body("export const API_BASE = ''\n", 200, {
    'Content-Type': 'text/javascript; charset=utf-8',
    'Cache-Control': 'no-cache'
  }))

  /* 静态托管放在路由**之后**：能命中接口的路径已经被上面的路由回掉了，剩下的才当文件找。
     （顺序反过来会让 /api/xxx 有被同名文件抢走的风险。） */
  app.use('*', serveStatic({
    root: PUBLIC,
    rewriteRequestPath: p => (p === '/' ? '/index.html' : p),
    /* 素材缓存一天、页面每次现问 —— 页面改完刷新就能看到 */
    onFound: (file, c) => c.header('Cache-Control',
      file.startsWith(path.join(PUBLIC, 'assets')) ? 'public, max-age=86400' : 'no-cache')
  }))

  app.notFound(c => fail(c, 404, 'not_found', `没有这个接口：${c.req.method} ${c.req.path}`))
  app.onError((e, c) => fail(c, 500, 'internal', errMessage(e)))

  return { app, db, rules: gate?.rules ?? null }
}

/**
 * 起监听。其余选项原样转给 createApp。
 *
 * host 默认**回环**而不是对外：调用方有两类 —— 一类是已经想清楚要暴露到哪的（文件末尾的 CLI
 * 入口，显式传 DEFAULT_HOST），另一类是测试和脚本，后者不传 host 时不该在不知情的情况下
 * 开一个局域网端口。对外服务是正式入口的显式决定，不是库的默认。
 */
export function startServer ({ port = DEFAULT_PORT, host = LOCAL_HOST, ...appOpts }: { port?: number, host?: string } & AppOptions = {}) {
  const created = createApp(appOpts)
  return new Promise<typeof created & { server: ReturnType<typeof serve>, port: number, url: string }>((resolve) => {
    /* port 传 0 = 让系统随便挑一个空闲端口，测试里就这么用 */
    const server = serve({ fetch: created.app.fetch, port, hostname: host }, (info) => {
      resolve({ ...created, server, port: info.port, url: `http://${host}:${info.port}` })
    })
  })
}

/* ---------------- 命令行入口 ---------------- */

/* 只有被当成脚本跑时才起服务；被 import 时（测试）什么都不做 */
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = parseArgs(process.argv.slice(2))
  /* 正式入口默认对外（局域网服务）。要只给本机用就 --host 127.0.0.1。 */
  const host = argValue(args.host) || DEFAULT_HOST
  const dbFile = argValue(args.db) || DEFAULT_DB_FILE
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
    port: Number(args.port || process.env.PORT || DEFAULT_PORT),
    host, dbFile, trustProxy, corsOrigins,
    rateLimit: noLimit ? false : undefined
  })

  /* 绑 0.0.0.0（默认）时把各网卡地址列出来 —— 手机要访问得知道往哪打。
     虚拟机网卡（VMware / WSL）也在里面，扫一眼就能认出哪个是 Wi-Fi 的。 */
  const lanIps = host === DEFAULT_HOST
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
  console.log(`  跨域    ${!corsOrigins.length
    ? '关闭（本地运行不需要；前端单独托管时要加 --cors-origin <前端地址>）'
    : corsOrigins.includes('*')
      ? '*（任何来源都能读，先跑通用的）'
      : corsOrigins.join(' ')}`)
  if (!i18n.available()) {
    console.log('  提示    多语言表还没同步（只有中文）。跑一次：I18N_PROXY=socks5h://127.0.0.1:4080 python tools/sync_i18n.py')
  } else {
    console.log(`  语言    ${i18n.locales().map(l => l.code).join(', ')}`)
  }
  console.log('  Ctrl+C 停止')
}

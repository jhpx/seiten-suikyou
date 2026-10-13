/*
 * 在真实页面里跑一段 JS，把结果取回来 —— 量真实布局（元素尺寸、折行数、计算样式）。
 *
 * 为什么不数截图像素：截图里页头、账户卡、角色立绘自己就有大片白色/深色像素，
 * 按颜色扫边界会被它们骗。实测踩过两次 —— 把立绘的深色衣服当成页面背景色去分段、
 * 把角色的浅色头发当成评分文字去测对比度，两次都得出过错的结论。
 * DOM 直读没有这类歧义，而且能拿到「计算后的字号 / 行高 / 折行数」这种截图根本量不出的东西。
 *
 * 原理：拉一个带 --remote-debugging-port 的 chrome，用 CDP 的 Runtime.evaluate 丢表达式进去。
 * 不动产品代码（早期试过塞一个探针页进 public/，被服务端的静态白名单挡住了 —— 顺便说明
 * 服务端只认 STATIC 表里那几个文件，不是「public 目录随便读」）。
 *
 * 依赖与 tools/shot.mjs 同一个 chrome-headless-shell（准备方法见那个文件头部）。
 *
 * 用法：node tools/probe.mjs <url> <表达式文件>
 *   表达式文件里写一段 JS，求值结果最好是字符串（一般用 JSON.stringify(...) 包一层）。
 *   例：
 *     echo 'JSON.stringify([...document.querySelectorAll(".cc-weapon")].map(e => e.getBoundingClientRect().height))' > .tmp/e.js
 *     node tools/probe.mjs "http://127.0.0.1:8787/?uid=101242308&locale=en" .tmp/e.js
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SHELL = path.join(HERE, '..', '.tmp', 'chs', 'chrome-headless-shell-win64', 'chrome-headless-shell.exe')
const TARGET = process.argv[2]
const EXPR_FILE = process.argv[3]
const PORT = Number(process.env.PROBE_PORT || 9411)
const WAIT_MS = Number(process.env.PROBE_WAIT || 3500)   // 等页面把数据取回来再量
/* 视口尺寸。默认 1200×1400 —— 页面自适应用的是 `cqw` 和媒体查询，卡宽会跟着视口变，
   所以量「手机上会不会挤」必须能换视口，不能只在桌面宽度下量。
   例：PROBE_WIN=390,844 node tools/probe.mjs <url> <表达式> */
const WIN = process.env.PROBE_WIN || '1200,1400'

if (!TARGET || !EXPR_FILE) {
  console.error('用法：node tools/probe.mjs <url> <表达式文件>')
  process.exit(2)
}
if (!fs.existsSync(SHELL)) {
  console.error(`没找到 chrome-headless-shell：${SHELL}`)
  process.exit(2)
}
const EXPR = fs.readFileSync(EXPR_FILE, 'utf8')
const prof = fs.mkdtempSync(path.join(os.tmpdir(), 'chs-probe-'))

const child = spawn(SHELL, ['--disable-gpu', '--no-sandbox', '--hide-scrollbars',
  `--user-data-dir=${prof}`, `--remote-debugging-port=${PORT}`, `--window-size=${WIN}`,
  'about:blank'], { stdio: 'ignore' })

const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))

async function targetWs (): Promise<string> {
  for (let i = 0; i < 60; i++) {
    try {
      /* CDP 的 /json/list 返回的是一组调试目标（形状由 chrome 定，这里按我们读的字段断言） */
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json() as
        Array<{ type?: string; webSocketDebuggerUrl?: string }>
      const page = list.find(t => t.type === 'page')
      if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl
    } catch { /* 端口还没起来，接着等 */ }
    await sleep(200)
  }
  throw new Error(`调试端口 ${PORT} 一直没起来`)
}

let ws: WebSocket | undefined
try {
  ws = new WebSocket(await targetWs())
  /* 提成 const 给闭包用：`let` 的窄化不会带进回调 */
  const socket = ws
  await new Promise<void>((res, rej) => {
    socket.addEventListener('open', () => res(), { once: true })
    socket.addEventListener('error', (ev) => rej(ev), { once: true })
  })

  let seq = 0
  const waiting = new Map<number, (msg: any) => void>()
  socket.addEventListener('message', e => {
    const m = JSON.parse(e.data as string)
    const cb = waiting.get(m.id)
    if (cb) { waiting.delete(m.id); cb(m) }
  })
  const send = (method: string, params: Record<string, unknown> = {}): Promise<any> => new Promise(res => {
    const id = ++seq
    waiting.set(id, res)
    socket.send(JSON.stringify({ id, method, params }))
  })

  await send('Page.enable')
  await send('Page.navigate', { url: TARGET })
  await sleep(WAIT_MS)

  const out = await send('Runtime.evaluate', { expression: EXPR, returnByValue: true, awaitPromise: true })
  const val = out.result?.result?.value
  console.log(val === undefined ? JSON.stringify(out, null, 1) : val)
} finally {
  ws?.close()
  child.kill()
  /* 等 chrome 真退干净再删临时 profile：Windows 上进程没退完时 chrome_debug.log 还锁着，
     rmSync 会 EBUSY，把已经量到的结果一起吞掉（实测踩过）。删不掉就算了，本来就在系统临时目录里。 */
  await new Promise(r => { child.once('exit', r); setTimeout(r, 1500) })
  try { fs.rmSync(prof, { recursive: true, force: true }) } catch { /* 占着就留着 */ }
}

/*
 * 在真实页面里跑一段 JS，把结果取回来 —— 量真实布局（元素尺寸 / 折行数 / 计算样式）。
 *
 * 不数截图像素：页头、立绘、账户卡自身就有大片白/深色像素，按颜色扫边界会被它们骗。
 * DOM 直读没这歧义，还能拿到截图量不出的计算字号/行高。
 * 原理：拉一个带 --remote-debugging-port 的 chrome，用 CDP 的 Runtime.evaluate 丢表达式；不动产品代码。
 * chrome 用 .tmp/chs/chrome-headless-shell-win64/（准备方法见 tools/shot.ts 头部）。
 *
 * 用法：node tools/probe.ts <url> <表达式文件>   —— 表达式求值结果最好是字符串（用 JSON.stringify 包一层）
 *   echo 'JSON.stringify([...document.querySelectorAll(".cc-weapon")].map(e => e.getBoundingClientRect().height))' > .tmp/e.js
 *   node tools/probe.ts "http://127.0.0.1:8787/?uid=101242308&locale=en" .tmp/e.js
 *
 * 可选第 3 个参数 = 截图输出路径：表达式跑完（含里面的 await sleep）后接着截一张。
 * 「先点开面板再截图」这类要交互的场景用它，不用另起 shot.ts（那个不能带前置动作）：
 *   node tools/probe.ts <url> <表达式文件> .tmp/shot/x.png
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
/* 可选：表达式跑完后截一张图（交互探针点完按钮的现场就靠它留证） */
const SHOT_PNG = process.argv[4]
const PORT = Number(process.env.PROBE_PORT || 9411)
const WAIT_MS = Number(process.env.PROBE_WAIT || 3500)   // 等页面把数据取回来再量
/* 视口尺寸默认 1200×1400 —— 页面自适应用的是 `cqw` 和媒体查询，卡宽跟着视口变，
   所以量「手机上会不会挤」必须换视口。例：PROBE_WIN=390,844 node tools/probe.ts <url> <表达式> */
const WIN = process.env.PROBE_WIN || '1200,1400'

if (!TARGET || !EXPR_FILE) {
  console.error('用法：node tools/probe.ts <url> <表达式文件>')
  process.exit(2)
}
if (!fs.existsSync(SHELL)) {
  console.error(`没找到 chrome-headless-shell：${SHELL}`)
  process.exit(2)
}
const EXPR = fs.readFileSync(EXPR_FILE, 'utf8')
const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chs-probe-'))

const child = spawn(SHELL, ['--disable-gpu', '--no-sandbox', '--hide-scrollbars', '--no-proxy-server',
  `--user-data-dir=${profileDir}`, `--remote-debugging-port=${PORT}`, `--window-size=${WIN}`,
  'about:blank'], { stdio: 'ignore' })

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

async function targetWs (): Promise<string> {
  for (let i = 0; i < 60; i++) {
    try {
      /* CDP 的 /json/list 返回一组调试目标（形状由 chrome 定，这里按我们读的字段断言） */
      const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json() as
        Array<{ type?: string; webSocketDebuggerUrl?: string }>
      const page = targets.find(target => target.type === 'page')
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
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener('open', () => resolve(), { once: true })
    socket.addEventListener('error', (ev) => reject(ev), { once: true })
  })

  let seq = 0
  const waiting = new Map<number, (msg: any) => void>()
  socket.addEventListener('message', e => {
    const msg = JSON.parse(e.data as string)
    const callback = waiting.get(msg.id)
    if (callback) { waiting.delete(msg.id); callback(msg) }
  })
  const send = (method: string, params: Record<string, unknown> = {}): Promise<any> => new Promise(resolve => {
    const id = ++seq
    waiting.set(id, resolve)
    socket.send(JSON.stringify({ id, method, params }))
  })

  await send('Page.enable')
  await send('Page.navigate', { url: TARGET })
  await sleep(WAIT_MS)

  const out = await send('Runtime.evaluate', { expression: EXPR, returnByValue: true, awaitPromise: true })
  const value = out.result?.result?.value
  console.log(value === undefined ? JSON.stringify(out, null, 1) : value)
  if (SHOT_PNG) {
    const shot = await send('Page.captureScreenshot', { format: 'png' })
    if (shot.result?.data) {
      const png = Buffer.from(shot.result.data, 'base64')
      fs.mkdirSync(path.dirname(path.resolve(SHOT_PNG)), { recursive: true })
      fs.writeFileSync(SHOT_PNG, png)
      console.log('shot=', path.resolve(SHOT_PNG), png.length)
    } else {
      console.log('截图失败：', JSON.stringify(shot).slice(0, 200))
    }
  }
} finally {
  ws?.close()
  child.kill()
  /* 等 chrome 真退干净再删临时 profile：Windows 上进程没退完时 chrome_debug.log 还锁着，
     rmSync 会 EBUSY。删不掉就算了，本来就在系统临时目录里。 */
  await new Promise(resolve => { child.once('exit', resolve); setTimeout(resolve, 1500) })
  try { fs.rmSync(profileDir, { recursive: true, force: true }) } catch { /* 占着就留着 */ }
}

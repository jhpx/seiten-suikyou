/*
 * 用 chrome-headless-shell 给页面截图（改完样式用来对拍 miao 的结果图）。
 *
 * 为什么不用系统 Chrome：Chrome 132+ 把 old headless 拆成了独立二进制
 * （chrome-headless-shell），chrome.exe --headless 在有 GUI 实例运行时会直接
 * 退出（exit 21，日志里只有 ProcessSingleton，什么都不说）。这台机器的 Chrome
 * 已到 152，--headless=old 也没了，所以只能走 headless shell。
 *
 * 一次性准备（约 120MB，落在 .tmp/ 里，已被 gitignore）：
 *   curl -L --proxy socks5h://127.0.0.1:4080 \
 *     https://storage.googleapis.com/chrome-for-testing-public/152.0.7923.0/win64/chrome-headless-shell-win64.zip \
 *     -o .tmp/chs/chs.zip
 *   # 解压到 .tmp/chs/chrome-headless-shell-win64/
 *
 * 用法：node tools/shot.mjs <url> <输出png> [宽,高]
 * 例：  node tools/shot.mjs "http://127.0.0.1:8787/?uid=101242308&char=10000150" .tmp/shot/a.png 1400,1900
 */
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SHELL = path.join(HERE, '..', '.tmp', 'chs', 'chrome-headless-shell-win64', 'chrome-headless-shell.exe')

const url = process.argv[2]
const out = path.resolve(process.argv[3] || path.join(HERE, '..', '.tmp', 'shot', 'shot.png'))
const size = process.argv[4] || '760,2600'
const prof = fs.mkdtempSync(path.join(os.tmpdir(), 'chs-'))

if (!fs.existsSync(SHELL)) {
  console.error(`没找到 chrome-headless-shell：${SHELL}`)
  process.exit(2)
}
fs.mkdirSync(path.dirname(out), { recursive: true })

/* stdin 必须是 'ignore'，不能让它走默认的 pipe。
   2026-09-25 踩到：`spawnSync` 只写 { encoding, timeout } 时三个流都默认 pipe，
   于是每次调用**立刻**返回 `status=null` + `EBUSY`（libuv 报 EBUSY，对应 Windows 的
   共享冲突），连 chrome 都没起来，而脚本原来不打 r.error，只打 status，所以看着像
   「截图脚本坏了」而没有任何线索。同一时刻同一个 exe 用 Python 的 subprocess 调却是好的，
   probe.mjs 也一直是好的 —— 差别就在 probe 用的是 stdio:'ignore'。
   逐个试过：['ignore','pipe','pipe'] ✔ / [0,1,2] 继承 ✔ / ['ignore', f, f] 落文件 ✔ /
   三个都 pipe ✘。所以只有 stdin 那条管道是雷。
   stdout/stderr 保留管道：这脚本靠 stderr 报 chrome 的错（截图失败时是唯一线索）。 */
const r = spawnSync(SHELL, [
  '--disable-gpu',
  '--no-sandbox',
  '--disable-background-networking',
  '--hide-scrollbars',
  `--user-data-dir=${prof}`,
  `--window-size=${size}`,
  `--screenshot=${out}`,
  '--virtual-time-budget=8000',
  url
], { encoding: 'utf8', timeout: 60000, stdio: ['ignore', 'pipe', 'pipe'] })

console.log('status=', r.status)
if (r.error) console.log('error:', r.error.code, r.error.message)
if (r.stderr) console.log('stderr:', r.stderr.slice(0, 500))
console.log('out=', out, 'exists=', fs.existsSync(out), fs.existsSync(out) ? fs.statSync(out).size : '')
fs.rmSync(prof, { recursive: true, force: true })

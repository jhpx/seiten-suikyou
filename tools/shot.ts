/*
 * 用 chrome-headless-shell 给页面截图（改完样式用来对拍 miao 的结果图）。
 *
 * 不用系统 Chrome：Chrome 132+ 把 old headless 拆成了独立二进制，chrome.exe --headless 在有 GUI
 * 实例时直接退 21（日志只有 ProcessSingleton，什么都不说）；本机 Chrome 已 152，--headless=old 也没了。
 *
 * 一次性准备（~120MB，落在 .tmp/，已被 gitignore）：
 *   curl -L --proxy socks5h://127.0.0.1:4080 \
 *     https://storage.googleapis.com/chrome-for-testing-public/152.0.7923.0/win64/chrome-headless-shell-win64.zip \
 *     -o .tmp/chs/chs.zip
 *   # 解压到 .tmp/chs/chrome-headless-shell-win64/
 *
 * 用法：node tools/shot.ts <url> <输出png> [宽,高]
 * 例：  node tools/shot.ts "http://127.0.0.1:8787/?uid=101242308&char=10000150" .tmp/shot/a.png 1400,1900
 */
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SHELL = path.join(HERE, '..', '.tmp', 'chs', 'chrome-headless-shell-win64', 'chrome-headless-shell.exe')

const url = process.argv[2]
const outPng = path.resolve(process.argv[3] || path.join(HERE, '..', '.tmp', 'shot', 'shot.png'))
const size = process.argv[4] || '760,2600'
const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chs-'))

if (!fs.existsSync(SHELL)) {
  console.error(`没找到 chrome-headless-shell：${SHELL}`)
  process.exit(2)
}
fs.mkdirSync(path.dirname(outPng), { recursive: true })

/* stdin 必须 'ignore'：spawnSync 默认让三个流都走 pipe，而 stdin 那条管道在 Windows 上会让子进程
   **根本起不来**（立刻返回 status=null + error.code='EBUSY'，静默失败，看着像「截图脚本坏了」）。
   实测：继承 [0,1,2] ✔ / ['ignore',f,f] ✔ / ['ignore','pipe','pipe'] ✔ / 三个都 pipe ✘。
   stdout/stderr 留管道 —— chrome 的错只从 stderr 出，是截图失败时唯一的线索。 */
const result = spawnSync(SHELL, [
  '--disable-gpu',
  '--no-sandbox',
  '--disable-background-networking',
  '--hide-scrollbars',
  `--user-data-dir=${profileDir}`,
  `--window-size=${size}`,
  `--screenshot=${outPng}`,
  '--virtual-time-budget=8000',
  url
], { encoding: 'utf8', timeout: 60000, stdio: ['ignore', 'pipe', 'pipe'] })

console.log('status=', result.status)
if (result.error) console.log('error:', (result.error as NodeJS.ErrnoException).code, result.error.message)
if (result.stderr) console.log('stderr:', result.stderr.slice(0, 500))
console.log('out=', outPng, 'exists=', fs.existsSync(outPng), fs.existsSync(outPng) ? fs.statSync(outPng).size : '')
fs.rmSync(profileDir, { recursive: true, force: true })

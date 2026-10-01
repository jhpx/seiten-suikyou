/*
 * 列出页面真正会请求的图片素材 —— 现在只用来**对账**，不再用来决定下什么。
 *
 * 素材本身已经改成全量复制（sync_assets.py 直接从 miao-plugin/resources 拷），
 * 不再需要「先猜名字再按名字下载」，那些名字表对不上的漏图问题从根上没了。
 *
 * 但这个清单还有用：它**直接问应用本人** —— 用页面同一套 buildAccountView 跑一遍，
 * 把吐出来的图片 URL 收齐。sync_assets.py 复制完会拿它反查落盘，
 * 防的是另一类错：shape.js 拼了个源端没有的路径（改名、某个角色 miao 侧真没素材）。
 * 这类错全量复制解决不了，只能对账。
 *
 * 用法：npm run list:assets，然后 npm run sync:assets
 * 输出写到 .tmp/asset-list.json（相对 assets 根目录的路径，中文不编码）。
 */
import fs from 'node:fs'
import path from 'node:path'
import { openDb } from '../src/store/db.js'
import { loadUid } from '../src/store/repo.js'
import { buildAccountView } from '../src/view/shape.js'

const ROOT = path.resolve(import.meta.dirname, '..')
const dbPath = process.argv[2] || path.join(ROOT, 'data', 'gs.db')
const outFile = path.join(ROOT, '.tmp', 'asset-list.json')

/* `/assets/xxx/%E4%B8%AD.jpg` → `xxx/中.jpg` */
const urlToRel = (url) => {
  if (!url || !url.startsWith('/assets/')) return null
  return decodeURIComponent(url.slice('/assets/'.length))
}

const db = openDb(dbPath)
const uids = db.prepare('SELECT uid FROM account').all().map(r => r.uid)

const wanted = new Set()
for (const uid of uids) {
  const { avatars } = loadUid(db, uid)
  const view = buildAccountView({ account: null, rows: avatars, locale: 'chs' })
  for (const av of view.avatars) {
    wanted.add(urlToRel(av.splash))
    /* 首页角色网格用的正面大头照，和明细页的立绘是两张不同的图 */
    wanted.add(urlToRel(av.imgs?.face))
    for (const k of ['a', 'e', 'q', 'cons1', 'cons2', 'cons3', 'cons4', 'cons5', 'cons6']) {
      wanted.add(urlToRel(av.imgs?.[k]))
    }
    wanted.add(urlToRel(av.weapon?.icon))
    for (const a of av.artifacts) {
      if (!a.empty) wanted.add(urlToRel(a.icon))
    }
  }
}
wanted.delete(null)

const list = [...wanted].sort()
fs.mkdirSync(path.dirname(outFile), { recursive: true })
fs.writeFileSync(outFile, JSON.stringify(list, null, 0), 'utf-8')

console.log(`[list-assets] uid ${uids.length} 个 → 需要素材 ${list.length} 个`)
console.log(`[list-assets] 已写入 ${path.relative(ROOT, outFile)}`)

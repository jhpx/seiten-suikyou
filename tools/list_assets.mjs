/*
 * 列出页面真正会请求的图片素材，交给 sync_assets.py 去下载
 *
 * 为什么要有这一步：素材的目录名是**中文**（角色名 / 套装名 / 武器名），
 * 而库里存的是数字 id。之前 sync 脚本自己拿 id 去几张元数据表里反查名字，
 * 三张表各有各的缺口（官方文案表没收新角色、miao 的 idxs 里 id 还跟游戏对不上），
 * 结果总有零星图片漏下载，页面就出现空框。
 *
 * 这里换个思路：**直接问应用本人** —— 用页面同一套 buildAccountView 跑一遍，
 * 把它吐出来的图片 URL 收齐。这样「页面要什么」和「同步下什么」永远一致，
 * 不再依赖任何猜测。
 *
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

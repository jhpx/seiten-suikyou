/*
 * 列出页面真正会请求的图片素材 —— 只用来**对账**（不复用于决定下什么）。
 *
 * 素材已改成全量复制（sync_assets.py 直接拷 miao-plugin/resources）；这里拿页面同一套
 * buildAccountView 问应用本人要 URL，再反查落盘，防的是 shape.ts 拼出源端没有的路径。
 * 详情 → TOOLING-NOTES.md「图片素材」节。
 *
 * 用法：npm run list:assets，然后 npm run sync:assets（输出 .tmp/asset-list.json）
 */
import fs from 'node:fs'
import path from 'node:path'
import { openDb } from '../src/repository/db.ts'
import { listUids, loadAccountWithCharacters } from '../src/repository/index.ts'
import { buildAccountView } from '../src/service/view.ts'

const ROOT = path.resolve(import.meta.dirname, '..')
const dbPath = process.argv[2] || path.join(ROOT, 'data', 'gs.db')
const outFile = path.join(ROOT, '.tmp', 'asset-list.json')

/* `/assets/xxx/%E4%B8%AD.jpg` → `xxx/中.jpg` */
const urlToRel = (url: string | null | undefined): string | null => {
  if (!url || !url.startsWith('/assets/')) return null
  return decodeURIComponent(url.slice('/assets/'.length))
}

const db = openDb(dbPath)
const uids = listUids(db)

const wanted = new Set<string | null>()
for (const uid of uids) {
  const account = loadAccountWithCharacters(db, uid)
  if (!account) continue
  const view = buildAccountView({ account, locale: 'chs' })
  for (const avatar of view.avatars) {
    wanted.add(urlToRel(avatar.splash))
    /* 首页角色网格用的正面大头照，和明细页的立绘是两张不同的图 */
    wanted.add(urlToRel(avatar.imgs?.face))
    for (const slot of ['a', 'e', 'q', 'cons1', 'cons2', 'cons3', 'cons4', 'cons5', 'cons6']) {
      wanted.add(urlToRel(avatar.imgs?.[slot]))
    }
    wanted.add(urlToRel(avatar.weapon?.icon))
    for (const artifact of avatar.artifacts) {
      if (!artifact.empty) wanted.add(urlToRel(artifact.icon))
    }
  }
}
/* null = 「这一项本轮没拼出 URL」（没装备武器 / 空槽位），收尾统一滤掉再排序 */
const relPaths = [...wanted].filter((rel): rel is string => rel !== null).sort()
fs.mkdirSync(path.dirname(outFile), { recursive: true })
fs.writeFileSync(outFile, JSON.stringify(relPaths, null, 0), 'utf-8')

console.log(`[list-assets] uid ${uids.length} 个 → 需要素材 ${relPaths.length} 个`)
console.log(`[list-assets] 已写入 ${path.relative(ROOT, outFile)}`)

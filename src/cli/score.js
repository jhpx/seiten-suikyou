#!/usr/bin/env node
/*
 * 命令行评分入口 —— 第一版能跑通的端到端链路
 *
 * 用法：
 *   node src/cli/score.js --uid 101242308              抓 enka → 入库 → 打分
 *   node src/cli/score.js --uid 101242308 --offline    不联网，直接读库打分
 *   node src/cli/score.js --file sample.json           从本地原始响应入库（不联网）
 *   node src/cli/score.js --uid 101242308 --char 胡桃    只看一个角色
 *   node src/cli/score.js --uid 101242308 --check      顺手对拍游戏面板，验证没翻错
 *   node src/cli/score.js --list                       库里存了哪些 uid
 *   node src/cli/score.js --keys                       库里用到过哪些官方文案 key
 *   node src/cli/score.js --uid 101242308 --json        顺带吐出结构化结果
 *
 * 几个刻意的选择：
 *   - 打完分一定是从「库里读回来」再算，而不是拿刚落库的内存数据直接算。
 *     多走一趟数据库，才能证明存进去和读出来是同一个东西。
 *   - 原始响应可以另存一份（--save-raw），方便复现问题和以后换解析逻辑时回放。
 */
import fs from 'node:fs'
import path from 'node:path'

import { ArtisMark, Format, Character } from '../index.js'
import { openDb } from '../store/db.js'
import * as repo from '../store/repo.js'
import { ingestPayload } from '../adapter/ingest.js'
import { fetchEnka } from '../adapter/enka.js'
import { toMiaoProfile, deriveTalent } from '../adapter/materialize.js'
import { diffPanels, REL_TOL, ABS_TOL } from '../adapter/panel-check.js'

const POS_NAME = ['', '生之花', '死之羽', '时之沙', '空之杯', '理之冠']

/* ---------------- 参数 ---------------- */

function parseArgs (argv) {
  const out = { _: [] }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (!a.startsWith('--')) { out._.push(a); continue }
    const key = a.slice(2)
    const next = argv[i + 1]
    if (next === undefined || next.startsWith('--')) out[key] = true
    else { out[key] = next; i++ }
  }
  return out
}

const USAGE = `
星天水镜 · 命令行评分

  --uid <uid>        游戏 UID（会联网从 enka 取数据）
  --file <path>      改用本地的 enka 原始响应 JSON（不联网）
  --offline          不联网，直接拿库里已有的数据打分
  --char <名字|id>    只输出指定角色
  --check            拿游戏给的面板对拍，验证数据有没有翻错（需联网或 --file）
  --db <path>        库文件位置，默认 data/gs.db
  --save-raw <dir>   把原始响应另存一份到该目录
  --json             额外输出结构化结果（给以后的前端/接口用）
  --keys             列出库里用到过的官方文案 key（做多语言时照着要）
  --list             列出库里已有哪些 uid
  -h, --help         显示这段
`.trim()

/* ---------------- 输出小工具 ---------------- */

const padEnd = (s, n) => String(s + '').padEnd(n, ' ')
const padStart = (s, n) => String(s + '').padStart(n, ' ')
const line = (n = 60) => '─'.repeat(n)

/* 等宽对齐用的宽度：中文按两个字符算 */
function width (s) {
  let w = 0
  for (const ch of String(s)) w += /[\u3000-\u9fff\uff00-\uffef]/.test(ch) ? 2 : 1
  return w
}
function padW (s, n) {
  s = String(s)
  return s + ' '.repeat(Math.max(0, n - width(s)))
}

/* 面板属性：生命/攻击/防御是整数，其余是百分比 */
const PANEL_ROWS = [
  ['hp', '生命', 'int'], ['atk', '攻击', 'int'], ['def', '防御', 'int'],
  ['cpct', '暴击率', 'pct'], ['cdmg', '暴击伤害', 'pct'],
  ['mastery', '元素精通', 'int'], ['recharge', '元素充能', 'pct'],
  ['dmg', '元素伤害', 'pct'], ['phy', '物理伤害', 'pct'], ['heal', '治疗加成', 'pct']
]

function renderPanel (attr) {
  const parts = []
  for (const [key, label, kind] of PANEL_ROWS) {
    const v = attr?.[key]
    if (!v) continue
    parts.push(`${label} ${kind === 'int' ? Format.comma(v, 0) : Format.pct(v, 1)}`)
  }
  return parts.join('  ')
}

function renderCharacter (profile, result, keyTitle) {
  const char = profile.char
  const out = []
  const talent = deriveTalent(char, (profile._raw?.skill_level_map) || {})
  const talentStr = ['a', 'e', 'q'].filter(k => talent[k]).map(k => `${k.toUpperCase()}${talent[k]}`).join(' ')

  out.push(`${char.name} ★${char.star || 5} Lv.${profile.level ?? '?'} 命${profile.cons} 好感${profile.fetter ?? '?'} ${profile.elem || char.elem}${talentStr ? '  ' + talentStr : ''}`)
  out.push(`  武器  ${profile.weapon.name || '（未识别）'} Lv.${profile.weapon.level} 精${profile.weapon.affix}`)

  const setStr = Object.entries(result.sets || {}).map(([n, c]) => `${n}×${c}`).join(' ')
  out.push(`  套装  ${setStr || '（无）'}`)

  for (const idx of [1, 2, 3, 4, 5]) {
    const a = result.artis?.[idx]
    if (!a || !a.name) { out.push(`  ${idx} ${POS_NAME[idx]}  ——`); continue }
    out.push(`  ${idx} ${POS_NAME[idx]}  ${padW(a.name, 14)} ★${5} Lv.${padStart(a.level ?? 0, 2)}   ${padStart(a.mark, 6)}  ${a.markClass}`)
    if (a.main && a.main.value !== undefined) {
      out.push(`       主  ${keyTitle[a.main.key] || a.main.key} ${a.main.value}`)
    }
    const subs = (a.attrs || []).filter(x => x.key)
    if (subs.length) {
      out.push('       副  ' + subs.map(x =>
        `${keyTitle[x.key] || x.key} ${x.value}${x.upNum > 1 ? `×${x.upNum}` : ''}`
      ).join('  '))
    }
  }

  out.push(`  面板  ${renderPanel(profile.attr)}`)
  out.push(`  场景  ${result.classTitle}`)
  out.push(`  总分  ${result.mark}  ${result.markClass}`)
  return out.join('\n')
}

/* ---------------- 主流程 ---------------- */

async function main () {
  const args = parseArgs(process.argv.slice(2))
  if (args.help || args.h) { console.log(USAGE); return 0 }

  const dbFile = args.db || path.join('data', 'gs.db')
  const db = openDb(dbFile)

  if (args.list) {
    const uids = repo.listUids(db)
    if (!uids.length) { console.log(`库里还没有数据（${dbFile}）`); return 0 }
    console.log(`库里共 ${uids.length} 个 UID（${dbFile}）：`)
    for (const uid of uids) {
      const acc = repo.getAccount(db, uid)
      const last = repo.lastFetch(db, uid)
      const n = repo.listAvatarIds(db, uid).length
      console.log(`  ${uid}  ${acc?.nickname || '?'}  Lv.${acc?.level ?? '?'}  角色 ${n} 个  最后抓取 ${last?.fetched_at || '?'}`)
    }
    return 0
  }

  const uid = args.uid ? Number(args.uid) : null

  if (args.keys) {
    const { hash, avatars } = repo.listTextKeys(db)
    console.log(`库里用到的官方文案 key：${hash.length} 个`)
    console.log(hash.slice().sort((a, b) => a - b).join('\n'))
    console.log(`\n角色（enka 不给角色名 hash，这 ${avatars.length} 个得另外配 avatarId → 文案的映射）：`)
    console.log(avatars.join('\n'))
    return 0
  }

  if (!uid && !args.file) {
    console.error(USAGE)
    return 2
  }

  /* ---- 1. 取数据（可能联网） ---- */
  let ingestSummary = null
  let rawPayload = null      // 留着给 --check 用：对拍要拿原始响应里的 fightPropMap
  if (args.file) {
    const payload = JSON.parse(fs.readFileSync(args.file, 'utf8'))
    rawPayload = payload
    ingestSummary = ingestPayload(payload, { source: 'enka' })
    repo.saveFetch(db, { ...ingestSummary, stamp: new Date().toISOString() })
    if (args['save-raw']) {
      fs.mkdirSync(args['save-raw'], { recursive: true })
      const dest = path.join(args['save-raw'], `${ingestSummary.uid}.json`)
      fs.writeFileSync(dest, JSON.stringify(payload, null, 2))
    }
  } else if (!args.offline) {
    const payload = await fetchEnka(uid)
    rawPayload = payload
    ingestSummary = ingestPayload(payload, { source: 'enka' })
    repo.saveFetch(db, { ...ingestSummary, stamp: new Date().toISOString() })
    if (args['save-raw']) {
      fs.mkdirSync(args['save-raw'], { recursive: true })
      fs.writeFileSync(path.join(args['save-raw'], `${uid}.json`), JSON.stringify(payload, null, 2))
    }
  }

  const uidInDb = uid || ingestSummary?.uid
  if (!uidInDb) { console.error('没有可打分的 uid'); return 2 }

  /* ---- 2. 从库里读回来（这一步是刻意的：读回来才算真的证明存对了） ---- */
  const { account, avatars } = repo.loadUid(db, uidInDb)
  if (!avatars.length) {
    console.log(`库里没有 uid ${uidInDb} 的角色数据。`)
    if (!args.offline && !args.file) {
      console.log('可能原因：该玩家没在游戏资料页开启角色展柜，enka 取不到角色。')
    }
    return 1
  }

  const keyTitle = ArtisMark.getKeyTitleMap('gs')
  const last = repo.lastFetch(db, uidInDb)

  console.log(line())
  console.log(`账号  ${account?.nickname || '?'}（uid:${uidInDb}）  Lv.${account?.level ?? '?'}  世界等级 ${account?.world_level ?? '?'}`)
  const src = ingestSummary
    ? `${ingestSummary.source} 本次取得 ${ingestSummary.avatarCount} 个角色`
    : '库中数据（未联网）'
  console.log(`数据  ${src}　|　最新抓取 ${last?.fetched_at || '?'}　|　库里共 ${avatars.length} 个角色`)

  /* ---- 3. 打分 ---- */
  const filter = args.char ? String(args.char) : null
  const results = []
  const skipped = []
  for (const row of avatars) {
    const profile = toMiaoProfile(row)
    if (!profile) { skipped.push(row.avatar_id); continue }
    profile._raw = row
    const result = ArtisMark.getMarkDetail(profile, true)
    results.push({ row, profile, result })
  }
  if (skipped.length) {
    console.log(`提示  ${skipped.length} 个角色 miao 元数据里没有（id: ${skipped.join(', ')}），已跳过`)
  }

  const wanted = filter
    ? results.filter(r => r.profile.char.name === filter || String(r.profile.id) === filter)
    : results

  if (filter && !wanted.length) {
    console.error(`没找到角色「${filter}」。库里有：${results.map(r => r.profile.char.name).join('、')}`)
    return 1
  }

  /* ---- 4. 输出 ---- */
  for (const { profile, result } of wanted) {
    console.log(line())
    console.log(renderCharacter(profile, result, keyTitle))
  }

  console.log(line())
  const sorted = [...wanted].sort((a, b) => b.result._mark - a.result._mark)
  console.log(`汇总（按总分降序，共 ${sorted.length} 个角色）`)
  for (const { profile, result } of sorted) {
    console.log(`  ${padStart(result.mark, 6)}  ${padEnd(result.markClass, 4)} ${padEnd(profile.char.name, 10)} ${result.classTitle}`)
  }
  console.log(line())

  /* ---- 5. 面板对拍（只有拿到原始响应时才做得了） ---- */
  if (args.check) {
    if (!rawPayload) {
      console.log('面板对拍需要一个原始响应（联网抓，或者用 --file），离库打分做不了 —— 我们故意不把面板存进库。')
    } else {
      const byId = new Map(results.map(r => [r.profile.id, r.profile]))
      const cmp = diffPanels(rawPayload, byId)
      console.log(`\n面板对拍：游戏 fightPropMap（标准答案） vs miao 计算面板`)
      console.log(`容差 绝对值 ≤${ABS_TOL} 或 相对 ≤${(REL_TOL * 100).toFixed(1)}%`)
      for (const d of cmp.list) {
        const bad = d.rows.filter(r => !r.ok)
        console.log(`  ${d.ok ? '一致' : '不符'}  ${padW(d.name, 12)} ${String(d.rows.length).padStart(2)} 项  最大偏差 ${(d.worst.rel * 100).toFixed(4)}%（${d.worst.key}）`)
        for (const r of bad) {
          console.log(`        × ${r.key} 游戏 ${r.game.toFixed(4)} vs 我们 ${r.ours.toFixed(4)}（差 ${r.diff.toFixed(4)}）`)
        }
      }
      if (cmp.worst) {
        console.log(`  全局最大偏差 ${(cmp.worst.rel * 100).toFixed(4)}%（${cmp.worst.key}）→ ${cmp.ok ? '链路正常' : '有属性对不上，查 materialize'}`)
      }
      if (!cmp.ok) return 1
    }
  }

  if (args.json) {
    console.log(JSON.stringify(wanted.map(({ profile, result }) => ({
      uid: profile.uid,
      avatarId: profile.id,
      name: profile.char.name,
      mark: result._mark,
      markClass: result.markClass,
      classTitle: result.classTitle,
      sets: result.sets,
      charWeight: result.charWeight,
      artis: result.artis
    })), null, 2))
  }
  return 0
}

main().then(code => process.exit(code)).catch(e => {
  console.error(`[出错] ${e.message}`)
  process.exit(1)
})

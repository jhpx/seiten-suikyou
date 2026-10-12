#!/usr/bin/env node
/*
 * 命令行评分入口 —— 端到端链路：取数 → 入库 → 从库里读回来 → 打分 → 打印
 *
 * 用法：node src/cli/score.js --help
 */
import fs from 'node:fs'
import path from 'node:path'

import { ArtisMark, i18n } from '../index.js'
import { attrValueText, enkaNumsOf, fmtTime, panelText, rawNumsOf, slotLabel, statLabel, shapeCharacter } from '../view/shape.js'
import { openDb } from '../store/db.js'
import * as repo from '../store/repo.js'
import { ingestPayload } from '../adapter/ingest.js'
import { fetchEnka } from '../adapter/enka.js'
import { toMiaoProfile, deriveTalent } from '../adapter/materialize.js'
import { diffPanels, REL_TOL, ABS_TOL } from '../adapter/panel-check.js'

/* 界面文字 / 部位名 / 词条名都复用网页端那两张表，免得两处各写一套、加语言时漏改 */
const uiText = i18n.uiText

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
  --locale <code>    输出语言，默认 chs（chs/cht/en/ja/ko，或 zh-cn / zh-tw / jp / kr 这类别名）
  --json             额外输出结构化结果（给以后的前端/接口用）
  --keys             列出库里用到过的官方文案 key（做多语言时照着要）
  --list             列出库里已有哪些 uid
  -h, --help         显示这段
`.trim()

/* ---------------- 输出小工具 ---------------- */

const line = (n = 60) => '─'.repeat(n)
const pad = (s, n) => String(s ?? '').padStart(n, ' ')

/* 等宽对齐用的宽度：中文按两个字符算 */
function width (s) {
  let w = 0
  for (const ch of String(s)) w += /[\u3000-\u9fff\uff00-\uffef]/.test(ch) ? 2 : 1
  return w
}
const padW = (s, n) => {
  s = String(s)
  return s + ' '.repeat(Math.max(0, n - width(s)))
}

/* 名字一律从库行的 id/hash 查 i18n 表，不拿 miao 给的中文名反查（它只有中文，
   只能当查不到时的兜底）。用 hash 查还有个好处：miao 哪天改了译名也不影响我们。 */
const charName = (profile, locale) => i18n.avatarName(profile.id, locale) || profile.char.name

function renderCharacter (ch, profile, result, locale) {
  const char = profile.char
  const out = []
  const U = (key) => uiText(key, locale)
  const artifactsByPos = new Map((ch.artifacts || []).map(a => [a.pos, a]))

  const talent = deriveTalent(char, ch.skillLevelMap || {})
  const talentStr = ['a', 'e', 'q'].filter(k => talent[k]).map(k => `${k.toUpperCase()}${talent[k]}`).join(' ')
  const name = charName(profile, locale)
  /* 和网页一个口径（shape.js 的 weapon.state）：装备了但元数据不认识这把 → 「未知武器」，
     真没装备才是「无武器」。别再写成「（未识别）」—— 那是角色行的词，用在这里会让人
     以为角色没认出来。 */
  const wname = (ch.weapon.equipped ? i18n.weaponName(ch.weapon.itemId, locale) : null) ||
    profile.weapon.name || U(ch.weapon.equipped ? 'unknownWeapon' : 'noWeapon')

  out.push(`${name} ★${char.star || 5} Lv.${profile.level ?? '?'} ${U('cons')}${profile.cons} ${U('fetter')}${profile.fetter ?? '?'} ${profile.elem || char.elem}${talentStr ? '  ' + talentStr : ''}`)
  out.push(`  ${U('weapon')}  ${wname} Lv.${profile.weapon.level} ${U('refine')}${profile.weapon.affix}`)

  /* 套装名 miao 给的是官方中文全名，换语言得反查（i18n.fromZh） */
  const setStr = Object.entries(result.sets || {})
    .map(([n, c]) => `${i18n.fromZh(n, locale) || n}×${c}`).join(' ')
  out.push(`  ${U('sets')}  ${setStr || U('none')}`)

  for (const idx of [1, 2, 3, 4, 5]) {
    const a = result.artis?.[idx]
    if (!a || !a.name) { out.push(`  ${idx} ${slotLabel(idx, locale)}  ——`); continue }
    const art = artifactsByPos.get(idx)
    /* 显示数值优先用 enka 原始值、内核值兜底；见 shape.js 的 attrValueText / enkaNumsOf */
    const enka = enkaNumsOf(art)
    const { main: rawMain, sub: rawSub } = rawNumsOf(profile.artis?.artis?.[idx])
    const aname = (art?.nameHash && i18n.name(art.nameHash, locale)) || a.name
    out.push(`  ${idx} ${slotLabel(idx, locale)}  ${padW(aname, 14)} ★5 Lv.${pad(a.level ?? 0, 2)}   ${pad(a.mark, 6)}  ${a.markClass}`)
    if (a.main && a.main.value !== undefined) {
      out.push(`       ${U('mainStat')}  ${statLabel(a.main.key, locale)} ${attrValueText(a.main.key, a.main.value, rawMain, enka.main)}`)
    }
    const subs = (a.attrs || []).filter(x => x.key)
    if (subs.length) {
      out.push(`       ${U('substat')}  ` + subs.map(x =>
        `${statLabel(x.key, locale)} ${attrValueText(x.key, x.value, rawSub.get(x.key), enka.sub.get(x.key))}${x.upNum > 1 ? `×${x.upNum}` : ''}`
      ).join('  '))
    }
  }

  out.push(`  ${U('panelSection')}  ${panelText(profile.attr, locale)}`)
  out.push(`  ${U('scene')}  ${result.classTitle}`)
  out.push(`  ${U('total')}  ${result.mark}  ${result.markClass}`)
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
      const acc = repo.loadAccount(db, uid)
      const n = repo.listCharacterIds(db, uid).length
      console.log(`  ${uid}  ${acc?.nickname || '?'}  Lv.${acc?.level ?? '?'}  角色 ${n} 个  最后抓取 ${fmtTime(repo.lastFetch(db, uid)?.fetched_at) || '?'}`)
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

  /* ---- 1. 取数据：--file 读本地、--offline 跳过、否则联网 ---- */
  const payload = args.file
    ? JSON.parse(fs.readFileSync(args.file, 'utf8'))
    : (args.offline ? null : await fetchEnka(uid))

  let ingestSummary = null
  if (payload) {
    ingestSummary = ingestPayload(payload, { source: 'enka' })
    repo.saveFetch(db, { ...ingestSummary, stamp: new Date().toISOString() })
    /* 原始响应可以另存一份，方便复现问题和以后换解析逻辑时回放 */
    if (args['save-raw']) {
      fs.mkdirSync(args['save-raw'], { recursive: true })
      fs.writeFileSync(path.join(args['save-raw'], `${uid || ingestSummary.uid}.json`),
        JSON.stringify(payload, null, 2))
    }
  }

  const uidInDb = uid || ingestSummary?.player.uid
  if (!uidInDb) { console.error('没有可打分的 uid'); return 2 }

  /* ---- 2. 从库里读回来（刻意的：读回来才算证明存对了） ---- */
  const player = repo.loadPlayer(db, uidInDb)
  if (!player?.characters.length) {
    console.log(`库里没有 uid ${uidInDb} 的角色数据。`)
    if (!args.offline && !args.file) {
      console.log('可能原因：该玩家没在游戏资料页开启角色展柜，enka 取不到角色。')
    }
    return 1
  }

  /* 语言在这里归一一次，后面所有名字都按它渲染 */
  const locale = i18n.resolveLocale(args.locale || i18n.DEFAULT_LOCALE)

  console.log(line())
  console.log(`${uiText('account', locale)}  ${player?.nickname || '?'}（uid:${uidInDb}）  Lv.${player?.level ?? '?'}  ${uiText('worldLevel', locale)} ${player?.worldLevel ?? '?'}`)
  const src = ingestSummary
    ? `${ingestSummary.source} ${uiText('thisFetch', locale)} ${ingestSummary.avatarCount} ${uiText('chars', locale)}`
    : uiText('offline', locale)
  console.log(`${uiText('data', locale)}  ${src}　|　${uiText('fetched', locale)} ${fmtTime(repo.lastFetch(db, uidInDb)?.fetched_at) || '?'}　|　${player.characters.length} ${uiText('chars', locale)}`)

  /* ---- 3. 打分 ---- */
  const filter = args.char ? String(args.char) : null
  const results = []
  const skipped = []
  for (const ch of player.characters) {
    const profile = toMiaoProfile(ch)
    if (!profile) { skipped.push(ch.avatarId); continue }
    profile._raw = ch
    results.push({ ch, profile, result: ArtisMark.getMarkDetail(profile, true) })
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
  for (const { ch, profile, result } of wanted) {
    console.log(line())
    console.log(renderCharacter(ch, profile, result, locale))
  }

  console.log(line())
  const sorted = [...wanted].sort((a, b) => b.result._mark - a.result._mark)
  console.log(`${uiText('summary', locale)}（按总分降序，共 ${sorted.length} ${uiText('chars', locale)}）`)
  for (const r of sorted) {
    const cname = charName(r.profile, locale)
    console.log(`  ${pad(r.result.mark, 6)}  ${String(r.result.markClass).padEnd(4)} ${String(cname).padEnd(10)} ${r.result.classTitle}`)
  }
  console.log(line())

  /* ---- 5. 面板对拍（只有拿到原始响应时才做得了） ---- */
  if (args.check) {
    if (!payload) {
      console.log('面板对拍需要一个原始响应（联网抓，或者用 --file），离库打分做不了 —— 我们故意不把面板存进库。')
    } else {
      const byId = new Map(results.map(r => [r.profile.id, r.profile]))
      const cmp = diffPanels(payload, byId)
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

  /* --json 走的是和网页端同一个成型出口（view/shape），命令行看到的和接口拿到的是同一份形状。
     额外保留 charWeight（权重表）—— 那是调试规则时唯一想看的东西，视图里没有。 */
  if (args.json) {
    console.log(JSON.stringify(wanted.map(({ ch, profile, result }) => ({
      ...shapeCharacter(ch, profile, result, locale),
      charWeight: result.charWeight
    })), null, 2))
  }
  return 0
}

main().then(code => process.exit(code)).catch(e => {
  console.error(`[出错] ${e.message}`)
  process.exit(1)
})

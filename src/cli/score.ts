#!/usr/bin/env node
/*
 * 命令行评分入口 —— 端到端链路：取数 → 入库 → 从库里读回来 → 打分 → 打印
 *
 * 用法：node src/cli/score.ts --help
 */
import fs from 'node:fs'
import path from 'node:path'

import { ArtisMark, i18n } from '../index.ts'
import { attrValueText, enkaNumsOf, panelText, rawNumsOf, shapeCharacter, slotLabel, statLabel } from '../service/character.service.ts'
import type { MarkDetail } from '../service/character.service.ts'
import { fmtTime } from '../common/util.ts'
import { openDb } from '../config/db.ts'
import * as repo from '../config/store.ts'
import { ingestPayload } from '../upstream/enka-account.ts'
import type { IngestResult } from '../upstream/enka-account.ts'
import { fetchEnka } from '../upstream/enka.ts'
import { toMiaoProfile, deriveTalent } from '../kernel/materialize.ts'
import type { MiaoProfile } from '../kernel/materialize.ts'
import type { Character } from '../domain/character.ts'
import type { EnkaPayload } from '../domain/enka.ts'
import { argValue, parseArgs } from '../common/util.ts'
import { DEFAULT_DB_FILE } from '../config/constants.ts'

/* 界面文字 / 部位名 / 词条名复用网页端那两张表，免得两处各写一套、加语言时漏改 */
const uiText = i18n.uiText

const USAGE = `
星天水镜 · 命令行评分

  --uid <uid>        游戏 UID（会联网从 enka 取数据）
  --file <path>      改用本地的 enka 原始响应 JSON（不联网）
  --offline          不联网，直接拿库里已有的数据打分
  --char <名字|id>    只输出指定角色
  --db <path>        库文件位置，默认 data/gs.db
  --save-raw <dir>   把原始响应另存一份到该目录
  --locale <code>    输出语言，默认 chs（chs/cht/en/ja/ko，或 zh-cn / zh-tw / jp / kr 这类别名）
  --json             额外输出结构化结果（给以后的前端/接口用）
  --keys             列出库里用到过的官方文案 key（做多语言时照着要）
  --list             列出库里已有哪些 uid
  -h, --help         显示这段
`.trim()

/* ---------------- 输出小工具 ---------------- */

const line = (n: number = 60): string => '─'.repeat(n)
const pad = (value: unknown, cols: number): string => String(value ?? '').padStart(cols, ' ')

/* 等宽对齐用的宽度：中文按两个字符算 */
function width (value: unknown): number {
  let w = 0
  for (const ch of String(value)) w += /[\u3000-\u9fff\uff00-\uffef]/.test(ch) ? 2 : 1
  return w
}
const padW = (value: unknown, cols: number): string => {
  const text = String(value)
  return text + ' '.repeat(Math.max(0, cols - width(text)))
}

/* 名字一律从库行的 id/hash 查 i18n 表，不拿 miao 给的中文名反查（它只有中文，只能当兜底） */
const charName = (profile: MiaoProfile, locale: string): string =>
  i18n.avatarName(profile.id, locale) || profile.char.name

function renderCharacter (character: Character, profile: MiaoProfile, result: MarkDetail, locale: string): string {
  const char = profile.char
  const out: string[] = []
  const ui = (key: string): string => uiText(key, locale)
  const artifactByPos = new Map((character.artifacts || []).map(artifact => [artifact.pos, artifact] as const))

  const talent = deriveTalent(char, character.skillLevelMap || {})
  const talentStr = ['a', 'e', 'q'].filter(k => talent[k]).map(k => `${k.toUpperCase()}${talent[k]}`).join(' ')
  const name = charName(profile, locale)
  /* 与网页一个口径（view.ts 的 weapon.state）：装备了但元数据不认识 → 「未知武器」，
     真没装备才是「无武器」。别写成「（未识别）」—— 那是角色行的词，用在这里会被读成角色没认出来。 */
  const wname = (character.weapon.equipped ? i18n.weaponName(character.weapon.itemId, locale) : null) ||
    profile.weapon.name || ui(character.weapon.equipped ? 'unknownWeapon' : 'noWeapon')

  out.push(`${name} ★${char.star || 5} Lv.${profile.level ?? '?'} ${ui('cons')}${profile.cons} ${ui('fetter')}${profile.fetter ?? '?'} ${profile.elem || char.elem}${talentStr ? '  ' + talentStr : ''}`)
  out.push(`  ${ui('weapon')}  ${wname} Lv.${profile.weapon.level} ${ui('refine')}${profile.weapon.affix}`)

  /* 套装名 miao 给的是官方中文全名，换语言得反查（i18n.fromZh） */
  const setStr = Object.entries(result.sets || {})
    .map(([setName, count]) => `${i18n.fromZh(setName, locale) || setName}×${count}`).join(' ')
  out.push(`  ${ui('sets')}  ${setStr || ui('none')}`)

  for (const pos of [1, 2, 3, 4, 5]) {
    const entry = result.artis?.[pos]
    if (!entry || !entry.name) { out.push(`  ${pos} ${slotLabel(pos, locale)}  ——`); continue }
    const artifact = artifactByPos.get(pos)
    /* 显示数值优先用 enka 原始值、内核值兜底（见 view.ts 的 attrValueText / enkaNumsOf） */
    const enka = enkaNumsOf(artifact)
    const { main: rawMain, sub: rawSub } = rawNumsOf(profile.artis?.artis?.[pos])
    const aname = (artifact?.nameHash && i18n.name(artifact.nameHash, locale)) || entry.name
    out.push(`  ${pos} ${slotLabel(pos, locale)}  ${padW(aname, 14)} ★5 Lv.${pad(entry.level ?? 0, 2)}   ${pad(entry.mark, 6)}  ${entry.markClass}`)
    if (entry.main && entry.main.value !== undefined) {
      out.push(`       ${ui('mainStat')}  ${statLabel(entry.main.key, locale)} ${attrValueText(entry.main.key, entry.main.value, rawMain, enka.main)}`)
    }
    const subs = (entry.attrs || []).filter(sub => sub.key)
    if (subs.length) {
      out.push(`       ${ui('substat')}  ` + subs.map(sub =>
        `${statLabel(sub.key, locale)} ${attrValueText(sub.key, sub.value, rawSub.get(sub.key), enka.sub.get(sub.key))}${(sub.upNum ?? 0) > 1 ? `×${sub.upNum}` : ''}`
      ).join('  '))
    }
  }

  out.push(`  ${ui('panelSection')}  ${panelText(profile.attr, locale)}`)
  out.push(`  ${ui('scene')}  ${result.classTitle}`)
  out.push(`  ${ui('total')}  ${result.mark}  ${result.markClass}`)
  return out.join('\n')
}

/* ---------------- 主流程 ---------------- */

async function main () {
  const args = parseArgs(process.argv.slice(2))
  if (args.help || args.h) { console.log(USAGE); return 0 }

  const dbFile = argValue(args.db) || DEFAULT_DB_FILE
  const db = openDb(dbFile)

  if (args.list) {
    const uids = repo.listUids(db)
    if (!uids.length) { console.log(`库里还没有数据（${dbFile}）`); return 0 }
    console.log(`库里共 ${uids.length} 个 UID（${dbFile}）：`)
    for (const uid of uids) {
      const account = repo.loadAccount(db, uid)
      const charCount = repo.listCharacterIds(db, uid).length
      console.log(`  ${uid}  ${account?.nickname || '?'}  Lv.${account?.level ?? '?'}  角色 ${charCount} 个  最后抓取 ${fmtTime(repo.lastFetch(db, uid)?.fetchedAt) || '?'}`)
    }
    return 0
  }

  const uidArg = argValue(args.uid)
  const uid = uidArg ? Number(uidArg) : null

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
  const file = argValue(args.file)
  /* 上面已挡掉「既没 --uid 又没 --file」→ 走到非 file 分支时 uid 必非空 */
  const payload = (file
    ? JSON.parse(fs.readFileSync(file, 'utf8'))
    : (args.offline ? null : await fetchEnka(uid as number))) as EnkaPayload | null

  let ingestSummary: IngestResult | null = null
  if (payload) {
    ingestSummary = ingestPayload(payload, { source: 'enka' })
    repo.saveFetch(db, { ...ingestSummary, stamp: new Date().toISOString() })
    /* 原始响应可以另存一份，方便复现问题和以后换解析逻辑时回放 */
    const saveRaw = argValue(args['save-raw'])
    if (saveRaw) {
      fs.mkdirSync(saveRaw, { recursive: true })
      fs.writeFileSync(path.join(saveRaw, `${uid || ingestSummary.account.uid}.json`),
        JSON.stringify(payload, null, 2))
    }
  }

  const uidInDb = uid || ingestSummary?.account.uid
  if (!uidInDb) { console.error('没有可打分的 uid'); return 2 }

  /* ---- 2. 从库里读回来（刻意的：读回来才算证明存对了） ---- */
  const account = repo.loadAccountWithCharacters(db, uidInDb)
  if (!account?.characters.length) {
    console.log(`库里没有 uid ${uidInDb} 的角色数据。`)
    if (!args.offline && !args.file) {
      console.log('可能原因：该玩家没在游戏资料页开启角色展柜，enka 取不到角色。')
    }
    return 1
  }

  /* 语言在这里归一一次，后面所有名字都按它渲染 */
  const locale = i18n.resolveLocale(argValue(args.locale) || i18n.DEFAULT_LOCALE)

  console.log(line())
  console.log(`${uiText('account', locale)}  ${account?.nickname || '?'}（uid:${uidInDb}）  Lv.${account?.level ?? '?'}  ${uiText('worldLevel', locale)} ${account?.worldLevel ?? '?'}`)
  const sourceText = ingestSummary
    ? `${ingestSummary.source} ${uiText('thisFetch', locale)} ${ingestSummary.characterCount} ${uiText('chars', locale)}`
    : uiText('offline', locale)
  console.log(`${uiText('data', locale)}  ${sourceText}　|　${uiText('fetched', locale)} ${fmtTime(repo.lastFetch(db, uidInDb)?.fetchedAt) || '?'}　|　${account.characters.length} ${uiText('chars', locale)}`)

  /* ---- 3. 打分 ---- */
  const charFilter = argValue(args.char)
  const results: Array<{ character: Character; profile: MiaoProfile; result: MarkDetail }> = []
  const skipped: Array<number | null> = []
  for (const character of account.characters) {
    const profile = toMiaoProfile(character)
    if (!profile) { skipped.push(character.avatarId); continue }
    results.push({ character, profile, result: ArtisMark.getMarkDetail(profile, true) as MarkDetail })
  }
  if (skipped.length) {
    console.log(`提示  ${skipped.length} 个角色 miao 元数据里没有（id: ${skipped.join(', ')}），已跳过`)
  }

  const wanted = charFilter
    ? results.filter(entry => entry.profile.char.name === charFilter || String(entry.profile.id) === charFilter)
    : results

  if (charFilter && !wanted.length) {
    console.error(`没找到角色「${charFilter}」。库里有：${results.map(entry => entry.profile.char.name).join('、')}`)
    return 1
  }

  /* ---- 4. 输出 ---- */
  for (const { character, profile, result } of wanted) {
    console.log(line())
    console.log(renderCharacter(character, profile, result, locale))
  }

  console.log(line())
  const sorted = [...wanted].sort((a, b) => (b.result._mark ?? 0) - (a.result._mark ?? 0))
  console.log(`${uiText('summary', locale)}（按总分降序，共 ${sorted.length} ${uiText('chars', locale)}）`)
  for (const entry of sorted) {
    const cname = charName(entry.profile, locale)
    console.log(`  ${pad(entry.result.mark, 6)}  ${String(entry.result.markClass).padEnd(4)} ${String(cname).padEnd(10)} ${entry.result.classTitle}`)
  }
  console.log(line())

  /* ---- 5. --json ---- */
  /* --json 走的是和网页端同一个成型出口（service/character.service.ts），命令行看到的和接口拿到的是同一份形状。
     额外保留 charWeight（权重表）—— 那是调试规则时唯一想看的东西，视图里没有。 */
  if (args.json) {
    console.log(JSON.stringify(wanted.map(({ character, profile, result }) => ({
      ...shapeCharacter(character, profile, result, locale),
      charWeight: result.charWeight
    })), null, 2))
  }
  return 0
}

main().then(code => process.exit(code)).catch(e => {
  console.error(`[出错] ${e.message}`)
  process.exit(1)
})

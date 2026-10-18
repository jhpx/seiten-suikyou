/*
 * 管线测试 —— enka 原始响应 → 本地库 → miao profile → 分数
 *
 * 和另外几个测试的分工：
 *   regression / verify  管「miao 的分数算得对不对」（内核的事）
 *   pipeline（本文件）    管「我们自己写的 ingest / repo / materialize 有没有把数据搞坏」
 *
 * 所以这里不断言具体分数值，只断言：
 *   · 存进去和读出来是同一个东西（JSON 序列化别丢东西，尤其 appendPropIds 的重复次数）
 *   · 过不过数据库，算出来的分必须一样
 *   · 展柜只给一部分角色时，库里的其它角色不能被冲掉（这是 enka 数据源的常态）
 *   · 库里不许出现中文名（存储层存 id，名字是渲染时查的）
 */
import fs from 'node:fs'
import path from 'node:path'

import { ArtisMark, Meta, Character, ArtisMarkCfg } from '../src/index.ts'
import { openDb } from '../src/config/db.ts'
import * as repo from '../src/config/store.ts'
import { account as accountT, artifact as artifactT, character as characterT, weapon as weaponT } from '../src/config/schema.ts'
import { getTableConfig } from 'drizzle-orm/sqlite-core'
import type { SQLiteTable } from 'drizzle-orm/sqlite-core'
import { sql } from 'drizzle-orm'
import { ingestPayload } from '../src/upstream/enka-account.ts'
import { toMiaoProfile } from '../src/kernel/materialize.ts'
import type { MiaoProfile } from '../src/kernel/materialize.ts'
import { shapeCharacter } from '../src/service/character.service.ts'
import type { AttrRow, MarkDetail } from '../src/service/character.service.ts'
import { Artifact } from '../src/domain/artifact.ts'
import { Weapon } from '../src/domain/weapon.ts'
import { Account } from '../src/domain/account.ts'
/* 领域层的 Character 与 miao 的同名类不是一回事（见 domain/character.ts 的头注）——
   本文件两个都要用，所以把**我们的**那个按仓库惯例（materialize.ts 用 Miao* 前缀）
   反过来标成 Domain*，`Character` 依旧指 miao 的图鉴类。 */
import { Character as DomainCharacter } from '../src/domain/character.ts'
import type { EnkaEquip, EnkaPayload } from '../src/domain/enka.ts'
import { Stat, enkaPropKey, ENKA_PROP_TO_KEY } from '../src/domain/stat.ts'
import { diffPanels } from './panel-check.ts'

let failed = 0
let passed = 0
function ok (cond: unknown, label: string, extra = ''): void {
  console.log(`${cond ? '[PASS]' : '[FAIL]'} ${label}` + (cond || !extra ? '' : `\n        ${extra}`))
  cond ? passed++ : failed++
}
/* catch 到的变量在 TS 里是 `unknown`（4.4+）—— 取「人话消息」统一走这里。 */
const errMessage = (e: unknown): string => (e instanceof Error ? e.message : String(e))
/*
 * 本文件里 `!` 的用法：凡「刚写进库 / 刚造出来的夹具，必然取得到」的地方就地收窄。
 * 与 `as` 不同，`!` 是纯类型断言、运行时**一个字节都不变**（Node 剥类型时整段消失）——
 * 这正是本文件要的：测试的运行时行为与改 TS 之前逐字一致。
 * 真取不到就在原地炸（而不是让后面 20 条断言跟着一起假失败）。
 */

/* ---------------- 1. 元数据派生（不硬编码 id，免得上游一改就烂） ---------------- */

/* miao 的 arti 元数据（vendored JS，TS 只推得到 `any`）—— 这里声明我们真正读的两张表：
   键都是数字字符串 id，值是 miao 短 key（mainIdMap）/ 一条词条的档位（attrIdMap）。 */
const artiMeta = Meta.getMeta('gs', 'arti') as {
  mainIdMap: Record<string, string>
  attrIdMap: Record<string, { key: string; value: number }>
}

const mainIdOf = (key: string): number => {
  for (const [id, k] of Object.entries(artiMeta.mainIdMap)) if (k === key) return Number(id)
  throw new Error(`mainIdMap 里没有 ${key}`)
}
const rollIdsOf = (key: string, n = 1): number[] => {
  const ids = Object.entries(artiMeta.attrIdMap)
    .filter(([, v]) => v.key === key)
    .map(([id]) => Number(id))
  if (!ids.length) throw new Error(`attrIdMap 里没有 ${key}`)
  return Array.from({ length: n }, (_, i) => ids[i % ids.length])
}
/* 找一个 5★ 长柄武器 id（胡桃用长柄，虽然内核不看武器类型，但别制造假数据） */
function findWeaponId (): number | null {
  for (let id = 13501; id <= 13599; id++) {
    /* 第三参在 miao 里是「名字或 id」—— 它自己会 `txt + ''` 归一（Meta.js 的 getId），
       所以传串和传数字**运行时完全等价**；TS 从 JS 推出来的签名却写死了 string。 */
    const d = Meta.getData('gs', 'weapon', String(id))
    if (d && d.name && d.type === 'polearm' && d.star === 5) return id
  }
  return null
}

const weaponId = findWeaponId()
ok(!!weaponId, `能按数字 id 查到 5★ 长柄武器（id=${weaponId}）`)
/* 整份夹具都拿它当武器 itemId；查不到就没法往下走（上面那条已经把红报出来了）。 */
if (!weaponId) throw new Error('找不到 5★ 长柄武器 id，夹具造不出来')

/* ---------------- 2. 造一份「enka 形状」的原始响应 ---------------- */
/* 刻意用原始 prop id，属性值只给 enka 真会给的那两样：
   flat.reliquaryMainstat.statValue（主词条数值）与 flat.reliquarySubstats（合并后的副词条） */

/* miao key → enka 字符串 prop id（与 src/domain/stat.ts 一致，测试里独立写一份防实现走偏） */
const ENKA_PROP: Record<string, string> = {
  hp: 'FIGHT_PROP_HP_PERCENT', hpPlus: 'FIGHT_PROP_HP',
  atk: 'FIGHT_PROP_ATTACK_PERCENT', atkPlus: 'FIGHT_PROP_ATTACK',
  def: 'FIGHT_PROP_DEFENSE_PERCENT', defPlus: 'FIGHT_PROP_DEFENSE',
  mastery: 'FIGHT_PROP_ELEMENT_MASTERY', recharge: 'FIGHT_PROP_CHARGE_EFFICIENCY',
  cpct: 'FIGHT_PROP_CRITICAL', cdmg: 'FIGHT_PROP_CRITICAL_HURT', pyro: 'FIGHT_PROP_FIRE_ADD_HURT'
}
/* enka 会给的主词条数值（对齐真实数据里的档位，造得夸张点以便和内核值区分） */
const ENKA_MAIN_VALUE: Record<string, number> = { hpPlus: 4780, atkPlus: 311, mastery: 187, cpct: 46.6, pyro: 46.6, cdmg: 62.2 }

/* 数字 roll id → miao key（照 attrIdMap），用来把 fixture 的副词条按真实词条种类摊开 */
const keyOfAttrId = (id: number): string | null => artiMeta.attrIdMap[id]?.key || null

/*
 * 夹具的「一件装备」。**比 EnkaEquip 声明的多一个 `reliquaryMainstat.mainPropId`** ——
 * 真实响应里就是有（我们不读它，所以领域类型没声明），但夹具要照真形状写：
 * 哪天有人真去读它，不至于发现夹具是假的。用 extends 表达「EnkaEquip 的真子集形状」。
 */
interface FixtureEquip extends EnkaEquip {
  flat: {
    equipType: string
    rankLevel: number
    nameTextMapHash: number
    setNameTextMapHash: number
    reliquaryMainstat: { mainPropId: string; statValue: number }
    reliquarySubstats: Array<{ appendPropId: string; statValue: number }>
  }
  reliquary: { level: number; mainPropId: number; appendPropIdList: number[] }
}

const equip = (pos: number, mainKey: string, subs: number[]): FixtureEquip => {
  /* 副词条按 key 归拢后**合并成一条**（enka 的 flat.reliquarySubstats 就是合并过的：
     同一个词条出了多次 roll，值已经加总在一起）。这里每次 roll 记 20，同 key 出 n 次就是 20n，
     值取整十数以便与内核重算的带小数值区分（内核会算成 32.6 这种）。 */
  const byKey = new Map<string, number>()
  for (const id of subs) {
    const k = keyOfAttrId(id)
    if (k) byKey.set(k, (byKey.get(k) || 0) + 20)
  }
  return {
    itemId: [0, 80540, 80520, 80550, 80510, 80530][pos],  // 魔女套各部位部件 id
    flat: {
      equipType: ['', 'EQUIP_BRACER', 'EQUIP_NECKLACE', 'EQUIP_SHOES', 'EQUIP_RING', 'EQUIP_DRESS'][pos],
      rankLevel: 5,
      /* 官方文案 key。套装名 5 件共用同一个（真实数据就是这样），部件名各不相同 */
      nameTextMapHash: 1308846500 + pos,
      setNameTextMapHash: 1035953267,
      /* enka 的原始数值：主词条一条、副词条按 key 合并后的若干条 */
      reliquaryMainstat: { mainPropId: ENKA_PROP[mainKey], statValue: ENKA_MAIN_VALUE[mainKey] ?? 100 },
      reliquarySubstats: [...byKey].map(([k, v]) => ({ appendPropId: ENKA_PROP[k], statValue: v }))
    },
    reliquary: {
      level: 21,                       // enka 是 1 基，21 = 满级
      mainPropId: mainIdOf(mainKey),
      appendPropIdList: subs
    }
  }
}

const SUB = {
  cdmg: rollIdsOf('cdmg', 3),        // 同一个 id 连出 3 次 → 词条数应为 3
  cpct: rollIdsOf('cpct', 1),
  mastery: rollIdsOf('mastery', 2)
}

/* 整包响应用 EnkaPayload 标注：这份夹具就是「enka 会给什么」的样例，
   标注之后 `structuredClone` 出来的东西也是这个形状（下面几处分身改写才不会跑偏）。 */
const payload: EnkaPayload = {
  uid: '900000001',
  playerInfo: {
    nickname: '测试号', level: 60, worldLevel: 8, signature: 'hi',
    profilePicture: { avatarID: 209901 }, nameCardId: 210001
  },
  ttl: 60,
  avatarInfoList: [{
    avatarId: 10000046,                 // 胡桃
    propMap: { 4001: { val: '90' }, 1002: { val: '6' } },
    talentIdList: [1, 2, 3],
    fetterInfo: { expLevel: 10 },
    costumeId: 0,
    skillLevelMap: { 10461: 9, 10462: 9, 10463: 9 },
    equipList: [
      { itemId: weaponId, flat: { itemType: 'ITEM_WEAPON', rankLevel: 5, nameTextMapHash: 800766043 },
        weapon: { level: 90, promoteLevel: 6, affixMap: { [weaponId * 10]: 0 } } },
      equip(1, 'hpPlus', [...SUB.cdmg, ...SUB.cpct]),
      equip(2, 'atkPlus', [...SUB.cdmg, ...SUB.mastery]),
      equip(3, 'mastery', [...SUB.cpct, ...SUB.cdmg]),
      equip(4, 'pyro', [...SUB.cdmg, ...SUB.cpct, ...SUB.mastery]),
      equip(5, 'cpct', [...SUB.cdmg, ...SUB.cpct])
    ]
  }]
}

/* ---------------- 3. level 基数（enka 1 基 → 内核 0 基） ---------------- */

console.log('\n=== 1. level 基数：enka 1 基 → 内核 0 基 ===')
/* 库里存 enka 的原值（1 基，5★ 满级 21），组装 profile 时减 1 换成内核要的 0 基（满级 20）。
   这里断言的就是内核实际收到的那个数 —— profile.artis.artis[pos].level。
   ⚠️ 这一路 `?.artis?.artis?.['1']?.level` 全是 `any`（内核是 vendored JS），
   所以出口不做类型声明 —— 拿回来直接跟数字比。 */
const coreLevelOf = (enkaLevel: number) => {
  const one = structuredClone(payload)
  const only = equip(1, 'hpPlus', [])
  only.reliquary.level = enkaLevel
  one.avatarInfoList![0].equipList = [only]
  return toMiaoProfile(ingestPayload(one, { source: 'enka' }).account.characters[0])?.artis?.artis?.['1']?.level
}
ok(coreLevelOf(21) === 20, 'enka 的 21（满级）→ 内核 20', `实际 ${coreLevelOf(21)}`)
ok(coreLevelOf(13) === 12, 'enka 的 13 → 内核 12', `实际 ${coreLevelOf(13)}`)
ok(coreLevelOf(1) === 0, 'enka 的 1（0 级）→ 内核 0', `实际 ${coreLevelOf(1)}`)

/* ---------------- 3b. 初始词条条数 quality() ---------------- */

/* quality = 初始副词条条数 —— 5★ 下就靠它区分「初始三词条(3) / 初始四词条(4)」。
   为什么不能拿下面那份夹具来测：夹具是为**算分**造的，roll 条数与等级并不自洽
   （满级 21 却只给 4 条 roll），对它调 quality() 会得到负数。所以在这儿按真实档位单独造。 */
const fakeArtifact = (levelRaw: number, rollCount: number): Artifact => new Artifact({
  pos: 1, itemId: 80540, levelRaw, star: 5, mainPropId: mainIdOf('hpPlus'),
  appendPropIds: Array.from({ length: rollCount }, () => rollIdsOf('cdmg')[0]),
  mainStatValue: 4780, subStats: []
})

console.log('\n=== 1b. 初始词条条数 quality() ===')
ok(fakeArtifact(21, 8).quality() === 3, '满级 + 8 条 roll → 初始三词条',
  `实际 ${fakeArtifact(21, 8).quality()}`)
ok(fakeArtifact(21, 9).quality() === 4, '满级 + 9 条 roll → 初始四词条',
  `实际 ${fakeArtifact(21, 9).quality()}`)
ok(fakeArtifact(13, 6).quality() === 3, '12 级（升过 3 档）+ 6 条 roll → 初始三词条',
  `实际 ${fakeArtifact(13, 6).quality()}`)
ok(fakeArtifact(1, 4).quality() === 4, '0 级（未升过）+ 4 条 roll → 初始四词条',
  `实际 ${fakeArtifact(1, 4).quality()}`)
/* 这条是边界守卫：原始值 4 归一后是 3，3//4 = 0 档（对）；直接拿原始值 4 算，4//4 = 1 档（错，
   会得出 3-1=2）。所以 quality() 必须用归一化后的等级。 */
ok(fakeArtifact(4, 3).quality() === 3,
  '原始 4 → 归一 3（升过 0 档）：拿原始值直接整除 4 会错算成 2',
  `实际 ${fakeArtifact(4, 3).quality()}`)

/* ---------------- 4. ingest ---------------- */

console.log('\n=== 2. ingest：enka 响应 → 领域模型 ===')
const ingested = ingestPayload(payload, { source: 'enka' })
const directCharacter = ingested.account.characters[0]
/* 后面到处拿它查库。解析对不对由下面那条断言守着，这里只做「必然非空」的收窄。 */
const uid = ingested.account.uid!

ok(ingested.account.uid === 900000001, 'uid 解析正确')
ok(directCharacter.avatarId === 10000046, 'avatarId 解析正确')
ok(directCharacter.level === 90 && directCharacter.promote === 6, '等级 / 突破解析正确')
ok(directCharacter.cons === 3, '命座数 = talentIdList.length')
ok(directCharacter.weapon.itemId === weaponId, '武器按 itemId 存')
ok(directCharacter.weapon.affix === 1, '精炼等级：enka 的 0 → 精1')
ok(directCharacter.weapon.nameHash === 800766043, '武器名文案 key 带下来了（多语言靠它）',
  `实际 ${directCharacter.weapon.nameHash}`)
ok(directCharacter.artifacts.length === 5, '圣遗物 5 件')
ok(directCharacter.artifacts.map(a => a.pos).join(',') === '1,2,3,4,5', '位置按 1花2羽3沙4杯5头 映射')
ok(directCharacter.artifacts[0].levelRaw === 21, 'level 存原始值（不在这儿归一化）')
ok(directCharacter.artifacts.every(a => a.nameHash) && new Set(directCharacter.artifacts.map(a => a.nameHash)).size === 5,
  '5 件的部件名文案 key 各不相同')
ok(new Set(directCharacter.artifacts.map(a => a.setHash)).size === 1,
  '同一套的 5 件共用同一个套装名文案 key',
  `实际 ${JSON.stringify(directCharacter.artifacts.map(a => a.setHash))}`)
ok(directCharacter.artifacts[0].appendPropIds.length === 4, 'appendPropIds 条数正确')
/* 词条数是内核按 key 分组数出来的（ArtisAttr 里 tmp[key].upNum++），
   同一次 key 的多次 roll 可能是不同的 id（id 里编了数值档位），
   所以这里真正要守的是「原样保留每一次 roll，不许聚合、不许去重」 */
const cdmgRolls = directCharacter.artifacts[0].appendPropIds.filter(id => artiMeta.attrIdMap[id]?.key === 'cdmg')
ok(cdmgRolls.length === 3, '同 key 的多次 roll 一条不少（这是词条数的唯一来源）',
  `实际 ${JSON.stringify(directCharacter.artifacts[0].appendPropIds)}`)
const 中文字 = JSON.stringify(ingested.account.characters)
ok(!/[\u4e00-\u9fa5]/.test(中文字), '库行里没有中文名（存储层只存 id）',
  (中文字.match(/[\u4e00-\u9fa5]+/) || [])[0])

/* ---------------- 2b. 类型不变量 ---------------- */

console.log('\n=== 2b. 类型归一只在 constructor 做一次（之后字段类型固定）===')

/* 守的是「数据进对象时转一次」这条：脏值（字符串数字 / null / undefined）经 constructor
   之后，模型字段一律是 number|null —— 所以 ofEnka / 仓储映射 / 出口都不必再 num。
   把这些断言拆掉，就得在别处补一堆防御式 num，类型也就谈不上「固定」了。 */

/* ① 脏值直接进 constructor */
const dirtyArt = new Artifact({
  pos: '1', itemId: '91501', levelRaw: '21', star: '5', mainPropId: '14001',
  mainStatValue: '4780',
  subStats: [new Stat('FIGHT_PROP_HP_PERCENT', '46.6')],
  nameHash: '123', setHash: undefined
})
ok(dirtyArt.mainStatValue === 4780, '字符串主词条值 → number（constructor 归一）',
  `实际 ${JSON.stringify(dirtyArt.mainStatValue)}`)
ok(dirtyArt.levelRaw === 21 && dirtyArt.pos === 1, '字符串等级 / 位置 → number')
ok(dirtyArt.subStats[0].value === 46.6, 'Stat 的字符串值 → number')
ok(dirtyArt.setHash === null, '缺字段（undefined）→ null，不是 0 / NaN',
  `实际 ${JSON.stringify(dirtyArt.setHash)}`)

/* ② 被手工改过的库：JSON 列（TEXT）里塞字符串数值，读回来也得归一。
     注意别拿 main_stat_value 试 —— 它是 REAL 列，SQLite 的**类型亲和性**会自己把
     '4780' 转成数字，那样测的是 SQLite 不是我们。sub_stats 是 TEXT 列，里面的
     JSON 是原样文本，SQLite 不碰，才能真正验证 constructor 的归一。
     这里用裸 SQL 绕过 drizzle 的 json mode 直接写文本，模拟「有人手工改过库」。 */
const dirtyDb = openDb(':memory:')
repo.saveFetch(dirtyDb, { ...ingested, stamp: '2026-01-01T00:00:00.000Z' })
dirtyDb.run(sql`UPDATE artifact
  SET sub_stats = ${'[{"prop":"FIGHT_PROP_HP_PERCENT","value":"46.6"}]'}
  WHERE pos = 1`)
const dirtyBack = repo.loadCharacter(dirtyDb, uid, ingested.account.characters[0].avatarId!)!
const rowBack = dirtyBack.artifacts.find(a => a.pos === 1)!
ok(rowBack.subStats[0].value === 46.6,
  'JSON 列里的字符串数值 → number（读回来仍过同一个 constructor）',
  `实际 ${JSON.stringify(rowBack.subStats[0].value)}`)

/* ---------------- 5. 落库 + 读回 ---------------- */

console.log('\n=== 3. 落库 → 读回（JSON 序列化不丢东西）===')
const db = openDb(':memory:')
repo.saveFetch(db, { ...ingested, stamp: '2026-01-01T00:00:00.000Z' })

const back = repo.loadAccountWithCharacters(db, uid)!
ok(back.nickname === '测试号', '账号读回正确')
ok(back.characters.length === 1, '角色读回正确')

const viaDbCharacter = back.characters[0]
const directArtifact = directCharacter.artifacts[0]
const viaDbArtifact = viaDbCharacter.artifacts[0]
ok(JSON.stringify(viaDbArtifact.appendPropIds) === JSON.stringify(directArtifact.appendPropIds),
  'appendPropIds 读回逐字一致（含顺序与每一次 roll）',
  `写入 ${JSON.stringify(directArtifact.appendPropIds)}\n        读回 ${JSON.stringify(viaDbArtifact.appendPropIds)}`)
ok(viaDbArtifact.mainPropId === directArtifact.mainPropId && viaDbArtifact.itemId === directArtifact.itemId && viaDbArtifact.levelRaw === directArtifact.levelRaw,
  '主词条 id / 部件 id / level 读回一致')
ok(JSON.stringify(viaDbCharacter.skillLevelMap) === JSON.stringify(directCharacter.skillLevelMap), '天赋表读回一致')
ok(viaDbArtifact.nameHash === directArtifact.nameHash && viaDbArtifact.setHash === directArtifact.setHash,
  '文案 key 读回一致（没有它，多语言就得重新抓一遍 enka）')
ok(viaDbCharacter.weapon.nameHash === directCharacter.weapon.nameHash, '武器文案 key 读回一致')

/* ---------------- 6. 两条路算出的分必须一样 ---------------- */

console.log('\n=== 4. 过库 vs 不过库，分数必须一致 ===')
/* 内核打分的整包结果（ArtisMark.getMarkDetail）—— 形状在 service/character.service.ts 里声明过
   （MarkDetail），这里断言的就是那几个字段，所以直接拿来用。 */
const scoreOf = (row: DomainCharacter): MarkDetail | null => {
  const p = toMiaoProfile(row)
  return p ? ArtisMark.getMarkDetail(p, true) as MarkDetail : null
}
const viaDb = scoreOf(viaDbCharacter)
const direct = scoreOf(directCharacter)
ok(!!viaDb, '能算出分（角色被 miao 认识、圣遗物解析成功）')
ok(viaDb?.mark === direct?.mark, `过库得分 ${viaDb?.mark} == 直接得分 ${direct?.mark}`)
ok(viaDb?.classTitle === direct?.classTitle, `场景一致：${viaDb?.classTitle}`)
/* `artis` 在 MarkDetail 里是可选的（内核 withDetail=false 时整块没有）——
   这里传的是 true，所以它必然在；写成 `?.` 是照类型走，不是「可能没有」。 */
ok(viaDb?.artis?.['1']?.main?.key === 'hpPlus',
  '花的主词条是 hpPlus（小生命），标定 key 约定正确',
  `实际 ${viaDb?.artis?.['1']?.main?.key}`)
ok(viaDb?.artis?.['1']?.attrs?.[0]?.upNum === 3,
  '副词条词条数 = 同 key 的 roll 次数（3）',
  `实际 ${viaDb?.artis?.['1']?.attrs?.[0]?.upNum}`)
ok(viaDb?.artis?.['1']?.main?.value === '4,778.6',
  '满级小生命主词条 = 4,778.6（顺带验证 level 21→20 归一化对了；千分位对齐 miao 的结果图）',
  `实际 ${viaDb?.artis?.['1']?.main?.value}`)

/* ---------------- 7. 展柜子集：合并而不是替换 ---------------- */

console.log('\n=== 5. 展柜只给一部分角色时，不能冲掉已有的 ===')
const second = structuredClone(payload)
second.avatarInfoList = [{
  avatarId: 10000003,                   // 琴，假装这次展柜里换成了她
  propMap: { 4001: { val: '80' }, 1002: { val: '6' } },
  talentIdList: [],
  fetterInfo: { expLevel: 5 },
  skillLevelMap: { 10311: 6, 10312: 6, 10313: 6 },
  equipList: [
    { itemId: 11501, flat: { itemType: 'ITEM_WEAPON', rankLevel: 5 },
      weapon: { level: 90, promoteLevel: 6, affixMap: { 115010: 0 } } }
  ]
}]
repo.saveFetch(db, { ...ingestPayload(second, { source: 'enka' }), stamp: '2026-01-02T00:00:00.000Z' })
const merged = repo.listCharacterIds(db, uid)
ok(merged.length === 2, `两次抓取各拿 1 个角色 → 库里累计 2 个（实际 ${merged.length}）`,
  `实际 ${JSON.stringify(merged)}`)
ok(merged.includes(10000046), '第二次没抓到的胡桃仍在库里')
ok(repo.lastFetch(db, uid)?.fetchedAt === '2026-01-02T00:00:00.000Z', '抓取流水记到最后一次')

/* ---------------- 8. 重复抓取幂等 ---------------- */

console.log('\n=== 6. 同一份数据抓两次，结果不变 ===')
repo.saveFetch(db, { ...ingested, stamp: '2026-01-03T00:00:00.000Z' })
const again = scoreOf(repo.loadCharacter(db, uid, 10000046)!)
ok(again!.mark === viaDb!.mark, `重复抓取后分数不变（${again!.mark}）`)
ok(repo.listCharacterIds(db, uid).length === 2, '重复抓取不会新增重复行')

/* ---------------- 9. 脏数据不炸 ---------------- */

console.log('\n=== 7. 脏数据要能扛住 ===')
const dirty = structuredClone(payload)
dirty.avatarInfoList![0].equipList!.push({
  itemId: 999999, flat: { equipType: 'EQUIP_BRACER', rankLevel: 5 },
  reliquary: { level: 21, mainPropId: mainIdOf('hpPlus'), appendPropIdList: [] }
})
let dirtyScore = null
let dirtyThrew = false
try {
  dirtyScore = scoreOf(ingestPayload(dirty, { source: 'enka' }).account.characters[0])
} catch (e) {
  dirtyThrew = true
  console.log('        ' + errMessage(e))
}
ok(!dirtyThrew, '认不出的部件 id 不会抛异常')
ok(!!dirtyScore, '脏数据仍能算出分（坏的那件跳过）')

const unknownChar = { ...structuredClone(payload), avatarInfoList: [{ avatarId: 999999999, propMap: {}, equipList: [] }] }
ok(toMiaoProfile(ingestPayload(unknownChar, { source: 'enka' }).account.characters[0]) === null,
  'miao 不认识的角色返回 null，不抛异常')

/* 空库的 DDL 是启动时按 schema.ts 现算的：建出来的列必须与表定义**逐名逐序**一致。
   少了 / 多了 / 顺序歪了（DDL 生成写错），这几条必红。 */
const builtCols = (d: ReturnType<typeof openDb>, table: string): string[] =>
  (d.$client.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(c => c.name)
const defCols = (t: SQLiteTable): string[] => getTableConfig(t).columns.map(c => c.name)

{
  const fresh = openDb(':memory:')
  for (const [table, def, label] of [
    ['account', accountT, 'Account'], ['character', characterT, 'Character'],
    ['weapon', weaponT, 'Weapon'], ['artifact', artifactT, 'Artifact']
  ] as const) {
    ok(JSON.stringify(builtCols(fresh, table)) === JSON.stringify(defCols(def)),
      `空库 ${table} 的列 == schema.ts 里 ${label} 那几列`,
      `实际 ${JSON.stringify(builtCols(fresh, table))}`)
  }
  fresh.$client.close()
}

/* ---------------- 11. 文案 key 清单 ---------------- */

console.log('\n=== 8. 文案 key 清单（将来接多语言翻译表照着要）===')
const keys = repo.listTextKeys(db)
ok(keys.hash.length === 7, `库里用到 7 个 key：5 个部件名 + 1 个套装名 + 1 个武器名（实际 ${keys.hash.length}）`,
  `实际 ${keys.hash.length}: ${keys.hash.slice().sort((a, b) => a - b).join(',')}`)
ok(keys.avatars.includes(10000046) && keys.avatars.includes(10000003),
  '角色单独列出来（enka 不给角色名 hash，得另配映射）')

/* ---------------- 12. 真实数据端到端 ---------------- */
/*
 * 前面全是用合成数据测「逻辑对不对」，这一段拿一份**真实的 enka 响应**跑完整条链路。
 * 夹具 test/data/enka-real.json 是真实响应，只做了两件事：换了 uid/昵称（隐私）、
 * 只留 3 个不同元素的角色（体积）。数值一个没动。
 *
 * 最有价值的是面板对拍：enka 的 fightPropMap 是游戏客户端自己算的最终面板，
 * 拿它当标准答案，能一次性验证「角色等级/突破 + 武器 + 圣遗物主副词条」全都没翻错。
 */

console.log('\n=== 9. 真实数据端到端（含面板对拍）===')
/* 真实响应的夹具直接按 EnkaPayload 用（它就是一份 enka 响应；JSON.parse 出来是 any）。 */
const realRaw = JSON.parse(fs.readFileSync(path.join('test', 'data', 'enka-real.json'), 'utf8')) as EnkaPayload
const realIn = ingestPayload(realRaw, { source: 'enka' })
const realDb = openDb(':memory:')
repo.saveFetch(realDb, { ...realIn, stamp: '2026-01-04T00:00:00.000Z' })
const realBack = repo.loadAccountWithCharacters(realDb, realIn.account.uid!)!

ok(realBack.characters.length === 3, `真实响应 3 个角色全部入库（实际 ${realBack.characters.length}）`)
ok(realBack.characters.every(a => a.artifacts.length === 5 || a.artifacts.length === 0),
  '每件圣遗物都落在 1~5 号位')

const profileById = new Map<number, MiaoProfile>()
for (const ch of realBack.characters) {
  const p = toMiaoProfile(ch)
  /* 真实响应里每个角色都有 avatarId —— 视图出口拿它当主键，所以 Map 的键也是它。 */
  if (p) profileById.set(ch.avatarId!, p)
}
ok(profileById.size === 3, '3 个角色 miao 都认识')

const cmp = diffPanels(realRaw, profileById)
ok(cmp.list.length === 3, '3 个角色都能对拍（都有 fightPropMap）')
ok(cmp.ok,
  `游戏面板 vs miao 计算面板：全部对上（最大偏差 ${(cmp.worst!.rel * 100).toFixed(4)}% 出现在 ${cmp.worst!.key}）`,
  cmp.list.flatMap(d => d.rows.filter(r => !r.ok)
    .map(r => `${d.name}.${r.key}: 游戏 ${r.game} vs 我们 ${r.ours}（差 ${(r.rel * 100).toFixed(4)}%）`)).join('\n        '))

/* 顺带用真实数据锚一个数值：迪卢克的满级 5★ 暴击伤害冠 = 62.2%
   这一条同时证明 level 21→20 的归一化在真实数据上也对（错了会变 59.5） */
const diluc = realBack.characters.find(a => a.avatarId === 10000016)
const dilucMark = diluc ? scoreOf(diluc) : null
ok(dilucMark?.artis?.['5']?.main?.value === '62.2%',
  '真实数据锚点：迪卢克暴伤冠主词条 = 62.2%（level 归一化在真实数据上也对）',
  `实际 ${dilucMark?.artis?.['5']?.main?.value}`)

const realKeys = repo.listTextKeys(realDb)
ok(realKeys.hash.length > 10, `真实数据带下来 ${realKeys.hash.length} 个官方文案 key`)

/* ---------------- 11. 默认兜底必须在表现层可见 ----------------
 * 背景：上游权重表 artis-mark.js 不是每个角色都有。查不到时内核拿通用表兜底，
 * 但标题照旧拼 `${char.abbr}-通用` —— 于是「沃雅妮莎」显示成「妮莎-通用」，
 * 看着像上游真给她定过一套权重，实际那张表根本没这一行。
 * 这里钉住两件事：内核要标出 isDefaultWeight，view 层要把它换成「默认-通用」。
 * ⚠️ 两侧都要有对照组：只测兜底角色的话，哪天内核改成永远返回 true 也会全绿。 */
console.log('\n=== 10. 默认兜底在表现层可见 ===')

/* 上游权重表（vendored JS）：TS 从 JS 推出来的是「每个角色一行」的**精确字典**，
   拿任意字符串去索引会报错。这里按我们真正的用法声明成「角色名 → 权重行」——
   兜底角色就是整行不存在（`usefulAttr[name]` 为 undefined），所以刻意不留 default。 */
const { usefulAttr } = (await import('../vendor/miao/resources/meta-gs/artifact/artis-mark.js')) as {
  usefulAttr: Record<string, Record<string, number>>
}
const { classTitleOf } = await import('../src/service/character.service.ts')

/*
 * 内核 ArtisMarkCfg.getCfg 的结果（vendored JS）—— 这里声明我们真正读的字段。
 * 内核返回 `false` 的语义是「算不出来」，本文件统一归一到 null。
 */
interface MarkCfg {
  classTitle: string
  isDefaultWeight?: boolean
  isCustomWeight?: boolean
  attrs?: Record<string, { weight?: number }>
}

/*
 * getCfg 的返回 → MarkCfg|null。
 * ⚠️ 入参写 `unknown` 不是偷懒：这个函数是 vendored JS，TS 只会按 JS 源码推出一份
 * `{ attrs: {}; posMaxMark: {}; … }` 的形状，而它跟我们的 MarkCfg **两边都不可比**
 * （`{}` 与 `Record<string, …>` 互不兼容），直接 `as MarkCfg` 会被 TS 判为「可能写错了」。
 * 真正说得清形状的是我们 —— 所以从 unknown 这一侧断言，顺便把 `false → null` 收在一个地方。
 */
const asCfg = (ret: unknown): MarkCfg | null => (ret ? ret as MarkCfg : null)

/* ⚠️ 必须用 getCfg（不是 getCharArtisCfg）：classTitleOf 读的是 getCfg 的 `classTitle` 字段，
   而 getCharArtisCfg 的字段叫 `title`。生产链路上 shapeCharacter 拿到的就是 getCfg 的结果。
   顺带这一步把 attrs 那些计算也跑完了，跟真实链路一致。 */
const cfgOf = (name: string): MarkCfg | null => {
  const char = Character.get(name)
  if (!char) return null
  const profile = {
    char, game: 'gs', weapon: { name: '', affix: 1 }, elem: char.elem,
    attr: {}, cons: 0, artis: { is: () => false }
  }
  return asCfg(ArtisMarkCfg.getCfg(profile))
}

/* 兜底组的找法：**角色名单减去权重表里的键**。
   ⚠️ 不是「表里值为空的键」—— 那张表每个键都有值，兜底角色是**整行不存在**
   （`usefulAttr[char.name]` 返回 undefined）。两个查法看起来像，含义完全不同。
   名单直接读 character/data.json（Meta.getMeta('gs','char') 只有 wifeData，取不到名单）。 */
const charData = JSON.parse(fs.readFileSync(
  path.resolve(import.meta.dirname, '..', 'vendor/miao/resources/meta-gs/character/data.json'), 'utf8')) as
  Record<string, { name?: string }>
/* `filter((n): n is string => !!n)` 而不是 `filter(Boolean)`：后者在 TS 里推出来还是
   `(string | undefined)[]`，下游每个调用点都得再挡一道。空名字本来就要剔掉，判据一致。 */
const allNames = Object.values(charData).map((c) => c.name).filter((n): n is string => !!n)

/* 剔掉两类「本来就不该进这张表」的角色，否则测试的对照组是假的：
   ① 主角（空/荧）—— Character.get 认得它们，但内核按 isTraveler 走另一条分支，
      标题前缀是「风主/岩主」而不是查表得来的，abbr 也不来自这张表；
   ② 奇偶·男性/奇偶·女性 —— 主角的「双性别」占位，data.json 里有、元数据里没有对应项。 */
const isTravelerOrAlias = (n: string): boolean => /旅行者|主角|^[空荧]$/.test(n) || n.startsWith('奇偶·')
const charNames = allNames.filter((n) => !isTravelerOrAlias(n))
const fallbackChars = charNames.filter((n) => !usefulAttr[n])
const knownChars = charNames.filter((n) => usefulAttr[n])

ok(charNames.length > 0, `角色名单取到 ${charNames.length} 个`)
/* 这条是**哨兵**，不是「必须为 0」：上游权重表 artis-mark.js 还没收录沃雅妮莎、薇斯纳
   （同步时间差），所以这两个角色确实在走通用兜底。
   它每次同步都会自动收敛：上游补上那两行 → fallbackChars 变空 → 本条转绿。
   在那之前，页面上这两个角色显示「默认-通用」，不假装上游有专属权重。 */
ok(charNames.length - fallbackChars.length === knownChars.length,
  `权重表覆盖 ${knownChars.length}/${charNames.length} 个角色，${fallbackChars.length} 个走兜底`,
  `走兜底的角色：${fallbackChars.join(' ') || '（无）'}`)
ok(knownChars.length > 100, `对照组：权重表里有 ${knownChars.length} 个角色可对照`)

for (const name of fallbackChars.slice(0, 3)) {
  const cfg = cfgOf(name)
  ok(cfg?.isDefaultWeight === true, `${name}：内核标出 isDefaultWeight=true`)
  const shown = classTitleOf(cfg)
  ok(shown.startsWith('默认-'),
    `${name}：表现层标题是「${shown}」（不误导成上游有专属权重）`,
    `得到 ${shown}`)
}

/* ⚠️ 兜底分支不能只靠「真实存在但没被收录的角色」来测 ——
   权重表同步补进新角色后，fallbackChars 就空了，上面那个循环一次都不跑，
   兜底分支从此无人看守（哪天内核把 isDefaultWeight 传错也全绿）。
   所以这里**构造**一个表里查不到的角色，把这条分支钉死。 */
const fakeName = '__不存在的角色__'
ok(!usefulAttr[fakeName], `构造：${fakeName} 确实不在权重表里（兜底前提）`)
{
  /* 抄一个真实角色，只把 name 换成表里没有的 —— 内核只拿 char.name 去查表，
     这样 usefulAttr[char.name] 就是 undefined，稳定落到通用兜底。
     ⚠️ 不能用 Object.assign 覆盖：Character 的 id/name/abbr 都是**只读 getter**
     （定义在 metaKey 生成的属性上），assign 会抛 TypeError。 */
  const real = Character.get(knownChars[0]) as Character
  const fakeChar = Object.create(Object.getPrototypeOf(real))
  Object.assign(fakeChar, real)
  for (const [k, v] of Object.entries({ id: real.id, name: fakeName, abbr: '假角色' })) {
    Object.defineProperty(fakeChar, k, { value: v, writable: true, configurable: true })
  }
  const cfg = asCfg(ArtisMarkCfg.getCfg({
    char: fakeChar, game: 'gs', weapon: { name: '', affix: 1 }, elem: fakeChar.elem,
    attr: {}, cons: 0, artis: { is: () => false }
  }))!
  ok(cfg.isDefaultWeight === true, '兜底时内核标出 isDefaultWeight=true')
  ok(cfg.classTitle === '假角色-通用', `兜底时内核标题照旧是「${cfg.classTitle}」`)
  ok(classTitleOf(cfg) === '默认-通用',
    `兜底时表现层标题是「${classTitleOf(cfg)}」而不是「假角色-通用」`,
    `得到 ${classTitleOf(cfg)}`)
  const atk = cfg.attrs?.atk?.weight ?? cfg.attrs?.atkPlus?.weight
  ok(atk !== undefined, `兜底仍算出权重（atk 系 ${atk}）—— 兜底不等于不算分`)
}

/* 对照组：权重表里有这个角色 → 标记不为 true、标题原样透传。
   只挑**没有专属规则 artis.js** 的角色：专属规则会读 profile.artis.names 这类字段，
   我们这个最小 profile 喂不进去（会抛 TypeError），跑不到「原样透传」那一步。
   判据用文件存在性，不写死名字。 */
const hasOwnRule = (n: string): boolean => fs.existsSync(path.resolve(import.meta.dirname, '..',
  'vendor/miao/resources/meta-gs/character', n, 'artis.js'))
let passthroughChecked = 0
for (const name of knownChars.filter((n) => !hasOwnRule(n))) {
  const cfg = cfgOf(name)
  if (!cfg?.classTitle) continue
  ok(cfg.isDefaultWeight === false, `${name}：在权重表里 → isDefaultWeight 不为 true`)
  ok(classTitleOf(cfg) === cfg.classTitle,
    `${name}：标题原样透传（${cfg.classTitle}）`,
    `被改成了 ${classTitleOf(cfg)}`)
  if (++passthroughChecked >= 3) break
}
ok(passthroughChecked > 0, '对照组里至少验到了 3 个「原样透传」的角色',
  `实际验到 ${passthroughChecked} 个`)
ok(classTitleOf({ classTitle: '胡桃-护摩', isDefaultWeight: false }) === '胡桃-护摩',
  '场景词保留：护摩 不被改写')
ok(classTitleOf({ classTitle: '胡桃-绝缘4', isDefaultWeight: false }) === '胡桃-绝缘4',
  '场景词保留：绝缘4 不被改写')
ok(classTitleOf({ classTitle: '妮莎-通用', isDefaultWeight: true }) === '默认-通用',
  '只换前缀、后半段场景词不动（妮莎-通用 → 默认-通用）')
ok(classTitleOf({ classTitle: '', isDefaultWeight: true }) === '',
  '空标题原样返回，不硬造出「默认」')
ok(classTitleOf({ classTitle: '无连字符', isDefaultWeight: true }) === '默认',
  '标题里没有连字符时退化成「默认」，不吞掉整串')

/* 「通用」要拆成三类：内核只区分「命中特判没有」，分不出「查表」与「专属规则手写」。 */
{
  ok(classTitleOf({ classTitle: '迪希雅-通用', isCustomWeight: true }) === '自定义-通用',
    '专属规则默认分支手写了权重 → 前缀「自定义」（迪希雅 recharge 75≠表里 55）')
  ok(classTitleOf({ classTitle: '七七-通用', isCustomWeight: false }) === '七七-通用',
    '默认分支照抄权重表 → 前缀保持角色缩写（七七那 68 个）')
  ok(classTitleOf({ classTitle: '妮莎-通用', isDefaultWeight: true }) === '默认-通用',
    '权重表里没这个角色 → 前缀「默认」')
  /* 特判分支标题已自带场景名，再加「自定义」是重复信息 —— 内核侧就不该标 */
  ok(classTitleOf({ classTitle: '可莉-纯火', isCustomWeight: true }) === '可莉-纯火',
    '标题已带场景名时不改前缀（classTitleOf 层是防御性兜底）')
  /* ⚠️ 兜底 + 场景词：两个标记回答不同问题，不能因为标题带了场景就吞掉「默认」 */
  ok(classTitleOf({ classTitle: '假角色-绝缘4', isDefaultWeight: true }) === '默认-绝缘4',
    '兜底角色命中绝缘4 → 「默认-绝缘4」（不因标题已有场景词就漏掉「默认」）')
  ok(classTitleOf({ classTitle: '假角色-绝缘4', isCustomWeight: true }) === '假角色-绝缘4',
    '非兜底 + 标题带场景词 → 前缀不动')
}

/* 真实角色：内核标记与页面标题必须一致（用真元数据跑，不用构造对象） */
{
  const ATTR: Record<string, number> = { hp: 20000, atk: 2000, def: 1000, cpct: 20, cdmg: 50, mastery: 20, recharge: 100 }
  const cfgOf = (name: string): MarkCfg | null => {
    const char = Character.get(name)
    return char
      ? asCfg(ArtisMarkCfg.getCfg({ char, game: 'gs', weapon: { name: '', affix: 1 }, elem: char.elem, attr: { ...ATTR }, cons: 0, artis: { is: () => false } }))
      : null
  }
  const d = cfgOf('迪希雅')
  ok(d?.isCustomWeight === true && d?.isDefaultWeight === false,
    '迪希雅：内核标出 isCustomWeight（专属规则默认分支手写了权重）')
  ok(classTitleOf(d) === '自定义-通用', `迪希雅页面显示「${classTitleOf(d)}」`)
  /* 断言的是「内核**没有**多暴露一个 diff 字段」—— 用 `in` 才表达得出这个意思；
     拿 `d.charWeightDiff === undefined` 会立刻被 TS 拦下（字段压根不在类型里）。 */
  ok(d !== null && !('charWeightDiff' in d), '内核不额外暴露 diff 字段（只给布尔标记）')

  for (const n of ['七七', '神里绫华', '迪卢克', '砂糖', '温迪']) {
    const c = cfgOf(n)
    ok(c && c.isCustomWeight === false && c.isDefaultWeight === false,
      `${n}：两个标记都为 false（默认分支照抄权重表）`)
    ok(classTitleOf(c) === c?.classTitle, `${n}：标题原样透传（${c?.classTitle}）`)
  }
  /* 特判分支：内核就不该标 isCustomWeight（标题已自带场景名） */
  const kleeChar = Character.get('可莉') || null
  const klee = kleeChar
    ? asCfg(ArtisMarkCfg.getCfg({
        char: kleeChar, game: 'gs', weapon: { name: '', affix: 1 },
        elem: kleeChar.elem,
        attr: { ...ATTR, cpct: 40, cdmg: 180 }, cons: 0, artis: { is: () => false }
      }))
    : null
  ok(klee?.classTitle === '可莉-纯火' && klee?.isCustomWeight === false,
    `可莉命中特判 → 标题自带「纯火」且不标 isCustomWeight（实际 ${klee?.classTitle}）`)
}

/* ---------------- 12. 面板属性表：三种加成必须分得开 ----------------
 * 来历：面板原本只有 8 行、且把 dmg 的名字写死成「伤害加成」，于是
 *   ① 治疗角色面板上的治疗加成显示成「伤害加成」（实测芭芭拉 65.9% 显示成「伤害增加」）
 *   ② 物理伤害加成那一行**根本不存在**（上游模板的 attrMap 也只有 dmg）
 * 上游权重表里 dmg / phy / heal 是三项独立权重（沃雅妮莎 heal:75、甘雨 dmg:100、
 * 芭芭拉 heal:100），面板把它们合并成一个名字就是误导 —— 看不出该刷什么。
 * ⚠️ 名字必须逐个断言：三个 key 都存在 ≠ 三个名字不同（合并成一个照样「都在」）。 */
console.log('\n=== 11. 面板属性表：三种加成只按权重表出行 ===')

const { attrTableOf } = await import('../src/service/character.service.ts')
const panelOfFake = (attr: Record<string, number>, w: Record<string, number> = {}, elem = ''): AttrRow[] =>
  attrTableOf({ attr, base: {} }, 'chs', w, elem)
const DMG3 = ['dmg', 'phy', 'heal']
const baseLen = 7   /* ATTR_TABLE 的固定行数 */
const dmgRowsOf = (rows: AttrRow[]): AttrRow[] => rows.filter((r) => DMG3.includes(r.key))

/* 1. 判据只有一条：权重 > 0。面板上的实际值一律不参与。 */
{
  const rows = panelOfFake({ dmg: 46.6 }, { dmg: 100 })
  const d = dmgRowsOf(rows)
  ok(d.length === 1 && d[0].key === 'dmg', '权重表要元素伤害 → 只出元素伤害一行', `实际 ${d.map((r) => r.key)}`)
}
{
  /* ⚠️ 这一条是本节的核心：迪奥娜权重 heal=100/dmg=0，但她身上带元素增伤圣遗物（面板 18.0%）。
     面板该显示的是「这个角色该关注什么」——多出元素伤害那行是圣遗物的信息，不是她的。 */
  const rows = panelOfFake({ hp: 27655, dmg: 18, heal: 0 }, { hp: 100, dmg: 0, heal: 100, recharge: 100 })
  const d = dmgRowsOf(rows)
  ok(d.length === 1 && d[0].key === 'heal',
    '权重表只有治疗（身上有元素伤害圣遗物也不显示元素伤害）',
    `实际 ${d.map((r) => r.key)}`)
  ok(!rows.some((r) => r.key === 'dmg'), '面板值 18.0% 的元素伤害不占行（判据只看权重）')
}
{
  const rows = panelOfFake({ phy: 40 }, {})
  ok(dmgRowsOf(rows).length === 0, '面板值有但权重全 0 → 三种加成一行都不出')
}
{
  const rows = panelOfFake({ heal: 0 }, { heal: 75 })
  ok(dmgRowsOf(rows).length === 1,
    '权重>0 但面板值=0 → 照样出行（治疗角色看不到自己该刷治疗就白改了）')
}
{
  const rows = panelOfFake({ hp: 17876, cpct: 48.9 }, {})
  ok(rows.length === baseLen, `三项权重全 0 → 只有固定 ${baseLen} 行，不补空行`, `实际 ${rows.length} 行`)
}

/* 2. 权重表真有两项时出两行（雷泽/优菈/心海…那 8 个），不是三行、也不是一行 */
{
  const rows = panelOfFake({ dmg: 100, phy: 100 }, { dmg: 100, phy: 100 })
  const d = dmgRowsOf(rows)
  ok(d.length === 2, `权重表两项都要 → 出两行（${d.map((r) => r.key).join('+')}）`, `实际 ${d.length} 行`)
  ok(d.length < 3, '永远不超过三行')
}

/* 3. 名字：三种加成必须三个不同名（别又合并成「伤害加成」） */
{
  const rows = panelOfFake({}, { dmg: 100, phy: 100, heal: 100 })
  const nameOf = (k: string): string | undefined => rows.find((r) => r.key === k)?.label
  const [d, p, h] = DMG3.map(nameOf)
  ok(d && p && h && new Set([d, p, h]).size === 3,
    `三种加成三个名字：${d} / ${p} / ${h}`, `得到 ${JSON.stringify([d, p, h])}`)
  ok(d === '元素伤加成' && p === '物伤加成' && h === '治疗加成',
    '三项加成统一「X伤加成」句式，跟杯子主词条同一说法（元素伤加成/物伤加成/治疗加成）')
}

/* 3b. 元素伤害那行要带上**具体元素**：名字和 iconKey 一起换。
 * 来历：属性图标是 assets/character/svgs/ 下**每个属性一张独立 SVG**，
 *   七元素各有一张、**没有「通用元素伤害」这一张**，
 *   所以这行必须按角色元素走（火伤加成 + .i-pyro）。用字跟杯子主词条一致（miao 的 `${name}伤加成`）。
 * ⚠️ 这两条必须构造输入钉死：真实数据里 elem 永远有值，「拿不到元素」那条分支
 *   平时一次都不会跑，等它真跑起来（旅行者 elem=multi）没人看着。 */
{
  const rows = panelOfFake({ dmg: 46.6 }, { dmg: 100 }, 'pyro')
  const d = rows.find((r) => r.key === 'dmg')
  ok(d?.label === '火伤加成', `火系角色：写成「火伤加成」（实际 ${d?.label}）`)
  ok(d?.iconKey === 'pyro', `图标 key 换成元素名（.i-pyro）（实际 ${d?.iconKey}）`)

  const dendro = panelOfFake({ dmg: 46.6 }, { dmg: 100 }, 'dendro').find((r) => r.key === 'dmg')
  ok(dendro?.label === '草伤加成' && dendro?.iconKey === 'dendro',
    `草系同理（实际 ${dendro?.label} / ${dendro?.iconKey}）`)
}
{
  /* elem 拿不到时（旅行者是 multi，不在七元素里）：名字退回通名、图标留空。
     ⚠️ 不许兜底成某个具体元素 —— 那是替玩家编了一个元素。 */
  const d = panelOfFake({ dmg: 46.6 }, { dmg: 100 }, 'multi').find((r) => r.key === 'dmg')
  ok(d?.label === '元素伤加成' && d?.iconKey === 'dmg',
    `拿不到元素 → 通名「元素伤加成」+ iconKey 留 dmg（实际 ${d?.label} / ${d?.iconKey}）`)
}
{
  /* 其余属性行的 iconKey 就是自己的 key（前端默认按 key 拼 .i-<key>） */
  const rows = panelOfFake({ hp: 17876 }, { heal: 100 })
  ok(rows.every((r) => r.iconKey === r.key || r.key === 'dmg'),
    '非元素伤害行的 iconKey 与 key 一致', `得到 ${JSON.stringify(rows.map((r) => [r.key, r.iconKey]))}`)
}

/* 4. 面板名字不带「大」字 —— 那是圣遗物卡片的用字（大生命/小生命） */
{
  const rows = panelOfFake({ hp: 17876, atk: 2215, def: 961, recharge: 122.7 }, {})
  const nameOf = (k: string): string | undefined => rows.find((r) => r.key === k)?.label
  ok(nameOf('hp') === '生命值' && nameOf('atk') === '攻击力' && nameOf('def') === '防御力',
    `面板用总值口径的生命/攻击/防御（${nameOf('hp')}/${nameOf('atk')}/${nameOf('def')}）`,
    `得到 ${JSON.stringify([nameOf('hp'), nameOf('atk'), nameOf('def')])}`)
  ok(!/^大(生命|攻击|防御)$/.test(nameOf('hp') || ''), '面板不带「大」字')
  ok(nameOf('recharge') === '元素充能', '元素充能用 miao 的用字，不是 i18n 的「充能效率」')
}

/* 5. 固定七项恒为满行（0.0% 也出行），行高才稳定 */
{
  const rows = panelOfFake({ hp: 17876, cpct: 48.9 }, {})
  ok(rows.slice(0, baseLen).map((r) => r.key).join(',') === 'hp,atk,def,mastery,cpct,cdmg,recharge',
    '固定七项顺序与数量不变')
  ok(rows.slice(0, baseLen).every((r) => r.value !== undefined && r.value !== null),
    '固定项缺值时也出格式化后的值（不 continue）')
  ok(new Set(rows.map((r) => r.key)).size === rows.length, '各行 key 互不重复')
}

/* 6. 权重要能对上：charWeight 的 key 与面板 key 同一套 */
{
  const w = { hp: 100, heal: 100, recharge: 55 }
  const rows = attrTableOf({ attr: { hp: 31046, heal: 65.9, recharge: 168.6 }, base: {} }, 'chs', w)
  const weightOf = (k: string): number | undefined => rows.find((r) => r.key === k)?.weight
  ok(weightOf('hp') === 100 && weightOf('heal') === 100 && weightOf('recharge') === 55,
    `面板权重取自 charWeight（hp=${weightOf('hp')} heal=${weightOf('heal')} recharge=${weightOf('recharge')}）`,
    `得到 ${JSON.stringify([weightOf('hp'), weightOf('heal'), weightOf('recharge')])}`)
  ok(weightOf('atk') === 0, 'charWeight 里没有的项，权重是 0（不硬造）')
}

/* ---------------- 13. 百分比的显示舍入：别被 float32 噪声带偏 ----------------
 * 来历：拿游戏对照 —— 5★ 大生命第 3 档游戏显示 5.3%，我们显示 5.2%。
 * 根因在上游 miao 的**数据**：副词条表把倍率存成了 float32 精度的十进制
 *   （真值 0.0525 → 存成 0.05249999836087227），内核算出来是 5.249999836，
 * 落在 5.25 这个半分界**下面**，于是 miao 的 `Format.pct`（= toFixed(1)）舍成 5.2% ——
 * 而游戏按十进制四舍五入显示 5.3%。同样的档位扫全表有 12 个（全是偏低 0.1）。
 *
 * ⚠️ 断言的是**我们的出口**，不是内核 —— 内核输出一个字没动（verify 基线不动）。
 * ⚠️ 只改数据（把 0.05249999836 改回 0.0525）救不了这类：double 在 x.x5 上可能落在
 *   分界下方（0.0315*100 = 3.1499999999999995），照样舍反。所以必须在这一层做十进制舍入。
 * ⚠️ 「非分界值」那组是防手抖的：舍入写宽一点（比如四舍五入到 2 位再截）会让每一行都 +0.1。 */
console.log('\n=== 12. 百分比的显示舍入（float32 噪声 / 半分界）===')
const { attrValueText } = await import('../src/service/character.service.ts')
{
  /* [key, 内核已格式化好的串, 内核的裸数字, 期望, 这是什么档位] —— 裸数字都是真实档位算出来的原值 */
  const cases: Array<[string, string, number, string, string]> = [
    ['hp', '5.2%', 5.249999836087227, '5.3%', '5★ 大生命第 3 档（这次报的那件）'],
    ['atk', '5.2%', 5.249999836087227, '5.3%', '5★ 大攻击第 3 档（同一个倍率）'],
    ['def', '5.2%', 5.249999836087227, '5.3%', '4★ 防御力第 3 档'],
    ['hp', '2.4%', 2.449999935925007, '2.5%', '3★ 生命第 1 档'],
    ['cdmg', '1.5%', 1.549999974668026, '1.6%', '1★ 暴伤第 3 档'],
    ['hp', '3.2%', 3.150000050663948, '3.2%', '3★ 生命第 3 档（这档噪声是正的，本来就对）'],
    ['cdmg', '4.3%', 4.349999874830246, '4.4%', '4★ 暴伤第 3 档（改数据救不回来那档）']
  ]
  for (const [key, formatted, raw, want, what] of cases) {
    const got = attrValueText(key, formatted, raw)
    ok(got === want, `${what} → ${want}`, `得到 ${got}`)
  }
}
{
  const cases: Array<[string, string, number, string]> = [
    ['recharge', '17.5%', 17.490000277757645, '17.5%'],
    ['cpct', '6.6%', 6.609999947249889, '6.6%'],
    ['hpPlus', '298.7', 298.659375, '299']   /* 整数词条仍走收整那条路 */
  ]
  for (const [key, formatted, raw, want] of cases) {
    const got = attrValueText(key, formatted, raw)
    ok(got === want, `没落在半分界上的值不许被推跑：${key} → ${want}`, `得到 ${got}`)
  }
}
{
  /* 拿不到裸数字（汇总过的串、CLI 那些调用方）时原样用内核的串 —— 不瞎猜 */
  ok(attrValueText('hp', '5.2%') === '5.2%', '没有裸数字 → 原样用内核的串（不猜）')
  ok(attrValueText('hp', '') === '', '空值原样返回')

  /* ⚠️ enka 值可能是 null / undefined。传进来必须被当成「没有 enka 值」，而不是 0 ——
     `Number(null) === 0` 会把主词条钉成 0（整数词条）/ 0.0%（百分比词条），
     兜底逻辑整条失效。三种「空」各钉一条：null / undefined / 空串（走 num()，不走 Number()）。 */
  ok(attrValueText('hp', '46.6%', 46.62, null) === '46.6%',
    'enka 值为 null → 退回内核值，不当成 0（百分比）')
  ok(attrValueText('hp', '46.6%', 46.62, undefined) === '46.6%',
    'enka 值为 undefined → 退回内核值（百分比）')
  ok(attrValueText('hpPlus', '4,778.6', 4778.55, null) === '4,779',
    'enka 值为 null → 退回内核值，不当成 0（整数词条）')
  ok(attrValueText('hp', '0.0%', 0, 0) === '0.0%',
    'enka 值**真是 0** 时照用（0 和「没有」分得开，这正是不能用 Number() 的原因）')
}
{
  /* 面板同一条口径 —— 否则卡片 5.3%、面板 5.2%，同一页自己打自己 */
  const rows = attrTableOf({ attr: { cpct: 5.249999836087227 }, base: {} }, 'chs', {})
  ok(rows.find((r) => r.key === 'cpct')?.value === '5.3%', '面板百分比同口径 → 5.3%')
}

console.log('\n=== 13. 圣遗物显示用 enka 原始数值（不走内核重算）===')

/*
 * 评分 100% 归 miao，但页面上的**数值**要用 enka 的原始 statValue —— 内核的基准表有
 * float 误差（满级花主词条 4,778.6，真值 4,780；精通 32.6，真值 33），enka 是官方算好的。
 * 这段守三件事：① 落库了；② 显示用的是它；③ enka prop → miao key 的映射方向没搞反。
 */
{
  /* 用一份干净的库，别受前面几节改库的影响 */
  const vdb = openDb(':memory:')
  repo.saveFetch(vdb, { ...ingested, stamp: '2026-01-01T00:00:00.000Z' })
  const row = repo.loadAccountWithCharacters(vdb, uid)!.characters.find(a => a.avatarId === 10000046)!
  const a1 = row.artifacts.find(a => a.pos === 1)!
  ok(Number.isFinite(a1?.mainStatValue), '主词条数值落库了（mainStatValue）',
    `实际 ${a1?.mainStatValue}`)
  ok(Array.isArray(a1?.subStats) && a1.subStats.length > 0, '副词条数值落库了（subStats 数组）',
    `实际 ${JSON.stringify(a1?.subStats)}`)

  /* 花的主词条：enka 的 FIGHT_PROP_HP=4780（固定值）→ key 必须是 hpPlus（小生命）。
     映射搞反（hpPlus→HP_PERCENT）的话这里会显示成 46.6 => 直接钉死方向。 */
  const view = shapeCharacter(row, toMiaoProfile(row)!, scoreOf(row)!, 'chs')
  const main1 = view.artifacts.find(x => x.pos === 1)?.main
  ok(main1?.key === 'hpPlus', '花主词条 key = hpPlus（enka FIGHT_PROP_HP 是固定值）',
    `实际 ${main1?.key}`)
  ok(main1?.value === '4,780', '花主词条显示 4,780（enka 真值，不是内核的 4,778.6）',
    `实际 ${main1?.value}`)

  /* 羽的主词条：FIGHT_PROP_ATTACK=311（固定值）→ atkPlus */
  const main2 = view.artifacts.find(x => x.pos === 2)?.main
  ok(main2?.key === 'atkPlus' && main2?.value === '311',
    '羽主词条 = atkPlus 311（enka 真值，不是内核的 310.8）', `实际 ${main2?.key} ${main2?.value}`)

  /* 副词条整数类走 enka 值：2 号位（羽毛）带 2 次精通 roll，夹具每次记 20 → 合并后 40。
     内核那套会按倍率算成 33 之类的带小数值 —— 这里要的就是 enka 的 40。 */
  const mastery = (view.artifacts.find(x => x.pos === 2)?.subs || []).find(s => s.key === 'mastery')
  ok(mastery?.value === '40', '副词条精通按 enka 值（2 次 roll × 20 = 40，不是内核那套 33）',
    `实际 ${mastery?.value}`)

  /* 没有 enka 数值的老行：退回内核值，不炸。
     造法就是「把模型里那两处留空」—— 展开字段重新构造一个（模型只有字段、
     行为都在原型上，构造出来的东西与原来逐字段相同）。
     ⚠️ 不能「展开成一个纯对象」直接喂下去：那样 TS 是对的（纯对象只是缺了原型上的方法），
     而且出口哪天开始调方法就会当场炸 —— 构造回模型才是造夹具的正路。 */
  const noEnka = new DomainCharacter({
    ...row,
    artifacts: row.artifacts.map(a => new Artifact({ ...a, mainStatValue: null, subStats: [] }))
  })
  const fallback = shapeCharacter(noEnka, toMiaoProfile(noEnka)!, scoreOf(noEnka)!, 'chs')
  const fbMain = fallback.artifacts.find(x => x.pos === 1)?.main?.value
  /* 断言要钉到具体值：只写「不等于 4,780」的话，退化成 "0" 也能过（这就是它一开始漏掉的原因） */
  ok(fbMain === '4,779',
    '老行没有 enka 数值时退回内核值（4,779 = 内核 4,778.55 收整；有 enka 值才是 4,780）',
    `实际 ${fbMain}`)
  vdb.$client.close()
}

{
  /*
   * 映射表方向直接钉死（不借夹具，免得夹具一变这段就空转）。
   * 最要紧的是三对「大/小」别搞反：enka 的 **_PERCENT 是大生命/大攻击/大防御（→ hp/atk/def），
   * 不带 PERCENT 的是固定值（→ hpPlus/atkPlus/defPlus）。搞反了主词条会把 4,780 显示成 46.6%。
   */
  const cases = [
    ['FIGHT_PROP_HP', 'hpPlus'], ['FIGHT_PROP_HP_PERCENT', 'hp'],
    ['FIGHT_PROP_ATTACK', 'atkPlus'], ['FIGHT_PROP_ATTACK_PERCENT', 'atk'],
    ['FIGHT_PROP_DEFENSE', 'defPlus'], ['FIGHT_PROP_DEFENSE_PERCENT', 'def'],
    ['FIGHT_PROP_ELEMENT_MASTERY', 'mastery'], ['FIGHT_PROP_CHARGE_EFFICIENCY', 'recharge'],
    ['FIGHT_PROP_CRITICAL', 'cpct'], ['FIGHT_PROP_CRITICAL_HURT', 'cdmg'],
    ['FIGHT_PROP_HEAL_ADD', 'heal'], ['FIGHT_PROP_ADD_HURT', 'dmg'],
    ['FIGHT_PROP_PHYSICAL_ADD_HURT', 'phy'], ['FIGHT_PROP_FIRE_ADD_HURT', 'pyro'],
    ['FIGHT_PROP_ELEC_ADD_HURT', 'electro'], ['FIGHT_PROP_WATER_ADD_HURT', 'hydro'],
    ['FIGHT_PROP_GRASS_ADD_HURT', 'dendro'], ['FIGHT_PROP_WIND_ADD_HURT', 'anemo'],
    ['FIGHT_PROP_ROCK_ADD_HURT', 'geo'], ['FIGHT_PROP_ICE_ADD_HURT', 'cryo']
  ]
  const bad = cases.filter(([prop, key]) => enkaPropKey(prop) !== key)
  ok(bad.length === 0,
    `enka prop → miao key 映射表 ${cases.length} 项全对（尤其大/小生命别搞反）`,
    bad.map(([p, k]) => `${p} 应为 ${k}，实为 ${enkaPropKey(p)}`).join('；'))
  ok(enkaPropKey('FIGHT_PROP_不存在的') === null, '不认识的 prop 返回 null（不瞎猜）')
  ok(ENKA_PROP_TO_KEY.FIGHT_PROP_HP !== 'hp',
    '守卫：固定值生命绝不许映到 hp（大生命）—— 搞反了花主词条就成百分比')
}

console.log(`\n结果：通过 ${passed} 项，失败 ${failed} 项`)
process.exit(failed > 0 ? 1 : 0)

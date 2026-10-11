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

import { ArtisMark, Meta, Character, ArtisMarkCfg } from '../src/index.js'
import { openDb, SCHEMA_VERSION } from '../src/store/db.js'
import * as repo from '../src/store/repo.js'
import { ingestPayload } from '../src/adapter/ingest.js'
import { toMiaoProfile, normalizeLevel } from '../src/adapter/materialize.js'
import { diffPanels } from '../src/adapter/panel-check.js'

let failed = 0
let passed = 0
function ok (cond, label, extra = '') {
  console.log(`${cond ? '[PASS]' : '[FAIL]'} ${label}` + (cond || !extra ? '' : `\n        ${extra}`))
  cond ? passed++ : failed++
}

/* ---------------- 1. 元数据派生（不硬编码 id，免得上游一改就烂） ---------------- */

const artiMeta = Meta.getMeta('gs', 'arti')

const mainIdOf = (key) => {
  for (const [id, k] of Object.entries(artiMeta.mainIdMap)) if (k === key) return Number(id)
  throw new Error(`mainIdMap 里没有 ${key}`)
}
const rollIdsOf = (key, n = 1) => {
  const ids = Object.entries(artiMeta.attrIdMap)
    .filter(([, v]) => v.key === key)
    .map(([id]) => Number(id))
  if (!ids.length) throw new Error(`attrIdMap 里没有 ${key}`)
  return Array.from({ length: n }, (_, i) => ids[i % ids.length])
}
/* 找一个 5★ 长柄武器 id（胡桃用长柄，虽然内核不看武器类型，但别制造假数据） */
function findWeaponId () {
  for (let id = 13501; id <= 13599; id++) {
    const d = Meta.getData('gs', 'weapon', id)
    if (d && d.name && d.type === 'polearm' && d.star === 5) return id
  }
  return null
}

const weaponId = findWeaponId()
ok(!!weaponId, `能按数字 id 查到 5★ 长柄武器（id=${weaponId}）`)

/* ---------------- 2. 造一份「enka 形状」的原始响应 ---------------- */
/* 刻意用原始 prop id，不带任何属性值 —— 这才是 enka 真正给的东西 */

const equip = (pos, mainKey, subs) => ({
  itemId: [0, 80540, 80520, 80550, 80510, 80530][pos],  // 魔女套各部位部件 id
  flat: {
    equipType: ['', 'EQUIP_BRACER', 'EQUIP_NECKLACE', 'EQUIP_SHOES', 'EQUIP_RING', 'EQUIP_DRESS'][pos],
    rankLevel: 5,
    /* 官方文案 key。套装名 5 件共用同一个（真实数据就是这样），部件名各不相同 */
    nameTextMapHash: 1308846500 + pos,
    setNameTextMapHash: 1035953267
  },
  reliquary: {
    level: 21,                       // enka 是 1 基，21 = 满级
    mainPropId: mainIdOf(mainKey),
    appendPropIdList: subs
  }
})

const SUB = {
  cdmg: rollIdsOf('cdmg', 3),        // 同一个 id 连出 3 次 → 词条数应为 3
  cpct: rollIdsOf('cpct', 1),
  mastery: rollIdsOf('mastery', 2)
}

const payload = {
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

/* ---------------- 3. level 归一化 ---------------- */

console.log('\n=== 1. level 基数归一化 ===')
ok(normalizeLevel(21, 'enka') === 20, 'enka 的 21（满级）→ 20', `实际 ${normalizeLevel(21, 'enka')}`)
ok(normalizeLevel(13, 'enka') === 12, 'enka 的 13 → 12', `实际 ${normalizeLevel(13, 'enka')}`)
ok(normalizeLevel(20, 'mys') === 20, '米游社的 20（0 基）→ 原样 20', `实际 ${normalizeLevel(20, 'mys')}`)
ok(normalizeLevel(null, 'enka') === 0, '空值不炸，退回 0')

/* ---------------- 4. ingest ---------------- */

console.log('\n=== 2. ingest：enka 响应 → 库行 ===')
const ingested = ingestPayload(payload, { source: 'enka' })
const av0 = ingested.avatars[0]

ok(ingested.uid === 900000001, 'uid 解析正确')
ok(av0.avatar_id === 10000046, 'avatarId 解析正确')
ok(av0.level === 90 && av0.promote === 6, '等级 / 突破解析正确')
ok(av0.cons === 3, '命座数 = talentIdList.length')
ok(av0.weapon_item_id === weaponId, '武器按 itemId 存')
ok(av0.weapon_affix === 1, '精炼等级：enka 的 0 → 精1')
ok(av0.weapon_name_hash === 800766043, '武器名文案 key 带下来了（多语言靠它）',
  `实际 ${av0.weapon_name_hash}`)
ok(av0.artifacts.length === 5, '圣遗物 5 件')
ok(av0.artifacts.map(a => a.pos).join(',') === '1,2,3,4,5', '位置按 1花2羽3沙4杯5头 映射')
ok(av0.artifacts[0].level_raw === 21, 'level 存原始值（不在这儿归一化）')
ok(av0.artifacts.every(a => a.name_hash) && new Set(av0.artifacts.map(a => a.name_hash)).size === 5,
  '5 件的部件名文案 key 各不相同')
ok(new Set(av0.artifacts.map(a => a.set_hash)).size === 1,
  '同一套的 5 件共用同一个套装名文案 key',
  `实际 ${JSON.stringify(av0.artifacts.map(a => a.set_hash))}`)
ok(av0.artifacts[0].append_prop_ids.length === 4, 'append_prop_ids 条数正确')
/* 词条数是内核按 key 分组数出来的（ArtisAttr 里 tmp[key].upNum++），
   同一次 key 的多次 roll 可能是不同的 id（id 里编了数值档位），
   所以这里真正要守的是「原样保留每一次 roll，不许聚合、不许去重」 */
const cdmgRolls = av0.artifacts[0].append_prop_ids.filter(id => artiMeta.attrIdMap[id]?.key === 'cdmg')
ok(cdmgRolls.length === 3, '同 key 的多次 roll 一条不少（这是词条数的唯一来源）',
  `实际 ${JSON.stringify(av0.artifacts[0].append_prop_ids)}`)
const 中文字 = JSON.stringify(ingested.avatars)
ok(!/[\u4e00-\u9fa5]/.test(中文字), '库行里没有中文名（存储层只存 id）',
  (中文字.match(/[\u4e00-\u9fa5]+/) || [])[0])

/* ---------------- 5. 落库 + 读回 ---------------- */

console.log('\n=== 3. 落库 → 读回（JSON 序列化不丢东西）===')
const db = openDb(':memory:')
repo.saveFetch(db, { ...ingested, stamp: '2026-01-01T00:00:00.000Z' })

const back = repo.loadUid(db, ingested.uid)
ok(back.account?.nickname === '测试号', '账号读回正确')
ok(back.avatars.length === 1, '角色读回正确')

const a0 = back.avatars[0]
const g0 = av0.artifacts[0]
const b0 = a0.artifacts[0]
ok(JSON.stringify(b0.append_prop_ids) === JSON.stringify(g0.append_prop_ids),
  'append_prop_ids 读回逐字一致（含顺序与每一次 roll）',
  `写入 ${JSON.stringify(g0.append_prop_ids)}\n        读回 ${JSON.stringify(b0.append_prop_ids)}`)
ok(b0.main_prop_id === g0.main_prop_id && b0.item_id === g0.item_id && b0.level_raw === g0.level_raw,
  '主词条 id / 部件 id / level 读回一致')
ok(JSON.stringify(a0.skill_level_map) === JSON.stringify(av0.skill_level_map), '天赋表读回一致')
ok(b0.name_hash === g0.name_hash && b0.set_hash === g0.set_hash,
  '文案 key 读回一致（没有它，多语言就得重新抓一遍 enka）')
ok(a0.weapon_name_hash === av0.weapon_name_hash, '武器文案 key 读回一致')

/* ---------------- 6. 两条路算出的分必须一样 ---------------- */

console.log('\n=== 4. 过库 vs 不过库，分数必须一致 ===')
const scoreOf = (row) => {
  const p = toMiaoProfile(row)
  return p ? ArtisMark.getMarkDetail(p, true) : null
}
const viaDb = scoreOf(a0)
const direct = scoreOf(av0)
ok(!!viaDb, '能算出分（角色被 miao 认识、圣遗物解析成功）')
ok(viaDb?.mark === direct?.mark, `过库得分 ${viaDb?.mark} == 直接得分 ${direct?.mark}`)
ok(viaDb?.classTitle === direct?.classTitle, `场景一致：${viaDb?.classTitle}`)
ok(viaDb?.artis['1']?.main?.key === 'hpPlus',
  '花的主词条是 hpPlus（小生命），标定 key 约定正确',
  `实际 ${viaDb?.artis['1']?.main?.key}`)
ok(viaDb?.artis['1']?.attrs?.[0]?.upNum === 3,
  '副词条词条数 = 同 key 的 roll 次数（3）',
  `实际 ${viaDb?.artis['1']?.attrs?.[0]?.upNum}`)
ok(viaDb?.artis['1']?.main?.value === '4,778.6',
  '满级小生命主词条 = 4,778.6（顺带验证 level 21→20 归一化对了；千分位对齐 miao 的结果图）',
  `实际 ${viaDb?.artis['1']?.main?.value}`)

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
const merged = repo.listAvatarIds(db, ingested.uid)
ok(merged.length === 2, `两次抓取各拿 1 个角色 → 库里累计 2 个（实际 ${merged.length}）`,
  `实际 ${JSON.stringify(merged)}`)
ok(merged.includes(10000046), '第二次没抓到的胡桃仍在库里')
ok(repo.lastFetch(db, ingested.uid)?.fetched_at === '2026-01-02T00:00:00.000Z', '抓取流水记到最后一次')

/* ---------------- 8. 重复抓取幂等 ---------------- */

console.log('\n=== 6. 同一份数据抓两次，结果不变 ===')
repo.saveFetch(db, { ...ingested, stamp: '2026-01-03T00:00:00.000Z' })
const again = scoreOf(repo.loadAvatar(db, ingested.uid, 10000046))
ok(again.mark === viaDb.mark, `重复抓取后分数不变（${again.mark}）`)
ok(repo.listAvatarIds(db, ingested.uid).length === 2, '重复抓取不会新增重复行')

/* ---------------- 9. 脏数据不炸 ---------------- */

console.log('\n=== 7. 脏数据要能扛住 ===')
const dirty = structuredClone(payload)
dirty.avatarInfoList[0].equipList.push({
  itemId: 999999, flat: { equipType: 'EQUIP_BRACER', rankLevel: 5 },
  reliquary: { level: 21, mainPropId: mainIdOf('hpPlus'), appendPropIdList: [] }
})
let dirtyScore = null
let dirtyThrew = false
try {
  dirtyScore = scoreOf(ingestPayload(dirty, { source: 'enka' }).avatars[0])
} catch (e) {
  dirtyThrew = true
  console.log('        ' + e.message)
}
ok(!dirtyThrew, '认不出的部件 id 不会抛异常')
ok(!!dirtyScore, '脏数据仍能算出分（坏的那件跳过）')

const unknownChar = { ...structuredClone(payload), avatarInfoList: [{ avatarId: 999999999, propMap: {}, equipList: [] }] }
ok(toMiaoProfile(ingestPayload(unknownChar, { source: 'enka' }).avatars[0]) === null,
  'miao 不认识的角色返回 null，不抛异常')

/* ---------------- 10. 老库升级 ---------------- */
/*
 * 已经落地的库是 v1（没有那三列文案 key），CREATE TABLE IF NOT EXISTS 不会给
 * 老表补列，全靠 db.js 里的 ALTER 迁移。这段就是守住那条路：
 * 造一个「v1 形状的库」，再打开，必须自动补齐且老数据一条不丢。
 */

console.log('\n=== 8. 老库（v1）能自动升到 v2，数据不丢 ===')

const cols = (d, table) => d.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name)

const tmpDb = path.join('.tmp', 'pipeline-migrate.db')
for (const suffix of ['', '-wal', '-shm']) fs.rmSync(tmpDb + suffix, { force: true })

/* 先建一个正常的新库，写好一行数据 */
let d = openDb(tmpDb)
ok(cols(d, 'artifact').includes('name_hash'), '新库直接就有 name_hash 列')
repo.saveFetch(d, { ...ingested, stamp: '2026-01-01T00:00:00.000Z' })

/* 手工退回 v1：删掉那三列、版本号改回 1 */
d.exec('ALTER TABLE artifact DROP COLUMN name_hash')
d.exec('ALTER TABLE artifact DROP COLUMN set_hash')
d.exec('ALTER TABLE avatar DROP COLUMN weapon_name_hash')
d.exec('PRAGMA user_version = 1')
ok(!cols(d, 'artifact').includes('name_hash'), '已退回 v1 形状（确实没这列了）')
d.close()

/* 重新打开 → 应该自动补列 */
d = openDb(tmpDb)
ok(cols(d, 'artifact').includes('name_hash') && cols(d, 'artifact').includes('set_hash'),
  '打开老库时自动补上 artifact 的两列')
ok(cols(d, 'avatar').includes('weapon_name_hash'), '自动补上 avatar 的 weapon_name_hash')
ok(d.prepare('PRAGMA user_version').get().user_version === SCHEMA_VERSION,
  `user_version 升到 ${SCHEMA_VERSION}`)

const after = repo.loadUid(d, ingested.uid)
ok(after.avatars.length === 1 && after.avatars[0].artifacts.length === 5,
  '升级后老数据一条不丢（1 个角色 5 件圣遗物）')
const stillScores = scoreOf(after.avatars[0])
ok(stillScores?.mark === viaDb.mark, `升级后照旧能算出同一个分（${stillScores?.mark}）`)
ok(after.avatars[0].artifacts[0].name_hash === null, '老行补出来的新列是 NULL（不是 0，也别拿 0 充数）')
d.close()

for (const suffix of ['', '-wal', '-shm']) fs.rmSync(tmpDb + suffix, { force: true })

/* ---------------- 11. 文案 key 清单 ---------------- */

console.log('\n=== 9. 文案 key 清单（将来接多语言翻译表照着要）===')
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

console.log('\n=== 10. 真实数据端到端（含面板对拍）===')
const realRaw = JSON.parse(fs.readFileSync(path.join('test', 'data', 'enka-real.json'), 'utf8'))
const realIn = ingestPayload(realRaw, { source: 'enka' })
const realDb = openDb(':memory:')
repo.saveFetch(realDb, { ...realIn, stamp: '2026-01-04T00:00:00.000Z' })
const realBack = repo.loadUid(realDb, realIn.uid)

ok(realBack.avatars.length === 3, `真实响应 3 个角色全部入库（实际 ${realBack.avatars.length}）`)
ok(realBack.avatars.every(a => a.artifacts.length === 5 || a.artifacts.length === 0),
  '每件圣遗物都落在 1~5 号位')

const profileById = new Map()
for (const row of realBack.avatars) {
  const p = toMiaoProfile(row)
  if (p) profileById.set(row.avatar_id, p)
}
ok(profileById.size === 3, '3 个角色 miao 都认识')

const cmp = diffPanels(realRaw, profileById)
ok(cmp.list.length === 3, '3 个角色都能对拍（都有 fightPropMap）')
ok(cmp.ok,
  `游戏面板 vs miao 计算面板：全部对上（最大偏差 ${(cmp.worst.rel * 100).toFixed(4)}% 出现在 ${cmp.worst.key}）`,
  cmp.list.flatMap(d => d.rows.filter(r => !r.ok)
    .map(r => `${d.name}.${r.key}: 游戏 ${r.game} vs 我们 ${r.ours}（差 ${(r.rel * 100).toFixed(4)}%）`)).join('\n        '))

/* 顺带用真实数据锚一个数值：迪卢克的满级 5★ 暴击伤害冠 = 62.2%
   这一条同时证明 level 21→20 的归一化在真实数据上也对（错了会变 59.5） */
const diluc = realBack.avatars.find(a => a.avatar_id === 10000016)
const dilucMark = diluc ? scoreOf(diluc) : null
ok(dilucMark?.artis['5']?.main?.value === '62.2%',
  '真实数据锚点：迪卢克暴伤冠主词条 = 62.2%（level 归一化在真实数据上也对）',
  `实际 ${dilucMark?.artis['5']?.main?.value}`)

const realKeys = repo.listTextKeys(realDb)
ok(realKeys.hash.length > 10, `真实数据带下来 ${realKeys.hash.length} 个官方文案 key`)

/* ---------------- 11. 默认兜底必须在表现层可见 ----------------
 * 背景：上游权重表 artis-mark.js 不是每个角色都有。查不到时内核拿通用表兜底，
 * 但标题照旧拼 `${char.abbr}-通用` —— 于是「沃雅妮莎」显示成「妮莎-通用」，
 * 看着像上游真给她定过一套权重，实际那张表根本没这一行。
 * 这里钉住两件事：内核要标出 isDefaultWeight，view 层要把它换成「默认-通用」。
 * ⚠️ 两侧都要有对照组：只测兜底角色的话，哪天内核改成永远返回 true 也会全绿。 */
console.log('\n=== 11. 默认兜底在表现层可见 ===')

const { usefulAttr } = await import('../vendor/miao/resources/meta-gs/artifact/artis-mark.js')
const { classTitleOf } = await import('../src/view/shape.js')

/* ⚠️ 必须用 getCfg（不是 getCharArtisCfg）：classTitleOf 读的是 getCfg 的 `classTitle` 字段，
   而 getCharArtisCfg 的字段叫 `title`。生产链路上 shapeCharacter 拿到的就是 getCfg 的结果。
   顺带这一步把 attrs 那些计算也跑完了，跟真实链路一致。 */
const cfgOf = (name) => {
  const char = Character.get(name)
  if (!char) return null
  const profile = {
    char, game: 'gs', weapon: { name: '', affix: 1 }, elem: char.elem,
    attr: {}, cons: 0, artis: { is: () => false }
  }
  return ArtisMarkCfg.getCfg(profile)
}

/* 兜底组的找法：**角色名单减去权重表里的键**。
   ⚠️ 不是「表里值为空的键」—— 那张表每个键都有值，兜底角色是**整行不存在**
   （`usefulAttr[char.name]` 返回 undefined）。两个查法看起来像，含义完全不同。
   名单直接读 character/data.json（Meta.getMeta('gs','char') 只有 wifeData，取不到名单）。 */
const charData = JSON.parse(fs.readFileSync(
  path.resolve(import.meta.dirname, '..', 'vendor/miao/resources/meta-gs/character/data.json'), 'utf8'))
const allNames = Object.values(charData).map((c) => c.name).filter(Boolean)

/* 剔掉两类「本来就不该进这张表」的角色，否则测试的对照组是假的：
   ① 主角（空/荧）—— Character.get 认得它们，但内核按 isTraveler 走另一条分支，
      标题前缀是「风主/岩主」而不是查表得来的，abbr 也不来自这张表；
   ② 奇偶·男性/奇偶·女性 —— 主角的「双性别」占位，data.json 里有、元数据里没有对应项。 */
const isTravelerOrAlias = (n) => /旅行者|主角|^[空荧]$/.test(n) || n.startsWith('奇偶·')
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
   2026-10-06 同步补进沃雅妮莎/薇斯纳之后，fallbackChars 就空了，上面那个循环
   一次都不跑，兜底分支从此无人看守（哪天内核把 isDefaultWeight 传错也全绿）。
   所以这里**构造**一个表里查不到的角色，把这条分支钉死。 */
const fakeName = '__不存在的角色__'
ok(!usefulAttr[fakeName], `构造：${fakeName} 确实不在权重表里（兜底前提）`)
{
  /* 抄一个真实角色，只把 name 换成表里没有的 —— 内核只拿 char.name 去查表，
     这样 usefulAttr[char.name] 就是 undefined，稳定落到通用兜底。
     ⚠️ 不能用 Object.assign 覆盖：Character 的 id/name/abbr 都是**只读 getter**
     （定义在 metaKey 生成的属性上），assign 会抛 TypeError。 */
  const real = Character.get(knownChars[0])
  const fakeChar = Object.create(Object.getPrototypeOf(real))
  Object.assign(fakeChar, real)
  for (const [k, v] of Object.entries({ id: real.id, name: fakeName, abbr: '假角色' })) {
    Object.defineProperty(fakeChar, k, { value: v, writable: true, configurable: true })
  }
  const cfg = ArtisMarkCfg.getCfg({
    char: fakeChar, game: 'gs', weapon: { name: '', affix: 1 }, elem: fakeChar.elem,
    attr: {}, cons: 0, artis: { is: () => false }
  })
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
const hasOwnRule = (n) => fs.existsSync(path.resolve(import.meta.dirname, '..',
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
  const ATTR = { hp: 20000, atk: 2000, def: 1000, cpct: 20, cdmg: 50, mastery: 20, recharge: 100 }
  const cfgOf = (name) => {
    const char = Character.get(name)
    return char
      ? ArtisMarkCfg.getCfg({ char, game: 'gs', weapon: { name: '', affix: 1 }, elem: char.elem, attr: { ...ATTR }, cons: 0, artis: { is: () => false } })
      : null
  }
  const d = cfgOf('迪希雅')
  ok(d?.isCustomWeight === true && d?.isDefaultWeight === false,
    '迪希雅：内核标出 isCustomWeight（专属规则默认分支手写了权重）')
  ok(classTitleOf(d) === '自定义-通用', `迪希雅页面显示「${classTitleOf(d)}」`)
  ok(d && d.charWeightDiff === undefined, '内核不额外暴露 diff 字段（只给布尔标记）')

  for (const n of ['七七', '神里绫华', '迪卢克', '砂糖', '温迪']) {
    const c = cfgOf(n)
    ok(c && c.isCustomWeight === false && c.isDefaultWeight === false,
      `${n}：两个标记都为 false（默认分支照抄权重表）`)
    ok(classTitleOf(c) === c.classTitle, `${n}：标题原样透传（${c?.classTitle}）`)
  }
  /* 特判分支：内核就不该标 isCustomWeight（标题已自带场景名） */
  const klee = Character.get('可莉') && ArtisMarkCfg.getCfg({
    char: Character.get('可莉'), game: 'gs', weapon: { name: '', affix: 1 },
    elem: Character.get('可莉').elem,
    attr: { ...ATTR, cpct: 40, cdmg: 180 }, cons: 0, artis: { is: () => false }
  })
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
console.log('\n=== 12. 面板属性表：三种加成只按权重表出行 ===')

const { attrTableOf } = await import('../src/view/shape.js')
const panelOfFake = (attr, w = {}, elem = '') => attrTableOf({ attr, base: {} }, 'chs', w, elem)
const DMG3 = ['dmg', 'phy', 'heal']
const baseLen = 7   /* ATTR_TABLE 的固定行数 */
const dmgRowsOf = (rows) => rows.filter((r) => DMG3.includes(r.key))

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
  const nameOf = (k) => rows.find((r) => r.key === k)?.label
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
  const nameOf = (k) => rows.find((r) => r.key === k)?.label
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
  const weightOf = (k) => rows.find((r) => r.key === k)?.weight
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
console.log('\n=== 13. 百分比的显示舍入（float32 噪声 / 半分界）===')
const { attrValueText } = await import('../src/view/shape.js')
{
  /* [key, 内核已格式化好的串, 内核的裸数字, 期望] —— 裸数字都是真实档位算出来的原值 */
  const cases = [
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
  const cases = [
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
  /* 拿不到裸数字（汇总过的串、CLI 那些老调用方）时原样用内核的串 —— 不许瞎猜 */
  ok(attrValueText('hp', '5.2%') === '5.2%', '没有裸数字 → 原样用内核的串（不猜）')
  ok(attrValueText('hp', '') === '', '空值原样返回')
}
{
  /* 面板同一条口径 —— 否则卡片 5.3%、面板 5.2%，同一页自己打自己 */
  const rows = attrTableOf({ attr: { cpct: 5.249999836087227 }, base: {} }, 'chs', {})
  ok(rows.find((r) => r.key === 'cpct')?.value === '5.3%', '面板百分比同口径 → 5.3%')
}

console.log(`\n结果：通过 ${passed} 项，失败 ${failed} 项`)
process.exit(failed > 0 ? 1 : 0)

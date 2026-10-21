/*
 * 服务测试 —— 起一个真监听的服务，用真 HTTP 请求打它
 *
 * 不 mock http：这个文件的目的是证明「路由 / 静态文件 / 错误形状 / 本地化出口」
 * 这几件事在真网络栈上是通的。用内存库 + 一份真实 enka 响应播种，
 * 所以断言里可以直接出现「Diluc」「Crimson Witch of Flames」这种真数据。
 *
 * 与 pipeline.ts 的分工：pipeline 管「数据有没有被搞坏」，本文件管「接口给的东西对不对」。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/* 别叫 eq：本文件的 eq() 是断言助手（逐字段比 JSON） */
import { eq as sqlEq } from 'drizzle-orm'

import { startServer } from '../src/server/index.ts'
import * as repo from '../src/config/store.ts'
import { character as characterT, fetchLog as fetchLogT } from '../src/config/schema.ts'
import { ingestPayload } from '../src/upstream/enka-account.ts'
import { buildAdvice, ADVICE_RULES } from '../src/service/account.service.ts'
import type { EnkaPayload } from '../src/domain/enka.ts'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REAL = JSON.parse(fs.readFileSync(path.join(HERE, 'data', 'enka-real.json'), 'utf8'))

let failed = 0
let passed = 0
function ok (cond: unknown, label: string, extra = ''): void {
  console.log(`${cond ? '[PASS]' : '[FAIL]'} ${label}` + (cond || !extra ? '' : `\n        ${extra}`))
  cond ? passed++ : failed++
}
function eq (a: unknown, b: unknown, label: string): void {
  const same = JSON.stringify(a) === JSON.stringify(b)
  ok(same, label, same ? '' : `期望 ${JSON.stringify(b)} 实际 ${JSON.stringify(a)}`)
}

/* 播种：把真实响应过一遍 ingest 落进内存库 */
const summary = ingestPayload(REAL, { source: 'enka' })
/* 夹具是真实响应，uid 必然在（ingest 那边找不到就直接抛了）—— 后面到处拿它拼 URL / 查库。 */
const UID = summary.account.uid!

const app = await startServer({ port: 0, dbFile: ':memory:' })
repo.saveFetch(app.db, { ...summary, stamp: '2026-09-13T00:00:00.000Z' })

const get = (p: string): Promise<Response> => fetch(app.url + p)
/*
 * 接口返回的 JSON 体。`Response.json()` 在 Node 的类型里是 `Promise<unknown>`
 * （浏览器那套 lib.dom 才标 any），而本文件是按字段名断言的 —— 与其每行断言一次，
 * 不如在**这一处**把「接口给的 JSON」收回 any。
 */
const readJson = (r: Response): Promise<any> => r.json()
const json = async (p: string): Promise<any> => readJson(await get(p))

/* ---------------- 1. 元信息 ---------------- */

console.log('=== 1. 元信息与健康检查 ===')
{
  const h = await json('/api/health')
  eq(h.ok, true, '/api/health 返回 ok')
  eq(h.data.uids, 1, '/api/health 报出 1 个 uid')

  const m = await json('/api/meta')
  const codes = m.data.locales.map((l: any) => l.code)
  ok(codes.includes('chs'), '语言表里有 chs')
  ok(codes.length >= 1, `语言表共 ${codes.length} 种：${codes.join(', ')}`)
  eq(m.data.defaultLocale, 'chs', '默认语言是 chs')

  /* 界面文字：前端靠这一份把按钮/标题都换掉，所以每种语言都得给全 */
  ok(m.data.ui && typeof m.data.ui === 'object', '/api/meta 带 ui 文案表')
  eq(m.data.ui.panelSection, '面板属性', 'chs 的界面文字是中文')
  ok(m.data.ui.fetchDone.includes('{n}'), 'fetchDone 带 {n} 占位符')

  const en = await json('/api/meta?locale=en')
  eq(en.data.ui.panelSection, 'Stats', 'locale=en 时界面文字跟着变')
  ok(en.data.ui.fetchDone.includes('{n}'), '英文版的占位符还在')

  /* 首页「按属性权重筛选」的选项：命中判据是该项权重不为 0，所以**只收权重表里真会出现的键**。
     键序钉在测试里：大/小词条（atk/atkPlus…）成对出现，一条只挂一个键，挂俩就是两颗筛出来一样的 chip */
  eq(m.data.weightOptions.map((o: any) => o.key).join(','),
    'hp,atk,def,mastery,cpct,cdmg,recharge,dmg,phy,heal', '权重筛选十项：生/攻/防/精 + 双暴 + 充能 + 三种加成（治疗垫底）')
  eq(m.data.weightOptions[0].label, '生命值', '生命值排第一')
  eq(m.data.weightOptions[9].label, '治疗加成', '治疗加成排最后')
  eq(m.data.weightOptions[4].label, '暴击率', 'chs 的选项名是中文（含暴击率/暴击伤害）')
  eq(m.data.weightOptions[5].label, '暴击伤害', '暴击伤害也进了选项')
  /* 「元素伤害加成」用官方全称：miao 那张表里这条叫「伤害增加」（它出图时的简称），
     跟物伤/治疗并列时看不出是哪个加成。这条钉死，别被上游同步改回去 */
  eq(m.data.weightOptions[7].label, '元素伤害加成', 'dmg 那条叫「元素伤害加成」不是「伤害增加」')
  eq(en.data.weightOptions[4].label, 'CRIT Rate', '英文下选项名跟着变')
  eq(en.data.weightOptions[7].label, 'Elemental DMG Bonus', '英文下也是全称（不是 miao 的 “DMG Bonus”）')
  /* ⚠️ 别在这儿断言「每个选项都有人命中」：测试库只有三四个角色，def / phy 这类冷门键必然 0 人
     （真实 57 人库里 def 3 人、phy 1 人）。键表来自权重表本身，不是来自某份名单。 */

  /* 认不出的语言要落回默认语言，不能给个空表让页面全是 key */
  const bogus = await json('/api/meta?locale=xx')
  eq(bogus.data.ui.panelSection, '面板属性', '未知语言回落到默认语言')
}

/* ---------------- 2. uid 列表 ---------------- */

console.log('\n=== 2. uid 列表 ===')
{
  const r = await json('/api/accounts')
  eq(r.data.length, 1, '/api/accounts 有 1 条')
  eq(r.data[0].uid, UID, 'uid 对得上')
  eq(r.data[0].avatarCount, summary.characterCount, '角色数与 ingest 一致')

  /* 抓取时间在**出口**转成本地时区文本（库里存的仍是 ISO UTC，见 view.ts 的 fmtTime）。
     断言刻意写成与时区无关 —— 换台机器跑也得过，所以拆成两条：
       ① 格式：没有 T/Z，就是「YYYY-MM-DD HH:mm:ss」
       ② 换算：把结果按本地时间解析回去，应当与库里那个 UTC 时刻**同一毫秒**
          （② 才是真验证时区换算，而且不用把 +8 写死） */
  const ft = r.data[0].fetchedAt
  ok(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(ft),
    'fetchedAt 是本地时间文本、不含 T/Z', `实际 ${JSON.stringify(ft)}`)
  eq(new Date(String(ft).replace(' ', 'T')).getTime(),
    new Date('2026-09-13T00:00:00.000Z').getTime(),
    'fetchedAt 换算回去与库里时刻是同一时刻')
}

/* ---------------- 3. 视图：中文 ---------------- */

console.log('\n=== 3. 视图（locale=chs）===')
let chsView = null
{
  const r = await json(`/api/accounts/${UID}?locale=chs`)
  chsView = r.data
  eq(r.data.count, summary.characterCount, '角色数一致')
  eq(r.data.locale, 'chs', '回显语言')
  eq(r.data.skipped, [], '没有被跳过的角色')
  ok(!!r.data.account.nickname, `账号昵称拿得到（${r.data.account.nickname}）`)

  const diluc = r.data.avatars.find((a: any) => a.nameZh === '迪卢克')
  ok(!!diluc, '能找到迪卢克')
  if (diluc) {
    eq(diluc.artifacts.length, 5, '圣遗物 5 个位置都在')
    ok(diluc.artifacts.every((a: any) => a.posName), '每个位置都有部位名')
    ok(diluc.panel.length > 0, `面板属性 ${diluc.panel.length} 项`)
    ok(diluc.sets.length > 0, `套装 ${diluc.sets.map((s: any) => s.name + '×' + s.count).join(' ')}`)
    /* 套装视图拿「花」（部位 1）那张部位图当整套的代表图，2+2 时两张各裁一半拼。
       钉死在 /1.webp：哪天改成别的部位，卡片上认套的线索就断了 */
    ok(diluc.sets.every((s: any) => /^assets\/meta-gs\/artifact\/imgs\/[^/]+\/1\.webp$/.test(s.icon || '')),
      '每个套装都带花的部位图', JSON.stringify(diluc.sets.map((s: any) => s.icon)))
    const withSubs = diluc.artifacts.filter((a: any) => !a.empty && a.subs.length)
    ok(withSubs.length > 0, '圣遗物带副词条')
    ok(withSubs.every((a: any) => a.subs.every((s: any) => s.upNum >= 1)),
      '副词条都带强化次数（内核靠重复次数算的，不能丢）')
    ok(!!diluc.weapon.name, `武器名 ${diluc.weapon.name}`)
  }

  /* 全局刷圣遗物建议：铺在整包视图里（不让前端多打一次请求）。
     夹具里三个人都是 Lv79，所以这份建议不该是空的。 */
  const adv = r.data.advice
  ok(!!adv, '整包视图带 advice')
  eq(adv.minLevel, 71, '建议口径：Lv≥71')
  /* 两种口径一次下发：`sets`（不含 SS，页面默认）与 `withSS`（含）。页面那个开关就切这两份，
     切换不走网络 —— 所以这里两块的形状都得在。 */
  eq(adv.includeSS, false, '主份是默认口径：「不含 SS 件」')
  ok(!!adv.withSS, '同一次下发里带着「含 SS」那份')
  eq(adv.withSS?.includeSS, true, '另一份口径是「含 SS 件」')
  ok(adv.sets.every((s: any) => [...s.bad, ...s.mid, ...s.good]
    .every((p: any) => p.markClass !== 'SS')), '默认那份的明细里没有 SS 件')
  ok(Array.isArray(adv.sets) && adv.sets.length > 0, `建议里有权重靠前的套装（${adv.sets?.length} 套）`)

  for (const s of adv.sets) {
    const c = s.count
    eq(c.total, c.bad + c.mid + c.good, `${s.nameZh} 件数守恒`)
    eq(s.bad.length, c.bad, `${s.nameZh} bad 明细条数对得上`)
    ok(c.owners >= 1, `${s.nameZh} 至少有 1 个人在穿`)
    /* 三档跟着内核的档位字母走：D/C/B | A/S | SS。
       别拿分数线重写一遍 —— 内核的线是 7/14/21/28/35/42/49/56，写成 21/42 就会
       把 SS（35~42）算进 A-S、把 SSS+ 算进 SS，正是这里要钉死的东西。 */
    const TIER_CLS: Record<string, string[]> = { bad: ['D', 'C', 'B'], mid: ['A', 'S'], good: ['SS'] }
    for (const tier of ['bad', 'mid', 'good']) {
      ok(s[tier].every((p: any) => TIER_CLS[tier].includes(p.markClass)),
        `${s.nameZh} ${tier} 档只收 ${TIER_CLS[tier].join('/')}`,
        JSON.stringify(s[tier].map((p: any) => p.markClass)))
    }
    /* SSS 及以上不统计：不算「还要刷」的需求，也不该让 SS 的件数虚高 */
    ok([...s.bad, ...s.mid, ...s.good].every((p: any) => !['SSS', 'ACE', 'MAX'].includes(p.markClass)),
      `${s.nameZh} 明细里没有 SSS 及以上的件`)
    /* 2 件以上才进统计（1 件不激活套装效果，是散件） */
    ok([...s.bad, ...s.mid, ...s.good].every((p: any) => p.setCount >= 2),
      `${s.nameZh} 明细都是凑到 2 件以上的`)
    ok([...s.bad, ...s.mid, ...s.good].every((p: any) => p.posName && p.name),
      `${s.nameZh} 明细都带角色名与部位名`)
    /* 初始词条条数：夹具是真 enka 响应，roll 与等级自洽，每件都该认得出 3 或 4 */
    ok([...s.bad, ...s.mid, ...s.good].every((p: any) => p.initSubs === 3 || p.initSubs === 4),
      `${s.nameZh} 每件都认得出初始 3/4 词条`,
      JSON.stringify([...s.bad, ...s.mid, ...s.good].map((p: any) => p.initSubs)))
  }
  /* 刷不出来的（4★ 套）沉底，且不影响 5★ 之间的分数排序 */
  const farmable = adv.sets.filter((s: any) => s.farmable)
  ok(farmable.every((s: any, i: number) => i === 0 || farmable[i - 1].score >= s.score),
    '可刷套装按 score 降序')

  /* 口径单测：直接喂假数据，绕开夹具 —— 夹具里的套装件数各不相同，
     混在一起根本分不开是哪一项在起作用。
     注意 mkPiece 只认 markClass，分数标得对不对不影响档位：三档只看字母。 */
  const mkPiece = (setNameZh: string, markValue: number, markClass: string, pos: number,
    initSubs: number | null = null) => ({
    empty: false, setNameZh, pos, posName: '生之花', markValue,
    mark: markValue.toFixed(1), markClass, star: 5, initSubs
  })
  const mkAvatar = (id: number, pieces: any[]) => ({
    avatarId: id, name: `角色${id}`, nameZh: `角色${id}`, level: 90,
    artifacts: pieces,
    sets: [...new Set(pieces.map(p => p.setNameZh))]
      .map(n => ({ nameZh: n, name: n, icon: null }))
  })
  const one = (avatars: any[], set = '靶套') =>
    buildAdvice(avatars, 'chs').sets.find((s: any) => s.nameZh === set)!

  /* ① 稀烂程度就是 Σ(42 − 单件分)：6.9 分贡献 35.1、30 分贡献 12 */
  const gapSet = one([mkAvatar(1, [mkPiece('靶套', 6.9, 'D', 1), mkPiece('靶套', 30, 'A', 2)])])
  ok(Math.abs(gapSet.gap - 47.1) < 1e-9, 'gap = Σ(42 − 单件分)', String(gapSet.gap))
  /* ② 档位只管展示分档，不进得分：同样的分数标 D 还是标 A，gap 必须一模一样。
     「越烂越优先」由差值本身表达，再叠一张档位权重表就是同一件事算两遍。 */
  ok(Math.abs(
    one([mkAvatar(1, [mkPiece('靶套', 20, 'D', 1), mkPiece('靶套', 20, 'D', 2)])]).gap -
    one([mkAvatar(1, [mkPiece('靶套', 20, 'A', 1), mkPiece('靶套', 20, 'A', 2)])]).gap) < 1e-9,
    '档位不影响得分（只是展示分档）')
  /* ③ 均值落差 = 这人的五件均值 − 最差件：(6.9+30+45×3)/5 − 6.9 = 27.5 */
  const dropSet = one([mkAvatar(1, [
    mkPiece('靶套', 6.9, 'D', 1), mkPiece('靶套', 30, 'A', 2),
    mkPiece('陪套', 45, 'SS', 3), mkPiece('陪套', 45, 'SS', 4), mkPiece('陪套', 45, 'SS', 5)
  ])])
  ok(Math.abs(dropSet.drop - 27.48) < 0.01, 'drop = 覆盖角色的（五件均值 − 最差件）平均',
    String(dropSet.drop.toFixed(2)))

  /* ④ 核心：score 必须是**四项加权和**，不是连乘。
     这里用测试侧独立实现一遍归一化与求和，逐个比对 —— 一旦有人改回
     「缺口 × 弹性 × 人数」那种连乘，这些断言立刻红。
     夹具里特意给两套不同的初始词条配比（甲 1/3 三词条、乙 2/4），否则 rough 项恒 0，等于没测。 */
  const three = buildAdvice([
    mkAvatar(1, [mkPiece('甲套', 6.9, 'D', 1, 3), mkPiece('甲套', 30, 'A', 2, 4),
      mkPiece('x', 45, 'SS', 3), mkPiece('x', 45, 'SS', 4), mkPiece('x', 45, 'SS', 5)]),
    mkAvatar(2, [mkPiece('乙套', 20, 'D', 1, 3), mkPiece('乙套', 26, 'A', 2, 3),
      mkPiece('y', 30, 'A', 3), mkPiece('y', 30, 'A', 4), mkPiece('y', 30, 'A', 5)]),
    mkAvatar(3, [mkPiece('乙套', 18, 'D', 1, 4), mkPiece('乙套', 26, 'A', 2, 4),
      mkPiece('z', 35, 'S', 3), mkPiece('z', 35, 'S', 4), mkPiece('z', 35, 'S', 5)])
  ] as any, 'chs')
  const W = ADVICE_RULES.weight
  const maxOf = (f: (s: any) => number) => Math.max(...three.sets.map(f)) || 1
  const mGap = maxOf(s => s.gap)
  const mOwn = maxOf(s => s.count.owners)
  const mDrop = maxOf(s => s.drop)
  const mRough = maxOf(s => s.rough)
  for (const s of three.sets) {
    const want = W.gap * (s.gap / mGap) + W.owners * (s.count.owners / mOwn) +
      W.drop * (s.drop / mDrop) + W.rough * (s.rough / mRough)
    ok(Math.abs(s.score - want) < 1e-9,
      `score 是四项加权和（${s.nameZh}）`, `${s.score.toFixed(4)} vs ${want.toFixed(4)}`)
  }
  /* ⑤ 权重加起来必须是 1，否则 score 不再是「四项各占几成」 */
  ok(Math.abs(W.gap + W.owners + W.drop + W.rough - 1) < 1e-9, '四项权重之和为 1',
    String(W.gap + W.owners + W.drop + W.rough))

  /* ⑥ 初始三词条占比 = 三词条件的件数 ÷ 认得出的件数。
     认不出的件（initSubs 不是 3/4）两边都不算 —— 否则「不知道」会被当成「四词条」稀释掉。 */
  const roughSet = one([mkAvatar(1, [
    mkPiece('靶套', 20, 'D', 1, 3),
    mkPiece('靶套', 20, 'D', 2, 4),
    mkPiece('靶套', 20, 'D', 3, null),
    mkPiece('靶套', 20, 'D', 4, 3)
  ])])
  ok(Math.abs(roughSet.rough - 2 / 3) < 1e-9, 'rough = 三词条件 ÷ 认得出的件（未知不进分母）',
    `${roughSet.rough} vs ${(2 / 3).toFixed(4)}`)

  /* ⑦ 不含 SS 的口径：SS 件整件摘掉 —— 不进明细、不产生缺口、不算人头、不进初始词条。
     40 分那件 SS 含进去时贡献 42−40=2 的缺口，摘掉后 gap 只剩 A 那件的 12。 */
  const ssMix = [mkAvatar(1, [mkPiece('靶套', 40, 'SS', 1, 3), mkPiece('靶套', 30, 'A', 2, 4),
    mkPiece('陪套', 45, 'SS', 3), mkPiece('陪套', 45, 'SS', 4), mkPiece('陪套', 45, 'SS', 5)])]
  const ssIn = buildAdvice(ssMix as any, 'chs').sets.find((s: any) => s.nameZh === '靶套')!
  const ssOut = buildAdvice(ssMix as any, 'chs', { includeSS: false })
    .sets.find((s: any) => s.nameZh === '靶套')!
  ok(Math.abs(ssIn.gap - 14) < 1e-9, '含 SS 时 gap 把 SS 件也算进去', String(ssIn.gap))
  ok(Math.abs(ssOut.gap - 12) < 1e-9, '不含 SS 时 gap 只剩非 SS 件的缺口', String(ssOut.gap))
  ok(ssOut.bad.concat(ssOut.mid, ssOut.good).every((p: any) => p.markClass !== 'SS'),
    '不含 SS 时明细里没有 SS 件')
  /* 「凑齐 2 件」那道门仍按**身上实穿**的件数判：一件 SS + 一件 A 也算凑齐了，
     只是 SS 那件在后面各项统计里不算数（所以这里 total 是 1 而不是整条消失）。 */
  eq(ssOut.count.total, 1, '身上穿 2 件（1 SS + 1 A）→ 套装仍在，明细只剩 1 件')
  /* 两件都是 SS 的套装：不含 SS 的这份里一件都不剩，整条不列 */
  const allSS = [mkAvatar(1, [mkPiece('全SS套', 38, 'SS', 1), mkPiece('全SS套', 39, 'SS', 2)])]
  ok(buildAdvice(allSS as any, 'chs').sets.some((s: any) => s.nameZh === '全SS套'),
    '含 SS 时有「全SS套」')
  ok(!buildAdvice(allSS as any, 'chs', { includeSS: false })
    .sets.some((s: any) => s.nameZh === '全SS套'), '不含 SS 时「全SS套」一条都不剩')

  /* 角色级数据时间：明细页靠它说「这个角色什么时候同步的」，不能拿 UID 级时间冒充 ——
     展柜是分批攒的，角色之间能差好几天。这里把迪卢克的时间改成一个明显不同的时刻，
     再请求一次：角色级要跟着变，UID 级（来自 fetch_log）必须纹丝不动。
     注意夹具里所有角色共用同一个 stamp，所以「改了迪卢克、其它人不变」才算真证明。 */
  const seed = '2026-01-02T03:04:05.000Z'
  app.db.update(characterT).set({ fetchedAt: seed }).where(sqlEq(characterT.avatarId, diluc.avatarId)).run()
  const again = (await json(`/api/accounts/${UID}?locale=chs`)).data
  const d2 = again.avatars.find((a: any) => a.avatarId === diluc.avatarId)
  ok(!!d2?.fetchedAt, '角色视图带自己的数据时间')
  eq(new Date(String(d2?.fetchedAt).replace(' ', 'T')).getTime(), new Date(seed).getTime(),
    '角色时间是它自己那次同步的时刻（character.fetched_at）')
  ok(again.avatars.filter((a: any) => a.avatarId !== diluc.avatarId)
    .every((a: any) => a.fetchedAt !== d2?.fetchedAt),
    '同 UID 的其它角色不受影响（各是各的时间）')
  eq(again.fetchedAt, chsView.fetchedAt,
    'UID 级时间不变（它来自 fetch_log，与 character 表无关）')
}

/* ---------------- 4. 视图：其它语言（这一层是本次的重点）---------------- */

console.log('\n=== 4. 视图（en / ja / cht）===')
{
  const en = (await json(`/api/accounts/${UID}?locale=en`)).data
  const diluc = en.avatars.find((a: any) => a.nameZh === '迪卢克')
  if (chsView && en.locale === 'en') {
    ok(diluc && diluc.name !== diluc.nameZh,
      `英文名下不再是中文（${diluc?.name}）`, `得到 ${diluc?.name}`)
    ok(diluc.artifacts.every((a: any) => a.posName && !/[\u4e00-\u9fff]/.test(a.posName)),
      '英文下部位名不含汉字', JSON.stringify(diluc.artifacts.map((a: any) => a.posName)))
    const set = diluc.sets[0]
    ok(set && set.name !== set.nameZh, `英文套装名（${set?.name}）`)
    const subKeys = diluc.artifacts.flatMap((a: any) => a.subs.map((s: any) => s.label))
    ok(subKeys.length > 0 && subKeys.every((t: any) => !/[\u4e00-\u9fff]/.test(t)),
      '英文下词条名不含汉字', JSON.stringify(subKeys.slice(0, 4)))
  } else {
    console.log(`  （语言表里没有 en，跳过英文断言 —— 先跑 tools/sync_i18n.py）`)
  }

  const ja = (await json(`/api/accounts/${UID}?locale=ja`)).data
  ok(ja.locale === (ja.locale === 'ja' ? 'ja' : 'chs'), 'ja 认得出或退回 chs')

  const cht = (await json(`/api/accounts/${UID}?locale=CHT`)).data
  ok(cht.locale === 'cht' || cht.locale === 'chs', '大小写混写（CHT）也能认')
}

/* ---------------- 5. 语言退回与别名 ---------------- */

console.log('\n=== 5. 语言归一 ===')
{
  const alias = (await json(`/api/accounts/${UID}?locale=zh-cn`)).data
  eq(alias.locale, 'chs', 'zh-cn → chs')
  const weird = (await json(`/api/accounts/${UID}?locale=klingon`)).data
  eq(weird.locale, 'chs', '认不出的语言退回默认')
}

/* ---------------- 6. 错误形状 ---------------- */

console.log('\n=== 6. 错误形状 ===')
{
  /* 格式合法但库里没有 → 404。注意别用 999999 这种短号：位数不对会先被 bad_uid 拦在 400，
     测的就不是「查不到」了。UID 合法 = 9 位且首位非 0。 */
  const r404 = await get(`/api/accounts/999999999`)
  eq(r404.status, 404, '库里没有的 uid → 404')
  const b404 = await readJson(r404)
  eq(b404.ok, false, '失败响应带 ok:false')
  eq(b404.error.code, 'no_data', '错误码 no_data')
  ok(!!b404.error?.code && !!b404.error?.message, `错误体有 code/message（${b404.error?.code}）`)

  /* 两层拦截各管一段：
     - 非数字 → 路由正则 `[0-9]+` 匹配不上 → 404
     - 全是数字但位数/首位不对 → 匹配上了路由，控制器回 400 bad_uid */
  const rBad = await fetch(`${app.url}/api/accounts/not-a-number/refresh`, { method: 'POST' })
  eq(rBad.status, 404, 'uid 不是数字 → 404（路径匹配不上）')

  for (const bad of ['999999', '0123456789', '12345678901']) {
    const r = await get(`/api/accounts/${bad}`)
    eq(r.status, 400, `uid 位数不对（${bad}）→ 400`)
    eq((await readJson(r)).error.code, 'bad_uid', `uid 位数不对（${bad}）→ bad_uid`)
  }

  /* 方法对不上也没有路由：账号详情是只读的，POST 它不属于任何接口 */
  const rMethod = await fetch(`${app.url}/api/accounts/${UID}`, { method: 'POST' })
  eq(rMethod.status, 404, '方法对不上 → 404')

  const rNo = await get('/api/nope')
  eq(rNo.status, 404, '不存在的接口 → 404')
}

/* ---------------- 7. 抓取（注入假 enka，不联网）---------------- */

console.log('\n=== 7. POST /api/accounts/:uid/refresh（用假 enka，不联网）===')
{
  const app2 = await startServer({
    port: 0,
    dbFile: ':memory:',
    fetchImpl: async (uid) => ({ ...REAL, uid })
  })
  /* 刷新不要请求体：uid 在路径里、locale 在 query 里 */
  const res = await fetch(`${app2.url}/api/accounts/${UID}/refresh?locale=chs`, { method: 'POST' })
  const body = await readJson(res)
  eq(res.status, 200, '抓取成功')
  eq(body.meta.fetched, summary.characterCount, 'meta.fetched 是本轮抓到的角色数')
  eq(body.data.count, summary.characterCount, '抓完直接能返回视图')
  ok(repo.listUids(app2.db).includes(UID), '抓完数据确实落库了')

  /* 上游报错要变成 502 + 人话，而不是 500 堆栈 */
  /* app4：同一个实例先成功一次、再失败一次 —— 钉死两件事：
     ① 失败也要记流水（ok=0 + 错误原文），以前失败零留痕，上游抖动没法追溯；
     ② 「最后抓取」只认成功 —— 失败时刻不算数据变新，否则页面显示骗人的新鲜度。 */
  let calls = 0
  const app4 = await startServer({
    port: 0, dbFile: ':memory:',
    fetchImpl: async (uid) => {
      if (calls++ > 0) throw new Error('enka: 查不到这个 UID')
      return { ...REAL, uid }
    }
  })
  eq(repo.lastFetch(app4.db, UID), null, '没成功抓取过就没有最后抓取时间')
  const r4ok = await fetch(`${app4.url}/api/accounts/${UID}/refresh?locale=chs`, { method: 'POST' })
  eq(r4ok.status, 200, '同实例第一次抓取成功')
  const okStamp = repo.lastFetch(app4.db, UID)!.fetchedAt
  const r4 = await fetch(`${app4.url}/api/accounts/${UID}/refresh`, { method: 'POST' })
  eq(r4.status, 502, 'enka 业务错误 → 502')
  eq((await readJson(r4)).error.message, 'enka: 查不到这个 UID', '错误原文透传给人看')
  const failRows = app4.db.select({ uid: fetchLogT.uid, note: fetchLogT.note })
    .from(fetchLogT).where(sqlEq(fetchLogT.ok, 0)).all()
  eq(failRows.length, 1, '失败也记一行流水（ok=0）')
  eq(failRows[0].uid, UID, '失败流水记的是这个 uid')
  eq(failRows[0].note, 'enka: 查不到这个 UID', '失败流水带上错误原文')
  eq(repo.lastFetch(app4.db, UID)!.fetchedAt, okStamp, '最后抓取只认成功：失败不刷新数据新鲜度')
  app4.server.close()
  app2.server.close()
}

/* ---------------- 8. 静态页与目录穿越 ---------------- */

console.log('\n=== 8. 静态文件 ===')
{
  const r = await get('/')
  eq(r.status, 200, '/ 返回 200')
  ok((r.headers.get('content-type') || '').includes('text/html'), '内容是 html')
  const html = await r.text()
  ok(html.includes('星天水镜'), '页面里有标题')
  /* 引用写成**相对路径**（不是 /bootstrap.js）：GitHub Pages 的项目站挂在 /<repo>/ 下，
     写成根绝对路径会指到域名根去，页面直接白屏。这条钉住这个部署前提。 */
  ok(html.includes('src="bootstrap.js"') && html.includes('href="style.css"'), '页面引了脚本和样式（相对路径）')

  const js = await get('/bootstrap.js')
  ok((js.headers.get('content-type') || '').includes('javascript'), 'js 的 content-type 对')
  ok((await js.text()).length > 500, 'js 不是空文件')

  const css = await get('/style.css')
  ok((css.headers.get('content-type') || '').includes('text/css'), 'css 的 content-type 对')

  /* 越界（目录穿越）与不存在的文件一律 404 —— 顺带就没有目录穿越这回事 */
  for (const p of ['/../package.json', '/../../etc/passwd', '/public/app.js']) {
    eq((await get(p)).status, 404, `越界/不存在的 ${p} → 404`)
  }
}

/* ---------------- 9. 武器三态：认不出这把武器 ≠ 没装备武器 ---------------- */
/*
 * 真实案例：奥黛塔拿的 11438，miao 和 i18n 表都还没收录，但 enka 照样给了
 * level/promote/affix —— 说明**是装备着的**。早先出口用 `name || '无武器'` 兜底，
 * 把它报成「无武器」，明细页还会因为 `if (weapon.name)` 整张武器卡消失。
 *
 * 夹具刻意用一个**不存在的 itemId**（11999），不用真实的 11438：那是真武器的 id，
 * 将来元数据一收录，这条测试就会莫名其妙变红。这里要的是「查不到」这个性质本身。
 */
console.log('\n=== 9. 武器三态 ===')
{
  /* 每个用例都拿一份**真响应**改一处。`raw` 用 EnkaPayload 标注：
     `REAL` 是 JSON.parse 出来的 any，标注之后改字段才有人管形状。 */
  interface WeaponCase {
    label: string
    expect: string
    edit: (raw: EnkaPayload) => void
  }
  const CASES: WeaponCase[] = [
    {
      label: '元数据不认识这把（itemId 换成查不到的）',
      expect: 'unknown',
      edit: (raw) => { weaponEntry(raw).itemId = 11999 }
    },
    {
      label: '角色压根没装备武器（把武器那条整个摘掉）',
      expect: 'none',
      edit: (raw) => {
        const a = raw.avatarInfoList!.find(x => x.avatarId === 10000016)!
        a.equipList = a.equipList!.filter(e => e.flat?.itemType !== 'ITEM_WEAPON')
      }
    },
    {
      label: '对照组（原样）',
      expect: 'ok',
      edit: () => {}
    }
  ]

  /* 迪卢克那条武器装备（夹具里必然有 —— 上面两个用例要改的就是它） */
  function weaponEntry (raw: EnkaPayload) {
    return raw.avatarInfoList!.find(x => x.avatarId === 10000016)!
      .equipList!.find(e => e.flat?.itemType === 'ITEM_WEAPON')!
  }

  for (const c of CASES) {
    const raw = structuredClone(REAL) as EnkaPayload
    c.edit(raw)
    const sum = ingestPayload(raw, { source: 'enka' })
    const a = await startServer({ port: 0, dbFile: ':memory:' })
    repo.saveFetch(a.db, { ...sum, stamp: '2026-09-13T00:00:00.000Z' })
    const view = await readJson(await fetch(a.url + `/api/accounts/${sum.account.uid}`))
    const w = view.data.avatars.find((x: any) => x.avatarId === 10000016).weapon
    a.server.close()

    eq(w.state, c.expect, `state = ${c.expect}（${c.label}）`)
    if (c.expect === 'ok') {
      eq(w.name, '狼的末路', '  对照组照旧拿到名字')
      continue
    }
    /* 名字是空串：文案由前端按 state 选（「未知武器」/「无武器」），后端不写死 */
    eq(w.name, '', '  名字留空，不写死文案')
    if (c.expect === 'unknown') {
      ok(/^assets\/common\/item\/atk-[a-z]+\.webp$/.test(w.icon || ''),
        `  退回**武器类型**通用图（${String(w.icon).split('/').pop()}）`)
      /* 关键：等级/精炼是 enka 给的，跟元数据认不认识无关，必须留 */
      eq(w.level, 90, '  等级留着（证明是「装备着」而不是「没装备」）')
      eq(w.affix, 1 + 1, '  精炼留着')
      eq(w.attrs, {}, '  属性/描述为空（元数据里确实没有）')
      eq(w.desc, '', '')
    } else {
      eq(w.icon, null, '  真没装备时不给图（给张类型图反倒像有武器）')
      eq(w.level, 1, '  等级回落默认 1')
    }
  }
}

/* ---------------- 10. 限流 ---------------- */
/*
 * 公网一开放，POST /api/accounts/:uid/refresh 就是个「拿你的服务去打 enka」的口子，上游一限流全站 502，
 * 所以必须有闸。这里钉死三件事：
 *   ① 限的是**每个 IP**，不是一个 IP 超了就全站锁死；
 *   ② 还有一档**全局**的（换 IP 绕不过去），那是替 enka 上游挡的；
 *   ③ 默认**不认转发头** —— 那只是个请求头，谁都能伪造，认了等于没限。
 *
 * 测试一律注入假 enka（fetchImpl），不联网；档位用小数字，不真等一分钟。
 */
/* ---------------- 10. 伤害计算接口 ---------------- */

console.log('\n=== 10. 伤害计算接口（明细页下侧的伤害表）===')
{
  const r = await json(`/api/accounts/${UID}/characters/10000016/damage`)
  eq(r.ok, true, '接口 ok')
  ok(!!r.data, '迪卢克算得出伤害')
  if (r.data) {
    ok(r.data.rows.length > 0, `伤害 ${r.data.rows.length} 条`)
    eq(r.data.enemyLv, 103, '敌人等级 103（与上游默认一致）')
    eq(r.data.enemyName, '小宝', '默认敌人')
    eq(r.data.createdBy, '喵喵', 'calc.js 署名')
    eq(r.data.rows.map((x: any) => x.title), ['E三段伤害', 'E三段蒸发', 'Q爆发伤害', '开Q后单次重击'], '四条伤害的标题')
    /* 数值是 miao 出图口径 Format.comma(v, 0)（千分位、取整），真值由 .tmp/dmg-parity
       与原版 ProfileDmg 的对拍背书 —— 这里钉死防回归 */
    eq(r.data.rows[0], { title: 'E三段伤害', dmg: '7,930', avg: '5,829', unit: '' }, '第一条钉真值（暴击/期望）')
    ok(r.data.rows.every((x: any) => x.dmg === null || /^[\d,]+$/.test(x.dmg)), '暴击伤害是千分位整数串')
    ok(r.data.rows.every((x: any) => x.avg === '' || /^[\d,]+$/.test(x.avg)), '期望伤害同上')
    ok(r.data.rows.every((x: any) => typeof x.unit === 'string'), 'unit 恒为串（没有单位就是空串）')

    /* 迪奥娜：护盾量与治疗量不吃暴击 —— dmg 为 null，页面上期望值独占一行 */
    const diona = (await json(`/api/accounts/${UID}/characters/10000039/damage`)).data
    eq(diona.rows.map((x: any) => x.dmg), ['4,029', null, null], '护盾/治疗两条没有暴击伤害')
    /* buff 串按「来源：描述」拆成两列（内核给的是拼好的整串） */
    eq(diona.buffs[0], { title: '迪奥娜天赋', desc: '长按E获得75%护盾吸收量加成' }, 'buff 首条钉真值')
    ok(diona.buffs.every((b: any) => b.title && !b.title.includes('：')), 'buff 拆开后来源里不带冒号')
  }

  /* 两种 404 语义不同：uid 不存在 ≠ 角色不在这个 uid 下 */
  const noUid = await get(`/api/accounts/123456789/characters/10000016/damage`)
  eq(noUid.status, 404, '不存在的 uid → 404')
  eq((await readJson(noUid)).error.code, 'no_data', '错误码 no_data')
  const noChar = await get(`/api/accounts/${UID}/characters/999999/damage`)
  eq(noChar.status, 404, 'uid 下没有的角色 → 404')
  eq((await readJson(noChar)).error.code, 'no_character', '错误码 no_character')
}

console.log('\n=== 11. 限流 ===')
{
  const fakeFetch = async (uid: number | string): Promise<unknown> => ({ ...REAL, uid })
  const post = (url: string, uid: number, headers: Record<string, string> = {}): Promise<Response> =>
    fetch(`${url}/api/accounts/${uid}/refresh`, { method: 'POST', headers })

  /* ① 每 IP 一档 */
  {
    const a = await startServer({
      port: 0, dbFile: ':memory:', fetchImpl: fakeFetch, trustProxy: true,
      rateLimit: { fetch: { limit: 2, windowMs: 60_000 }, fetchAll: { limit: 100, windowMs: 60_000 } }
    })
    const ip1 = { 'X-Forwarded-For': '203.0.113.7' }
    eq((await post(a.url, UID, ip1)).status, 200, '  每 IP：第 1 次放行')
    eq((await post(a.url, UID, ip1)).status, 200, '  第 2 次放行')
    const r3 = await post(a.url, UID, ip1)
    eq(r3.status, 429, '  第 3 次被拦（上限 2）')
    eq((await readJson(r3)).error.code, 'rate_limited', '  错误码 rate_limited')
    ok(Number(r3.headers.get('retry-after')) >= 1,
      `  带 Retry-After 头（${r3.headers.get('retry-after')} 秒）`)
    eq((await post(a.url, UID, { 'X-Forwarded-For': '203.0.113.8' })).status, 200,
      '  换个 IP 不受牵连（不是一超全站锁死）')
    a.server.close()
  }

  /* ② 全局一档：换 IP 也绕不过去 */
  {
    const a = await startServer({
      port: 0, dbFile: ':memory:', fetchImpl: fakeFetch, trustProxy: true,
      rateLimit: { fetch: { limit: 10, windowMs: 60_000 }, fetchAll: { limit: 2, windowMs: 60_000 } }
    })
    eq((await post(a.url, UID, { 'X-Forwarded-For': '203.0.113.11' })).status, 200, '  全局：IP A 放行')
    eq((await post(a.url, UID, { 'X-Forwarded-For': '203.0.113.12' })).status, 200, '  IP B 放行')
    eq((await post(a.url, UID, { 'X-Forwarded-For': '203.0.113.13' })).status, 429,
      '  IP C 被拦（全局上限 2，换 IP 绕不开）')
    a.server.close()
  }

  /* ③ 默认不认转发头：伪造 IP 无效 */
  {
    const a = await startServer({
      port: 0, dbFile: ':memory:', fetchImpl: fakeFetch,
      rateLimit: { fetch: { limit: 1, windowMs: 60_000 }, fetchAll: { limit: 100, windowMs: 60_000 } }
    })
    eq((await post(a.url, UID, { 'X-Forwarded-For': '203.0.113.20' })).status, 200,
      '  不认转发头：第 1 次放行')
    eq((await post(a.url, UID, { 'X-Forwarded-For': '203.0.113.21' })).status, 429,
      '  换个伪造 IP 照样被拦（只认 TCP 对端）')
    a.server.close()
  }

  /* ④ 读接口另有一档；health 和静态页故意不限 */
  {
    const a = await startServer({
      port: 0, dbFile: ':memory:', trustProxy: true,
      rateLimit: { read: { limit: 2, windowMs: 60_000 } }
    })
    repo.saveFetch(a.db, { ...summary, stamp: '2026-09-13T00:00:00.000Z' })
    const g = (p: string): Promise<Response> => fetch(a.url + p, { headers: { 'X-Forwarded-For': '203.0.113.30' } })
    eq((await g(`/api/accounts/${UID}`)).status, 200, '  读接口：第 1 次放行')
    eq((await g(`/api/accounts/${UID}`)).status, 200, '  第 2 次放行')
    eq((await g(`/api/accounts/${UID}`)).status, 429, '  第 3 次被拦（读上限 2）')
    eq((await g(`/api/accounts/${UID}/characters/10000016/damage`)).status, 429,
      '  伤害接口也走读档（要跑内核，不设限能拿它打满 CPU）')
    eq((await g('/api/health')).status, 200, '  /api/health 不限（探活被拦会误报故障）')
    eq((await g('/')).status, 200, '  静态页不限')
    a.server.close()
  }

  /* ⑤ 窗口过了要能自己恢复 */
  {
    const a = await startServer({
      port: 0, dbFile: ':memory:', trustProxy: true,
      rateLimit: { read: { limit: 1, windowMs: 300 } }
    })
    repo.saveFetch(a.db, { ...summary, stamp: '2026-09-13T00:00:00.000Z' })
    const g = () => fetch(a.url + `/api/accounts/${UID}`, { headers: { 'X-Forwarded-For': '203.0.113.40' } })
    eq((await g()).status, 200, '  短窗口：第 1 次放行')
    eq((await g()).status, 429, '  紧接着再来 → 429')
    await new Promise(r => setTimeout(r, 400))
    eq((await g()).status, 200, '  等过窗口 → 恢复（令牌桶在补）')
    a.server.close()
  }

  /* ⑥ 配额用完**不必等整个窗口** —— 这条专门钉「令牌桶 vs 固定窗口」的语义差。
        桶里没令牌时，能刷新的时刻是「补回 1 个」而不是「窗口翻页」：
        窗口 1000ms 补 2 个 → 500ms 补 1 个。所以「等 700ms」必须已经能刷。
        若哪天换回 limiter 的 RateLimiter（令牌桶之上还有一层窗口计数），这里会红。 */
  {
    const a = await startServer({
      port: 0, dbFile: ':memory:', trustProxy: true,
      rateLimit: { read: { limit: 2, windowMs: 1000 } }
    })
    repo.saveFetch(a.db, { ...summary, stamp: '2026-09-13T00:00:00.000Z' })
    const g = () => fetch(a.url + `/api/accounts/${UID}`, { headers: { 'X-Forwarded-For': '203.0.113.50' } })
    eq((await g()).status, 200, '  打满前：第 1 次放行')
    eq((await g()).status, 200, '  第 2 次放行（配额刚好用尽）')
    const r3 = await g()
    eq(r3.status, 429, '  第 3 次被拦')
    ok(Number(r3.headers.get('retry-after')) <= 2,
      `  Retry-After 是「补 1 个」而不是整窗口（${r3.headers.get('retry-after')} 秒）`)
    await new Promise(r => setTimeout(r, 700))
    eq((await g()).status, 200, '  等 700ms（> 补充间隔、< 窗口）→ 已恢复，没被窗口锁死')
    a.server.close()
  }
}

/* ---------------- 12. 跨域（前端单独托管时才用得上）---------------- */
/*
 * 本地运行时用不着（一个进程既给页面又给接口，压根不触发跨域）—— 而且开了就是
 * 允许任意站点的脚本读走这里的数据，所以**必须显式配白名单才生效**。
 * 前端单独托管（比如丢到 GitHub Pages）+ 后端另放 VPS 时，页面域名和接口域名不是一回事，
 * 这时才需要：启动加 --cors-origin=https://xxx.github.io。
 * 调通阶段懒得对域名就写 --cors-origin='*'（**引号别省**，否则 shell 可能把 `*` 当通配符展开）。
 */
console.log('\n=== 12. 跨域 ===')
{
  /* ① 默认不开：没配白名单时，来访 Origin 一律拿不到许可头（请求本身照常通） */
  {
    const r = await fetch(app.url + '/api/health', { headers: { Origin: 'https://pages.example' } })
    eq(r.status, 200, '不配白名单：请求照样通（跨域拦不拦是浏览器的事，服务端照常回）')
    eq(r.headers.get('access-control-allow-origin'), null, '不配白名单：不给 CORS 头')
  }

  /* ② 白名单要**一字不差**对上；回的是来访的 Origin 本身，不是通配符 */
  {
    const a = await startServer({ port: 0, dbFile: ':memory:', corsOrigins: ['https://pages.example'] })
    const hit = await fetch(a.url + '/api/health', { headers: { Origin: 'https://pages.example' } })
    eq(hit.headers.get('access-control-allow-origin'), 'https://pages.example', '白名单内：回来访的 Origin')
    eq(hit.headers.get('vary'), 'Origin', '白名单内：带 Vary: Origin（免得缓存把给 A 的许可回给 B）')

    const miss = await fetch(a.url + '/api/health', { headers: { Origin: 'https://evil.example' } })
    eq(miss.status, 200, '白名单外：请求本身还是通的')
    eq(miss.headers.get('access-control-allow-origin'), null, '白名单外：不给 CORS 头')

    /* 同源请求不带 Origin，不需要许可头 */
    const same = await fetch(a.url + '/api/health')
    eq(same.headers.get('access-control-allow-origin'), null, '不带 Origin：不需要 CORS 头')
    a.server.close()
  }

  /* ③ 预检（OPTIONS）：跨域请求只要带了自定义头，浏览器就会先探一发，
        这里不回 204 真正的请求就发不出去；而且预检**不该占限流配额**。 */
  {
    const a = await startServer({
      port: 0, dbFile: ':memory:', corsOrigins: ['https://pages.example'],
      rateLimit: { read: { limit: 1, windowMs: 60000 } }   /* 一分钟只够一次正常请求 */
    })
    /* 新实例是空库，得自己播种 —— 不然账号接口是 404 不是 200，测的就不是限流了 */
    repo.saveFetch(a.db, { ...summary, stamp: '2026-09-13T00:00:00.000Z' })
    const pre = () => fetch(`${a.url}/api/accounts/${UID}/refresh`, {
      method: 'OPTIONS',
      headers: {
        Origin: 'https://pages.example',
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'content-type'
      }
    })
    const p1 = await pre()
    eq(p1.status, 204, '预检：回 204（不是 404/405，否则刷新按钮直接哑火）')
    eq(p1.headers.get('access-control-allow-methods'), 'GET,POST,OPTIONS', '预检：放行的方法含 POST')
    ok((p1.headers.get('access-control-allow-headers') || '').toLowerCase().includes('content-type'),
      '预检：放行的头含 Content-Type（跨域带自定义头时靠它过预检）')

    /* 连刷预检不占配额：配额只有 1，刷完 5 发预检后正常 GET 仍要能过一次，第二次才 429 */
    for (let i = 0; i < 5; i++) eq((await pre()).status, 204, `预检连发 ${i + 1}/5 仍是 204（不计入限流）`)
    const g = () => fetch(a.url + `/api/accounts/${UID}`)
    eq((await g()).status, 200, '  预检刷完，正常请求照样放行')
    eq((await g()).status, 429, '  配额用尽后才 429')
    a.server.close()
  }

  /* ④ 白名单写 `*` = 谁都行。钉住这件事是因为 hono 收到**数组**只做字面量比对，
        `['*']` 对任何真实 Origin 都匹配不上 —— 以前这里静默失效，前端在 Pages 上
        一直报跨域，服务端日志却看不出任何异常。 */
  {
    const a = await startServer({ port: 0, dbFile: ':memory:', corsOrigins: ['*'] })
    for (const origin of ['https://any.example', 'https://another.example']) {
      const r = await fetch(a.url + '/api/health', { headers: { Origin: origin } })
      eq(r.headers.get('access-control-allow-origin'), '*', `通配 *：${origin} 也拿到许可头`)
    }
    const pre = await fetch(a.url + `/api/accounts/${UID}/refresh`, {
      method: 'OPTIONS',
      headers: { Origin: 'https://any.example', 'Access-Control-Request-Method': 'POST' }
    })
    eq(pre.status, 204, '通配 *：预检同样回 204')
    a.server.close()
  }
}

/* ---------------- 收尾 ---------------- */

app.server.close()

console.log(`\n结果：通过 ${passed} 项，失败 ${failed} 项`)
process.exit(failed > 0 ? 1 : 0)

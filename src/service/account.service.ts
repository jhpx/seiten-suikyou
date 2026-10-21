/*
 * 账号用例 —— 「一个请求要办成什么事」都写在这里，控制器只管把结果翻成 HTTP。
 *
 * 它做四件事：列表摘要、账号整包视图（buildAccountView）、探活计数、抓取落库
 * （createIngestService，refresh 路由的用例）。角色相关的用例与角色视图在 character.service.ts。
 *
 * 这里**不出现状态码** —— 判空就返回 null，由 rest 层决定回什么。
 */
import type { Db } from '../config/db.ts'
import * as repo from '../config/store.ts'
import { ArtisMark } from '../index.ts'
import { i18n } from '../index.ts'
import { toMiaoProfile } from '../kernel/materialize.ts'
import type { Account } from '../domain/account.ts'
import type { EnkaPayload } from '../domain/enka.ts'
import { fetchEnka } from '../upstream/enka.ts'
import type { FetchEnkaOpts } from '../upstream/enka.ts'
import { ingestPayload } from '../upstream/enka-account.ts'
import type { IngestResult } from '../upstream/enka-account.ts'
import { errMessage, fmtTime } from '../common/util.ts'
import { shapeCharacter } from './character.service.ts'
import type { MarkDetail } from './character.service.ts'

/** 列表页一行（只有昵称等级这类概要，不带角色） */
export interface AccountSummary {
  uid: number
  nickname: string | null
  level: number | null
  worldLevel: number | null
  avatarCount: number
  fetchedAt: string | null
}

export function listAccounts (db: Db): AccountSummary[] {
  return repo.listUids(db).map(uid => {
    const acc = repo.loadAccount(db, uid)
    return {
      uid,
      nickname: acc?.nickname ?? null,
      level: acc?.level ?? null,
      worldLevel: acc?.worldLevel ?? null,
      avatarCount: repo.listCharacterIds(db, uid).length,
      /* ISO UTC → 本地时区文本（出口就转，库里和接口外都不留时区问题） */
      fetchedAt: fmtTime(repo.lastFetch(db, uid)?.fetchedAt)
    }
  })
}

/** 库里有多少个账号 —— 探活用，不拼整包视图 */
export function countAccounts (db: Db): number {
  return repo.listUids(db).length
}

/** 一整包 → 视图对象（页面/接口的最终形状），内部把 materialize + 打分 + 本地化串起来。
 *  不认识的角色（miao 元数据里没有该 avatarId）收进 `skipped` 而不是整包失败 —— 新角色先于 miao 更新是常态。
 *  fetchedAt 是 UID 级（= 上次同步 enka，通常取 fetch_log 最新一条）；角色各自的在 shapeCharacter 里出。 */
export function buildAccountView ({ account, locale = i18n.DEFAULT_LOCALE, fetchedAt = null }: {
  account: Account | null
  locale?: string
  fetchedAt?: string | null
}) {
  const loc = i18n.resolveLocale(locale)
  const avatars: Array<ReturnType<typeof shapeCharacter>> = []
  const skipped: Array<number | null> = []
  for (const ch of account?.characters || []) {
    const profile = toMiaoProfile(ch)
    if (!profile) { skipped.push(ch.avatarId); continue }
    avatars.push(shapeCharacter(ch, profile, ArtisMark.getMarkDetail(profile, true) as MarkDetail, loc))
  }
  return {
    locale: loc,
    fetchedAt: fmtTime(fetchedAt),
    account: account
      ? {
          uid: account.uid,
          nickname: account.nickname,
          level: account.level,
          worldLevel: account.worldLevel,
          signature: account.signature
        }
      : null,
    count: avatars.length,
    skipped,
    avatars,
    /* 全局刷圣遗物建议：由 avatars 再聚合一次，不额外跑评分内核。
       放在整包视图里而不是单开一个接口 —— 数据就在手边，前端也不该为此多打一次请求。 */
    advice: buildAdvice(avatars, loc)
  }
}

/** 一整包视图（账号 + 角色 + 评分 + 本地化）。库里没有 → null，上层回 404 */
export function accountView (db: Db, uid: number, locale: string): ReturnType<typeof buildAccountView> | null {
  const account = repo.loadAccountWithCharacters(db, uid)
  if (!account) return null
  return buildAccountView({ account, locale, fetchedAt: repo.lastFetch(db, uid)?.fetchedAt || null })
}

/* ───────────────────────── 抓取用例（refresh 路由） ───────────────────────── */

/** 抓取实现（测试可替换成假数据） */
export type FetchImpl = (uid: number | string, opts?: FetchEnkaOpts) => Promise<unknown>

export interface IngestService {
  fetch: (uid: number) => Promise<IngestResult>
}

/**
 * 抓取用例工厂 —— 一次刷新请求从头到尾该做的事：打上游 → 校验形状 → 落库 → 失败留痕。
 *
 * 它是有状态的（同一个 uid 的并发请求要合成一次），所以做成工厂：装配时建一个，
 * 之后每次请求调 `fetch(uid)`。控制器不碰 inflight，也不需要知道上游是谁。
 *
 * ⚠️ 失败也记 fetch_log（ok=0）：上游抖过多少次、为什么抖，只留痕在这里。
 */
export function createIngestService ({ db, fetchImpl = fetchEnka }: {
  db: Db
  fetchImpl?: FetchImpl
}): IngestService {
  /* 同一个 uid 同时来两次抓取请求时共用一个 promise，别把 enka 打两遍 */
  const inflight = new Map<number, Promise<IngestResult>>()

  async function run (uid: number): Promise<IngestResult> {
    try {
      const payload = await fetchImpl(uid)
      /* 抓回来的就是 enka 原始响应；形状由 ingestPayload 校验（缺 playerInfo 会抛） */
      const summary = ingestPayload(payload as EnkaPayload, { source: 'enka' })
      repo.saveFetch(db, { ...summary, stamp: new Date().toISOString() })
      return summary
    } catch (e) {
      repo.logFailure(db, { uid, note: errMessage(e) })
      throw e
    }
  }

  return {
    fetch (uid) {
      let p = inflight.get(uid)
      if (!p) {
        p = run(uid).finally(() => inflight.delete(uid))
        inflight.set(uid, p)
      }
      return p
    }
  }
}

/* ───────────────────────── 全局刷圣遗物建议 ───────────────────────── */

/** shapeCharacter 的产物 —— 建议层不重算评分，直接吃页面已经成型的那份 */
export type AvatarView = ReturnType<typeof shapeCharacter>

/**
 * 口径参数。这几个数都是可讨论的，别在调用点重复写死。
 *
 * ⚠️ 三档的分数线**不在这里** —— 它跟着内核给的 `markClass` 走（D/C/B | A/S | SS），
 * 别拿数字重划一遍。内核的线是 D<7 C<14 B<21 A<28 S<35 SS<42 SSS<49 ACE<56 MAX<70，
 * 自己乘一遍很容易差一档（曾经把 SS 混进 A-S、SSS+ 混进 SS）。
 */
export const ADVICE_RULES = {
  /** 低于这个等级的角色不进统计 */
  minLevel: 71,
  /** 一件「达标件」的分数线，也就是 SSS 的下界（内核线 SSS<49、SS<42）。低于这条线的件才产生缺口 */
  needBase: 42,
  /**
   * 三项权重，加起来 = 1：稀烂程度 / 覆盖人数 / 均值落差。
   *
   * 口径是**加权汇总**（SAW），不是连乘：每项先除以账号内的最大值折到 0~1，再乘权重相加。
   * 好处是「这件套装为什么排前面」能直接答出来 —— 三项各占几分看得见，改权重也只动一个数。
   * 连乘的老写法（缺口 × 弹性 × 人数）看着简洁，但系数含义是叠出来的，
   * 调一个参数名次会跳着变，也没法解释。
   *
   * ⚠️ 归一化必须**线性**，别换成 √ 或 log：压缩会把大套在缺口项上的优势削平，
   * 结果是「件多」重新主导（实测压缩后长夜之誓从第 4 掉到第 6）。
   */
  weight: { gap: 0.5, owners: 0.2, drop: 0.3 },
  /** 最多给几个套装 */
  topN: 8
} as const

/** 一件圣遗物在建议里的样子 */
export interface AdvicePiece {
  avatarId: number | null
  /** 角色名（跟 locale 走） */
  name: string
  pos: number
  posName: string
  /** 原始分（0~70，排序用） */
  mark: number
  /** 内核格式化好的串（1 位小数，页面直接用） */
  markText: string
  markClass: string
  /** 这个角色身上属于该套装的件数：2 = 只吃 2 件套效果，4/5 = 想凑 4 件套 */
  setCount: number
}

export interface AdviceSet {
  nameZh: string
  name: string
  icon: string | null
  /** 三档明细：bad = D/C/B，mid = A/S，good = SS。SSS 及以上不入任何一档 */
  bad: AdvicePiece[]
  mid: AdvicePiece[]
  good: AdvicePiece[]
  count: { bad: number; mid: number; good: number; total: number; owners: number }
  /** ① 稀烂程度：Σ(42 − 单件分)，只算 SSS 以下的件。越烂越大，和件数天然相关 */
  gap: number
  /**
   * ③ 均值落差：这套覆盖的角色，各自「自己的五件均值 − 自己最差件」的平均。
   * 衡量的是「这帮人身上还有多少能靠换一件补回来」。
   *
   * ⚠️ 不用「套装内所有件的均值 − 套装最差件」：那个数会被件数带偏 ——
   * 15 件的套天然比 3 件的套极差大（样本量效应），等于偷偷奖励大套。
   */
  drop: number
  /** 加权汇总得分（0~1）：三项各除以账号内最大值，再按 `weight` 相加 */
  score: number
  /** 这套在账号里出现过的最高星级 */
  star: number
  /** 有 5 星版本才刷得出来。false（如教官、战狂）只能换别的套装，排在最后 */
  farmable: boolean
}

export interface AdviceView {
  minLevel: number
  sets: AdviceSet[]
}

/** 档位字母 → 三档。SSS 及以上不进任何一档：那已经不用刷了，算进「SS」只会虚高。 */
const TIER_BY_CLASS: Record<string, 'bad' | 'mid' | 'good'> = {
  D: 'bad', C: 'bad', B: 'bad',
  A: 'mid', S: 'mid',
  SS: 'good'
}

/** 一件属于哪一档；SSS / ACE / MAX（以及认不出的档位）返回 null = 不统计 */
function tierOf (markClass: string): 'bad' | 'mid' | 'good' | null {
  return TIER_BY_CLASS[markClass] ?? null
}

/**
 * 账号里所有角色 → 套装建议列表（已排序、已截断）。
 *
 * 入参就是 `buildAccountView` 里那份 avatars —— 每件的套装名、分数、档位、星级都在上面，
 * 所以这里零额外计算，也不重新跑评分内核。
 */
export function buildAdvice (avatars: AvatarView[], locale: string = i18n.DEFAULT_LOCALE): AdviceView {
  const loc = i18n.resolveLocale(locale)
  const acc = new Map<string, AdviceSet>()
  /* 角色 → 落差。套装那一项要按「覆盖角色的平均」算，所以先记下来 */
  const dropOf = new Map<number, number>()
  /* 套装 → 覆盖角色的 id 集合（只记统计范围内的人） */
  const ownersOf = new Map<string, Set<number>>()

  for (const av of avatars) {
    if ((av.level ?? 0) < ADVICE_RULES.minLevel) continue

    /* 这个人的「落差」：五件均值比最差那件高多少 —— 补上短板能涨多少分。
       五件齐得像印刷的（落差 1~2 分），刷了也涨不动。
       ⚠️ 不用标准差：σ 大也可能是「有一件极品」，那种人补短板收益并不大。 */
    const marks = av.artifacts.filter(a => !a.empty).map(a => a.markValue ?? 0)
    dropOf.set(av.avatarId, marks.length >= 2
      ? Math.max(0, marks.reduce((x, y) => x + y, 0) / marks.length - Math.min(...marks))
      : 0)

    /* 先数这个角色身上每个套装各有几件 —— 少于 2 件的散件直接丢掉 */
    const bySet = new Map<string, AdvicePiece[]>()
    for (const a of av.artifacts) {
      if (a.empty || !a.setNameZh) continue
      const list = bySet.get(a.setNameZh) || []
      list.push({
        avatarId: av.avatarId,
        name: av.name,
        pos: a.pos,
        posName: a.posName,
        mark: a.markValue ?? 0,
        markText: a.mark || '',
        markClass: a.markClass || 'D',
        setCount: 0           // 下面统一回填，这时还不知道这一套有几件
      })
      bySet.set(a.setNameZh, list)
    }

    for (const [setName, pieces] of bySet) {
      if (pieces.length < 2) continue
      let slot = acc.get(setName)
      if (!slot) {
        /* 套装展示名与图标先取第一条 —— 同一个套装名在各角色身上是同一张图 */
        const meta = av.sets.find(s => s.nameZh === setName)
        slot = {
          nameZh: setName,
          name: meta?.name || setName,
          icon: meta?.icon || null,
          bad: [], mid: [], good: [],
          count: { bad: 0, mid: 0, good: 0, total: 0, owners: 0 },
          gap: 0,
          drop: 0,
          score: 0,
          star: 0,
          farmable: true
        }
        acc.set(setName, slot)
      }
      const pieceStar = av.artifacts.find(a => !a.empty && a.setNameZh === setName)?.star ?? 5
      if (pieceStar > slot.star) slot.star = pieceStar
      for (const p of pieces) {
        p.setCount = pieces.length
        const tier = tierOf(p.markClass)
        /* SSS 及以上不统计：它证明「这套已经有好的了」，但不构成「还要刷」的需求 */
        if (!tier) continue
        slot[tier].push(p)
        /* ① 稀烂程度：离达标线差多少分。越烂差值越大，这就是「越烂越优先」 */
        slot.gap += Math.max(0, ADVICE_RULES.needBase - p.mark)
        let owners = ownersOf.get(setName)
        if (!owners) { owners = new Set(); ownersOf.set(setName, owners) }
        owners.add(av.avatarId)
      }
    }
  }

  const sets: AdviceSet[] = []
  for (const s of acc.values()) {
    s.count.bad = s.bad.length
    s.count.mid = s.mid.length
    s.count.good = s.good.length
    s.count.total = s.count.bad + s.count.mid + s.count.good
    /* 一件都不在统计范围内（这套全是 SSS 以上）→ 没有可刷的，整条不列 */
    if (s.count.total === 0) continue
    /* ② 覆盖人数、③ 均值落差 —— 都只看统计范围内（<SSS）的人 */
    const owners = ownersOf.get(s.nameZh) ?? new Set<number>()
    s.count.owners = owners.size
    s.drop = owners.size
      ? [...owners].reduce((x, id) => x + (dropOf.get(id) ?? 0), 0) / owners.size
      : 0
    sets.push(s)
  }

  /* 三项口径不同（分、人、分），先各自除以账号内的最大值折到 0~1，再按权重相加。
     这样 score 就是「三项各贡献了几成」，可以直接回答「它凭什么排第一」。
     ⚠️ 别换成 √ / log 压缩：压缩会削平大套在缺口项上的优势，件数会重新主导名次。 */
  if (sets.length) {
    const maxGap = Math.max(...sets.map(s => s.gap)) || 1
    const maxOwners = Math.max(...sets.map(s => s.count.owners)) || 1
    const maxDrop = Math.max(...sets.map(s => s.drop)) || 1
    const w = ADVICE_RULES.weight
    for (const s of sets) {
      s.score = w.gap * (s.gap / maxGap) +
        w.owners * (s.count.owners / maxOwners) +
        w.drop * (s.drop / maxDrop)
    }
  }


  /* 4 星套装（教官、战狂这类）刷不出来，只能换成别的套 —— 排在最后，但信息不丢。
     ⚠️ 判据用的是「账号里实穿的最高星级」，不是元数据：新手穿 4 星绝缘时会被误判成刷不到。
     这个方向的误判是保守的（不多推荐），可以接受；要精确得去查套装元数据，先不做。 */
  for (const s of sets) s.farmable = s.star >= 5

  /* 刷不出来的沉底 → 缺口大的在前 → 平手看谁的废件多 → 再平手看池子多大 */
  sets.sort((a, b) =>
    Number(b.farmable) - Number(a.farmable) ||
    b.score - a.score ||
    b.count.bad - a.count.bad ||
    b.count.total - a.count.total)

  for (const s of sets) {
    /* 每档内从低到高 —— 页面自上而下读，最该换的排最上面 */
    for (const key of ['bad', 'mid', 'good'] as const) {
      s[key].sort((a, b) => a.mark - b.mark || a.pos - b.pos)
    }
  }

  return { minLevel: ADVICE_RULES.minLevel, sets: sets.slice(0, ADVICE_RULES.topN) }
}

/** 一行摘要，给日志和「一段话」用：「套装 · 3废7能用12达标（22件/6人）」 */
export function adviceLine (s: AdviceSet): string {
  const c = s.count
  return `${s.name} · ${c.bad}/${c.mid}/${c.good}（${c.total} 件 / ${c.owners} 人）`
}

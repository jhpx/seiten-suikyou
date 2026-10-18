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
    avatars
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

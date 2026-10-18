/*
 * 抓取用例 —— 一次刷新请求从头到尾该做的事：打上游 → 校验形状 → 落库 → 失败留痕。
 *
 * 它是有状态的（同一个 uid 的并发请求要合成一次），所以做成工厂：装配时建一个，
 * 之后每次请求调 `fetch(uid)`。控制器不碰 inflight，也不需要知道上游是谁。
 *
 * ⚠️ 失败也记 fetch_log（ok=0）：上游抖过多少次、为什么抖，只留痕在这里。
 */
import type { Db } from '../config/db.ts'
import * as repo from '../config/store.ts'
import { fetchEnka } from '../upstream/enka.ts'
import type { FetchEnkaOpts } from '../upstream/enka.ts'
import { ingestPayload } from '../upstream/enka-account.ts'
import type { IngestResult } from '../upstream/enka-account.ts'
import type { EnkaPayload } from '../domain/enka.ts'
import { errMessage } from '../common/util.ts'

/** 抓取实现（测试可替换成假数据） */
export type FetchImpl = (uid: number | string, opts?: FetchEnkaOpts) => Promise<unknown>

export interface IngestService {
  fetch: (uid: number) => Promise<IngestResult>
}

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

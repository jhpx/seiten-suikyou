/*
 * 控制器能看到的世界 —— 一组「用例能力」，不是数据库。
 *
 * 这份契约定义在 service/：service 说自己能提供什么，server 装配时把实现接进来，
 * rest 控制器只认这份接口。
 *
 * 刻意不把 Db 递进来：控制器只拿用例能力（列账号、建视图、跑抓取、算伤害），
 * 谁实现、怎么实现，它不用知道。
 */
import type { MiddlewareHandler } from 'hono'

import type { DamageResult } from './character.service.ts'
import type { AccountSummary } from './account.service.ts'
import type { IngestResult } from '../upstream/enka-account.ts'
import { buildAccountView, weightFilterOptions } from './view.service.ts'

/** 一整包账号视图（类型从视图层推，控制器不另抄一份形状） */
export type AccountView = ReturnType<typeof buildAccountView>

/** 首页「按属性权重筛选」的选项（跟着语言走，前端不写死词条名） */
export type WeightOption = ReturnType<typeof weightFilterOptions>[number]

export interface ApiContext {
  /** 系统信息（/api/meta 用）：语言表之外的静态选项 */
  meta: {
    /** 权重筛选项，按语言给名字 */
    weightOptions: (locale: string) => WeightOption[]
  }
  accounts: {
    /** 列表页摘要 */
    list: () => AccountSummary[]
    /** 库里有多少个账号（探活） */
    count: () => number
    /** 整包视图；库里没有 → null */
    view: (uid: number, locale: string) => AccountView | null
  }
  characters: {
    /** 伤害视图；判别「账号没数据 / 没这个角色 / 算不出来」 */
    damage: (uid: number, avatarId: number) => Promise<DamageResult>
  }
  /** 抓一次并落库（并发同 uid 会合并） */
  ingest: (uid: number) => Promise<IngestResult>
}

/** 给某条路由挂限流：tier 由调用点给（闸门关掉时这个函数返回空中间件） */
export type Guard = (tier: 'read' | 'fetch') => MiddlewareHandler

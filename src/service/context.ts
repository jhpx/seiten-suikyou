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

import type { AccountSummary, AccountView } from './dto/account.dto.ts'
import type { DamageResult } from './dto/damage.dto.ts'
import type { SimCatalog, SimRequest, SimResult } from './dto/sim.dto.ts'
import type { IngestResult } from '../gateway/enka/enka.dto.ts'
import { weightFilterOptions } from './character.service.ts'

export type { AccountView, AccountSummary }

/* 模拟接口的入参 / 出参类型也一并从这里出去：控制器只认这份契约，
   直接 import service/character.service.ts 会被 arch 断言逮住（rest 不许引 service 实现）。 */
export type { SimCatalog, SimRequest, SimResult }

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
    /** 可选装备目录（这个角色能换什么武器/套装/主词条）；名字按 locale 给 */
    simCatalog: (uid: number, avatarId: number, locale: string) => SimCatalog | null
    /** 按改后的配装重算面板与伤害；返回的面板/词条名按 locale 给 */
    simulate: (uid: number, avatarId: number, req: SimRequest, locale: string) => Promise<SimResult>
  }
  /** 抓一次并落库（并发同 uid 会合并） */
  ingest: (uid: number) => Promise<IngestResult>
}

/** 给某条路由挂限流：tier 由调用点给（闸门关掉时这个函数返回空中间件） */
export type Guard = (tier: 'read' | 'fetch') => MiddlewareHandler

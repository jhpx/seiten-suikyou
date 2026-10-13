/*
 * damage —— 伤害计算出口
 *
 * 输入是 materialize 产出的 MiaoProfile（域模型 → miao 形状，含 miao 自己算的
 * profile.attr），输出是 ProfileDmg.calcData 的归一化结果。和 materialize 一样
 * 属「计算出口」：不碰存储、不碰渲染，算完即走。
 *
 * 内部数据流（全在 vendor/miao 里，来历见同步报告）：
 *   角色 calc.js（details 伤害条目 + buffs 命座天赋）→ DmgAttr.getAttr（吃 profile.attr 打底）
 *   → DmgBuffs（武器 + 圣遗物套装 + 角色 buff）→ DmgAttr.calcAttr 逐条施加
 *   → DmgCalc.getDmgFn 按各区乘区公式出 { dmg, avg }
 */
import { ProfileDmg } from '../index.ts'
import type { MiaoProfile } from './materialize.ts'

/** 一条伤害 —— calcData 返回里的 ret[i] */
export interface DamageEntry {
  title: string
  /** 暴击伤害。反应类伤害（蒸发 / 扩散 / …）不吃暴击，只有 avg */
  dmg: number | null
  /** 期望伤害（按暴击率加权，面板上展示的那个数） */
  avg: number | null
}

export interface DamageResult {
  entries: DamageEntry[]
  /** 默认条目当前生效的 buff 列表（内核 msg，标题里已内联好数值） */
  buffs: string[]
  /** 角色 calc.js 的署名（miao 社区贡献者，比如「冰翼」） */
  createdBy: string
  enemyName: string
  enemyLv: number
}

/**
 * 算一个角色的全部伤害条目。角色没配 calc.js 时返回 null
 * （129 个脚本覆盖不了全部角色，部分四星与未实装角色没有）。
 *
 * ⚠️ calcData 抛错时也返回 null 并打日志：单个角色的脚本出了问题（上游数据缺字段、
 * 我们漏搬资源之类）不该让整个详情页 500。对页面来说「算不出」和「没配脚本」
 * 是同一件事；但日志必须留痕，不然静默降级没人发现。
 *
 * enemyLv 默认 103 —— 与上游一致（103 级小宝，面板伤害对比的基准敌人）。
 */
export async function calcDamage (profile: MiaoProfile, opts: { enemyLv?: number } = {}): Promise<DamageResult | null> {
  let ret: any
  try {
    const dmg = new ProfileDmg(profile as any, 'gs')
    ret = await dmg.calcData({ enemyLv: opts.enemyLv ?? 103 })
  } catch (e) {
    console.error(`[damage] 角色 ${(profile as any).id} 伤害计算失败:`, e)
    return null
  }
  if (!ret) return null

  return {
    entries: (ret.ret || []).map((ds: any) => ({
      title: ds.title,
      dmg: typeof ds.dmg === 'number' ? ds.dmg : null,
      avg: typeof ds.avg === 'number' ? ds.avg : null
    })),
    buffs: ret.msg || [],
    createdBy: ret.createdBy,
    enemyName: ret.enemyName,
    enemyLv: ret.enemyLv
  }
}

/*
 * damage —— 伤害计算出口
 *
 * 输入是 materialize 产出的 MiaoProfile，输出是 ProfileDmg.calcData 的归一化结果。
 * 属「计算出口」：不碰存储、不碰渲染，算完即走。
 *
 * 内部数据流（全在 vendor/miao 里）：
 *   角色 calc.js（details 伤害条目 + buffs 命座天赋）→ DmgAttr.getAttr（吃 profile.attr 打底）
 *   → DmgBuffs（武器 + 圣遗物套装 + 角色 buff）→ DmgAttr.calcAttr 逐条施加
 *   → DmgCalc.getDmgFn 按各区乘区公式出 { dmg, avg }
 */
import { ProfileDmg } from '../../index.ts'
import type { MiaoProfile } from './materialize.ts'

/** 一条伤害 —— calcData 返回里的 ret[i] */
export interface MiaoDamageEntry {
  title: string
  /** 暴击伤害。反应类伤害（蒸发 / 扩散 / …）不吃暴击，只有 avg */
  dmg: number | null
  /** 期望伤害（按暴击率加权，面板上展示的那个数） */
  avg: number | null
  /** 单位，拼在数值后面。绝大多数条目没有；目前只有坎蒂丝的「Q提升普攻伤害」是 '%' */
  unit: string
}

/** miao 引擎的原始伤害结果 —— 归一化后的 calcData 出口，不碰渲染 */
export interface MiaoDamage {
  entries: MiaoDamageEntry[]
  /** 默认条目当前生效的 buff 列表（内核 msg，标题里已内联好数值） */
  buffs: string[]
  /** 角色 calc.js 的署名（miao 社区贡献者，比如「冰翼」） */
  createdBy: string
  enemyName: string
  enemyLv: number
}

/**
 * 把 profile.artis 从 Artis 实例换成「套装名 → 件数」这张表（`Artis.sets`）再喂内核。
 *
 * 为什么必须换：内核查 2/4 件套效果走的是 `DmgBuffs.getArtisBuffs(profile.artis)`
 * → `ArtifactSet.eachSet(idxs)`，而 eachSet 的入参就是 `{ 套装名: 2|4 }` 这种平表
 * （上游 `Avatar.calcDmg` 里写的也是 `artis:artis.sets`）。
 * 直接给 Artis 实例的话，eachSet 只能遍历到实例自己的 game/artis/isProfile 三个字段，
 * 一件套装都认不出来 —— 表现就是 buff 列表里没有套装条目，**伤害本身也少算了套装加成**
 * （魔女4 给蒸发加 15%，实测差 4 万）。
 *
 * 只在伤害出口换，不动 MiaoProfile 本身：面板属性（`Attr.create`）和评分
 * （`ArtisMark` / `profile.artis.forEach`）要的是实例，两边口径不同是有意的。
 */
function withArtisSets (profile: MiaoProfile): MiaoProfile {
  const artis = (profile as any).artis
  return { ...profile, artis: artis?.sets ?? artis }
}

/**
 * 算一个角色的全部伤害条目。角色没配 calc.js 时返回 null
 * （129 个脚本覆盖不了全部角色，部分四星与未实装角色没有）。
 *
 * ⚠️ calcData 抛错时也返回 null 并打日志：单个角色的脚本出了问题不该让整个详情页 500。
 * 对页面来说「算不出」和「没配脚本」是同一件事；但日志必须留痕，不然静默降级没人发现。
 *
 * enemyLv 默认 103 —— 与上游一致（103 级小宝，面板伤害对比的基准敌人）。
 */
export async function calcDamage (profile: MiaoProfile, opts: { enemyLv?: number } = {}): Promise<MiaoDamage | null> {
  let ret: any
  try {
    const dmg = new ProfileDmg(withArtisSets(profile), 'gs')
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
      avg: typeof ds.avg === 'number' ? ds.avg : null,
      unit: typeof ds.unit === 'string' ? ds.unit : ''
    })),
    buffs: ret.msg || [],
    createdBy: ret.createdBy,
    enemyName: ret.enemyName,
    enemyLv: ret.enemyLv
  }
}

/*
 * 伤害组装器 —— 把 miao 引擎的原始伤害结果拼成 DamageView（给前端的伤害表形状）。
 */
import { Format } from '../../index.ts'
import { toMiaoProfile } from '../../gateway/miao/materialize.ts'
import { calcDamage } from '../../gateway/miao/damage.ts'
import type { MiaoDamage } from '../../gateway/miao/damage.ts'
import type { CharacterDbo } from '../../repository/dbo/character.ts'
import type { DamageRow, DamageView } from '../dto/damage.dto.ts'

/** 一个角色 → 伤害表 DTO。返回 null 表示算不出（没配 calc.js / 脚本算崩 / materialize 搭不出 profile） */
export async function damageOf (ch: CharacterDbo): Promise<DamageView | null> {
  const profile = toMiaoProfile(ch)
  if (!profile) return null
  const dmg = await calcDamage(profile)
  if (!dmg) return null
  return damageToView(dmg)
}

/** 归一化 miao 的原始伤害结果 → DamageView（伤害组装，供 damageOf 与 characterSim 共用） */
export function damageToView (dmg: MiaoDamage): DamageView {
  return {
    rows: dmg.entries.map((e): DamageRow => ({
      title: e.title,
      dmg: e.dmg === null ? null : Format.comma(e.dmg, 0),
      avg: e.avg === null ? '' : Format.comma(e.avg, 0),
      unit: e.unit
    })),
    buffs: dmg.buffs.map(msg => {
      const i = msg.indexOf('：')
      return i < 0 ? { title: msg, desc: '' } : { title: msg.slice(0, i), desc: msg.slice(i + 1) }
    }),
    createdBy: dmg.createdBy,
    enemyName: dmg.enemyName,
    enemyLv: dmg.enemyLv
  }
}

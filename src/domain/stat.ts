/*
 * 词条（stat）—— 领域层
 *
 * 同一个东西有三套名字，混一次就会把大生命当成小生命。这里把三套名字摆在**同一张表**里，一行就是一条词条：
 *
 *   语义名（HP_PERCENT）                          代码里引用它，比裸字符串分得清
 *   enka 的字符串 prop（FIGHT_PROP_HP_PERCENT）   网络上的形状，也是库里 sub_stats 存的形状
 *   miao 的短 key（hp）                           内核内部的键，显示层一直用它
 *
 * ⚠️ 方向坑：**不带 _PERCENT 的是固定值** —— `FIGHT_PROP_HP` 是固定生命（满级花主词条
 *    4780）、对应 miao 的 `hpPlus`（小生命）；`FIGHT_PROP_HP_PERCENT`（46.6%）才对应 `hp`（大生命）。
 *    atk / def 同理，三对都这样。反着记不会报错、查名也照样对（官方这两条都叫「生命值」），
 *    但一旦拿它对数值，大生命就被指到固定值那一列上了。对数值的判据是 miao 自己的
 *    `mainIdMap`（14001 → hpPlus、15002 → hp）。
 *
 * ⚠️ 这张表**只用于对数值 / 查名**，不参与算分 —— 评分 100% 走内核，内核自己从 id 解析。
 */
import { num } from '../common/util.ts'

const STAT_TYPES = {
  HP:                { prop: 'FIGHT_PROP_HP',                key: 'hpPlus'   },
  HP_PERCENT:        { prop: 'FIGHT_PROP_HP_PERCENT',        key: 'hp'       },
  ATTACK:            { prop: 'FIGHT_PROP_ATTACK',            key: 'atkPlus'  },
  ATTACK_PERCENT:    { prop: 'FIGHT_PROP_ATTACK_PERCENT',    key: 'atk'      },
  DEFENSE:           { prop: 'FIGHT_PROP_DEFENSE',           key: 'defPlus'  },
  DEFENSE_PERCENT:   { prop: 'FIGHT_PROP_DEFENSE_PERCENT',   key: 'def'      },
  ELEMENTAL_MASTERY: { prop: 'FIGHT_PROP_ELEMENT_MASTERY',   key: 'mastery'  },
  CHARGE_EFFICIENCY: { prop: 'FIGHT_PROP_CHARGE_EFFICIENCY', key: 'recharge' },
  CRITICAL:          { prop: 'FIGHT_PROP_CRITICAL',          key: 'cpct'     },
  CRITICAL_HURT:     { prop: 'FIGHT_PROP_CRITICAL_HURT',     key: 'cdmg'     },
  HEAL_ADD:          { prop: 'FIGHT_PROP_HEAL_ADD',          key: 'heal'     },
  ADD_HURT:          { prop: 'FIGHT_PROP_ADD_HURT',          key: 'dmg'      },
  PHYSICAL_ADD_HURT: { prop: 'FIGHT_PROP_PHYSICAL_ADD_HURT', key: 'phy'      },
  FIRE_ADD_HURT:     { prop: 'FIGHT_PROP_FIRE_ADD_HURT',     key: 'pyro'     },
  ELEC_ADD_HURT:     { prop: 'FIGHT_PROP_ELEC_ADD_HURT',     key: 'electro'  },
  WATER_ADD_HURT:    { prop: 'FIGHT_PROP_WATER_ADD_HURT',    key: 'hydro'    },
  GRASS_ADD_HURT:    { prop: 'FIGHT_PROP_GRASS_ADD_HURT',    key: 'dendro'   },
  WIND_ADD_HURT:     { prop: 'FIGHT_PROP_WIND_ADD_HURT',     key: 'anemo'    },
  ROCK_ADD_HURT:     { prop: 'FIGHT_PROP_ROCK_ADD_HURT',     key: 'geo'      },
  ICE_ADD_HURT:      { prop: 'FIGHT_PROP_ICE_ADD_HURT',      key: 'cryo'     }
}

/* 语义名 → enka prop（命名参考 AbyssalEvaluator 的 StatType 枚举，data/model/stat.py） */
export const StatType = Object.fromEntries(
  Object.entries(STAT_TYPES).map(([name, t]) => [name, t.prop]))

/* enka prop → miao key。「同一个词条在两套词汇里叫什么」是词条本身的性质，不是存储的性质。
   这 20 项 = miao `Meta.getMeta('gs','arti')` 里 mainIdMap + attrIdMap 的全集。 */
export const ENKA_PROP_TO_KEY = Object.fromEntries(
  Object.values(STAT_TYPES).map(t => [t.prop, t.key]))

/* miao key → enka prop。两个消费者：本文件的 isIntegerStatKey（判整数口径）、
   src/common/names.ts 的 statName（拿 prop 去官方文案表查名）。
   ⚠️ 这个方向是**唯一正确**的（hp → ..._PERCENT）；反着写不会报错、查名也照样对，
   但一旦拿它对数值就把大生命指到了固定值那一列。 */
export const KEY_TO_PROP = Object.fromEntries(
  Object.values(STAT_TYPES).map(t => [t.key, t.prop]))

/** enka 字符串 prop → miao 短 key；认不出返回 null（不猜） */
export const enkaPropKey = (prop: string): string | null => ENKA_PROP_TO_KEY[prop] || null

/* 固定值那三项（生命/攻击/防御）：游戏里一律显整数 */
const FIXED_PROPS = new Set([StatType.HP, StatType.ATTACK, StatType.DEFENSE])

/* 一个 miao key 在游戏里是不是「整数口径」—— 固定值三项 + 元素精通。
   显示层用它决定收整到 0 位还是按百分比舍 1 位（见 service/view.ts 的 attrValueText）：
   这四类一律显整数，不存在「209.1」这种值。 */
export const isIntegerStatKey = (key: string): boolean => {
  const prop = KEY_TO_PROP[key]
  return prop === StatType.ELEMENTAL_MASTERY || FIXED_PROPS.has(prop)
}

/* 一条词条 = 类型 + 数值。类型用 enka 的字符串 prop 表示 —— 和 `sub_stats` 落库的形状一致，
   存读对称、不用来回换名；拿 miao 短 key 走 `key` getter（内核的词汇，只在显示/对数值时用）。 */
export class Stat {
  /* 字段必须显式声明（TS 不从 constructor 的 `this.x = ...` 反推） */
  prop: string
  value: number | null

  constructor (prop: string, value: unknown) {
    this.prop = prop
    /* 词条数值一律 number|null，在这儿转唯一的一次 —— 下游（subStatTotals / enkaNumsOf）直接信任它 */
    this.value = num(value)
  }

  /** miao 短 key（cpct / hpPlus …）；认不出返回 null */
  get key (): string | null { return enkaPropKey(this.prop) }
}

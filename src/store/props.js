/*
 * props —— enka 的字符串 prop id ↔ miao 的词条短 key
 *
 * 为什么需要这张表：**显示数值**要用 enka 的原始 statValue，而 enka 给的是字符串
 * （`FIGHT_PROP_HP_PERCENT`），页面/内核用的是 miao 的短 key（`hp`）。两者得对起来。
 *
 * ⚠️ 别拿 `src/i18n/index.js` 的 `STAT_PROP` 来对数值 —— 那张表的方向是**反的**：
 *   它给 `hp → FIGHT_PROP_HP`、`hpPlus → FIGHT_PROP_HP_PERCENT`，看着像「大生命=HP」，
 *   但 enka 的 `FIGHT_PROP_HP` 是**固定值**（满级花主词条 4780），对应 miao 的 `hpPlus`（小生命），
 *   而 `FIGHT_PROP_HP_PERCENT`（46.6%）才对应 `hp`（大生命）。
 *   它只用于查官方文案名，而官方这两条文案都叫「生命值」，所以查名上看不出错；
 *   一旦拿它对数值，大/小生命就整个调个个儿。三对都这样：hp / atk / def 与各自 Plus。
 *
 * 判据来自 miao 自己的 `mainIdMap`（数字 id → key）：`14001 → hpPlus`、`15002 → hp`，
 * 而 enka 同一件分别给 `FIGHT_PROP_HP`(4780) 与 `FIGHT_PROP_HP_PERCENT`(46.6%) —— 见 test/pipeline.mjs。
 */
export const ENKA_PROP_TO_KEY = {
  FIGHT_PROP_HP: 'hpPlus',            // 固定值（小生命）
  FIGHT_PROP_HP_PERCENT: 'hp',        // 百分比（大生命）
  FIGHT_PROP_ATTACK: 'atkPlus',       // 固定值（小攻击）
  FIGHT_PROP_ATTACK_PERCENT: 'atk',   // 百分比（大攻击）
  FIGHT_PROP_DEFENSE: 'defPlus',      // 固定值（小防御）
  FIGHT_PROP_DEFENSE_PERCENT: 'def',  // 百分比（大防御）
  FIGHT_PROP_ELEMENT_MASTERY: 'mastery',
  FIGHT_PROP_CHARGE_EFFICIENCY: 'recharge',
  FIGHT_PROP_CRITICAL: 'cpct',
  FIGHT_PROP_CRITICAL_HURT: 'cdmg',
  FIGHT_PROP_HEAL_ADD: 'heal',
  FIGHT_PROP_ADD_HURT: 'dmg',
  FIGHT_PROP_PHYSICAL_ADD_HURT: 'phy',
  FIGHT_PROP_FIRE_ADD_HURT: 'pyro',
  FIGHT_PROP_ELEC_ADD_HURT: 'electro',
  FIGHT_PROP_WATER_ADD_HURT: 'hydro',
  FIGHT_PROP_GRASS_ADD_HURT: 'dendro',
  FIGHT_PROP_WIND_ADD_HURT: 'anemo',
  FIGHT_PROP_ROCK_ADD_HURT: 'geo',
  FIGHT_PROP_ICE_ADD_HURT: 'cryo'
}

/** enka 字符串 prop id → miao key；认不出返回 null（不猜） */
export const enkaPropKey = (prop) => ENKA_PROP_TO_KEY[prop] || null

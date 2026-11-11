/*
 * YSIN 预设基准数据 —— 甘雨·融化
 *
 * 这些数都不是从你的账号来的，是角色·流派写死的预设：
 *   · bench / 单条常数 / 装备基线：docs/词条分的数学模型.md §1.4、§3.2、附录 D.1
 *   · dmgDefault = 62095：网页 school.dText 直接可读（默认整套 + bench + 配平，技能 999）
 *   · 霜华矢两段倍率：vendor/miao/resources/meta-gs/character/甘雨/data.json 的 talent.a 两张表
 *
 * 倍率表用「两段之和」而不是单段，是因为 YSIN 的分子就是「霜华矢（两段）期望」。
 * 两段倍率随等级同比例增长，所以取和或分别加权，等级倍率比都一样。
 *
 * ⚠️ YSIN v4.8（2022-08）的等级倍率与当前上游数据差 0.1%：
 *    上游表 9→10 = 622.08/587.52 = 1.058824
 *    网页实测 9→10 = 105983/100189 = 1.057831
 * 单独看整数分都给 171，分辨不出来；但叠上 1 命的抗性倍率 1.138889 之后，
 * 1.058824 会算出 194.57 → 195，而线上是 194。所以 10 级用引擎实测值标定，
 * 其余等级回退到上游表。这条是「复现 YSIN」而不是「复现游戏」的必要取舍。
 *
 * 命座：甘雨 1 命「饮露」让霜华矢 / 绽发命中时敌人冰抗降低 15%（data.json 的 cons.1）。
 * 默认敌人小宝冰抗 10%，抗性乘区 0.9 → 1.025，倍率 1.138889。
 * 2~6 命都不改这个单次伤害数值（2 命加 E 次数、3/5 命加天赋等级、4 命是领域易伤、
 * 6 命免蓄力），网页实测 1 命 / 2 命 / 6 命分数逐位相同，所以表里只给 1 命那一项。
 */
import type { GearBasis, SchoolPreset } from './score.ts'

/** 阿莫斯之弓 1 精 / 乐团 4 件 / 攻冰爆 / 90 级 0 命 */
export const GAN_YU_BASIS: GearBasis = {
  baseAtk: 943,
  atkPct: 0.496 + 0.466, // 武器 49.6% + 沙漏 46.6%
  flatAtk: 311, // 羽毛
  baseCpct: 0.25, // 5% 基础 + 天赋 20%（YSIN 把它摊进全局面板）
  baseCdmg: 1.506, // 50% 基础 + 爆伤头 + 突破
  baseMastery: 80
}

/** 霜华矢命中伤害，下标 = 显示等级 − 1 */
const FROST_FLAKE_HIT = [
  128, 137.6, 147.2, 160, 169.6, 179.2, 192, 204.8, 217.6,
  230.4, 243.2, 256, 272, 288, 304
]

/** 霜华矢·霜华绽发伤害，下标 = 显示等级 − 1 */
const FROST_FLAKE_BLOOM = [
  217.6, 233.92, 250.24, 272, 288.32, 304.64, 326.4, 348.16, 369.92,
  391.68, 413.44, 435.2, 462.4, 489.6, 516.8
]

export const FROST_FLAKE_SCALE: readonly number[] =
  FROST_FLAKE_HIT.map((v, i) => v + FROST_FLAKE_BLOOM[i])

export const GAN_YU_MELT: SchoolPreset = {
  name: '甘雨·融化',
  bench: { atk: 4, em: 3, cpct: 9, cdmg: 9 },
  coreTalent: 'a', // 霜华矢挂在普通攻击天赋；升 Q 不影响这个分子
  talentScale: FROST_FLAKE_SCALE,
  // 网页实测 dmgYou(10)/dmgYou(9)，见文件头说明
  talentRatioOverride: { 9: 1, 10: 105983 / 100189 },
  enemyRes: 0.1, // 小宝冰抗 10%
  consResShred: [0.15, 0, 0, 0, 0, 0], // 只有 1 命降抗
  dmgDefault: 62095,
  defaultBasis: GAN_YU_BASIS,
  reaction: true
}

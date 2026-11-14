/*
 * YSIN 板块组装器 —— 把「一个角色的词条统计 + 全量流派预设」拼成前端能直接画的视图。
 *
 * 口径（与 docs/wireframe/05-ysin.html 一致）：
 *  - 两个分数取 computeScores 的 subScore / gearScore；不用 ysin.ts 里那个近似 score.value。
 *  - 词条对照用不配平的真实面板读数；基准列用 balancedBench，双爆两行另标原始值。
 *  - 「其中武器」是「你的」的一部分，没有贡献给 null，前端画破折号。
 *  - 流派数据一次性全给，前端切换只重画，不再请求。
 */
import { toMiaoProfile } from '../../gateway/miao/materialize.ts'
import { evaluateCharacter } from '../../gateway/ysin/ysin.ts'
import type { Rolls } from '../../gateway/ysin/score.ts'
import { presetOf, schoolsFor } from '../../gateway/ysin/schools.ts'
import * as i18n from '../../common/i18n.ts'
import { statLabel } from '../artifact.service.ts'
import type { CharacterDbo } from '../../repository/dbo/character.ts'
import type { YsinRow, YsinSchoolView, YsinScoreView, YsinView } from '../dto/ysin.dto.ts'

/* 表格四行的顺序，也是展示用的四个词条键。stat 是词条名查表用的键。
   充能只进 f_u（雷神），不进这张四行表，归到「未计入」 */
type DisplayRollKey = 'atk' | 'em' | 'cpct' | 'cdmg'
const ROWS: Array<{ key: DisplayRollKey, stat: string }> = [
  { key: 'atk', stat: 'atk' },
  { key: 'em', stat: 'mastery' },
  { key: 'cpct', stat: 'cpct' },
  { key: 'cdmg', stat: 'cdmg' }
]

/** 天赋槽的界面文字，跟着语言走 */
function slotLabel (slot: string, locale: string): string {
  return i18n.uiText(slot === 'e' ? 'talentE' : slot === 'q' ? 'talentQ' : 'talentA', locale)
}

/** 网站只给中文技能名；官方文案表查得到就翻译，查不到就保留原文 */
function skillLabel (zh: string, locale: string): string {
  return i18n.fromZh(zh, locale) ?? zh
}

/** 一个角色 → YSIN 板块；没有匹配流派 / 搭不出面板时返回 null */
export async function ysinViewOf (ch: CharacterDbo, locale: string): Promise<YsinView | null> {
  const profile = toMiaoProfile(ch)
  if (!profile) return null
  const charName = profile.char.name
  const group = schoolsFor(profile.id)
  if (!group || !group.schools.length) return null

  const ysin = await evaluateCharacter(ch)
  if (!ysin) return null

  /* 面板上七个属性的词条数，按 key 查 */
  const byKey = new Map(ysin.stats.map(s => [s.key, s.rolls]))
  const rolls: Rolls = {
    atk: byKey.get('atk') ?? 0,
    em: byKey.get('mastery') ?? 0,
    cpct: byKey.get('cpct') ?? 0,
    cdmg: byKey.get('cdmg') ?? 0
  }
  /* 三维之外不进当前模型，合成一行「未计入」 */
  let uncounted = 0
  for (const key of ['hp', 'def', 'recharge']) uncounted += byKey.get(key) ?? 0

  const talent = (profile.talent || {}) as Record<string, number>
  const talents = {
    a: talent.a ?? 9,
    e: talent.e ?? 9,
    q: talent.q ?? 9
  }

  const schools: YsinSchoolView[] = group.schools.map(seed => {
    const preset = presetOf(seed)
    /* 分数由网关 evaluateCharacter 用同一份 basis / rolls / preset 预先算好，
       这里直接取，避免两条计算路径出现漂移。详见 ysin.ts 的 scores 字段。 */
    const result = ysin.scores[seed.id]

    const rows: YsinRow[] = ROWS.map(({ key, stat }) => ({
      key,
      label: statLabel(stat, locale),
      yours: rolls[key],
      weapon: ysin.weaponByKey[stat] ?? null,
      bench: result.balancedBench[key],
      /* 配平只在双爆之间搬运，所以只有这两行需要标原始值 */
      originalBench: (key === 'cpct' || key === 'cdmg') ? preset.bench[key] : null
    }))

    const benchTotal = Object.values(seed.bench).reduce((a, b) => a + b, 0) +
      Object.values(seed.extraBench).reduce((a, b) => a + b, 0)

    return {
      id: seed.id,
      name: seed.name,
      skillName: skillLabel(seed.skill, locale),
      talentSlot: slotLabel(seed.talentSlot, locale),
      talentLevel: talents[preset.coreTalent],
      subScore: result.subScore,
      gearScore: result.gearScore,
      benchTotal,
      tagTotal: ysin.siteTagTotals[seed.id] ?? 0,
      rows,
      uncounted,
      dmgYou: result.dmgYou,
      dmgBench: result.dmgBench,
      dmgDefault: result.dmgDefault,
      dmgCrit: result.dmgCrit,
      wText: seed.wText,
      aText: seed.aText
    }
  })

  return {
    charName,
    total: ysin.total,
    /* 兼容字段：整装有效词条扣掉武器副词条，口径与角色 / 套装无关，界面不显示它 */
    counted: ysin.artifactTotal,
    schools,
    current: schools[0]?.id ?? ''
  }
}

/**
 * 一个角色 → 分数摘要（首页卡片那一小块用）。
 *
 * 只取**第一个流派**的词条分 / 数据分 —— 明细页默认选中的也是第一个（见上面的 current），
 * 两边得对上同一个数，不然首页和明细页会各说各话。
 * 没有适用流派（网站没有这个角色的流派数据）或 miao 不认识这个角色 → 两个分数都是 null，
 * 前端画破折号。这里不做任何换算，也不共用 miao 的评级。
 */
export async function ysinScoreOf (ch: CharacterDbo): Promise<YsinScoreView> {
  const avatarId = ch.avatarId!
  const ysin = await evaluateCharacter(ch)
  const seed = ysin ? schoolsFor(avatarId)?.schools[0] : null
  const result = seed ? ysin?.scores[seed.id] : null
  return {
    avatarId,
    subScore: result ? result.subScore : null,
    gearScore: result ? result.gearScore : null
  }
}

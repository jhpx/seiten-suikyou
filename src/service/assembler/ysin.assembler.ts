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
import type { YsinRow, YsinSchoolView, YsinView } from '../dto/ysin.dto.ts'

/* 表格四行的顺序，也是 Rolls 的字段顺序。stat 是词条名查表用的键 */
const ROWS: Array<{ key: keyof Rolls, stat: string }> = [
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
export function ysinViewOf (ch: CharacterDbo, locale: string): YsinView | null {
  const profile = toMiaoProfile(ch)
  if (!profile) return null
  const charName = profile.char.name
  const group = schoolsFor(charName)
  if (!group || !group.schools.length) return null

  const ysin = evaluateCharacter(ch)
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
    const preset = presetOf(charName, seed)
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
      rows,
      uncounted,
      dmgYou: result.dmgYou,
      dmgBench: result.dmgBench,
      dmgDefault: result.dmgDefault,
      wText: seed.wText,
      aText: seed.aText
    }
  })

  return {
    charName,
    total: ysin.total,
    counted: ysin.score.rolls,
    schools,
    current: schools[0]?.id ?? ''
  }
}

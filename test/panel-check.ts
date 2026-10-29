/*
 * 面板对拍 —— 拿「游戏自己算好的面板」检验「我们喂给 miao 的数据有没有翻错」
 *
 * 只在测试里用（test/pipeline.ts 拿它硬断言），不进生产路径 —— 所以它待在 test/ 而不是 src/kernel/。
 * 喂错数据很难从分数上看出来（一个副词条权重看错，总分可能只差 2 分）。而 enka 的
 * avatarInfo.fightPropMap 是游戏客户端算出来的最终面板、也就是标准答案 —— 拿它跟 miao 算出的 attr
 * 一比，角色等级/突破、武器、圣遗物主副词条整条链路一次全验。
 */
/* fightPropMap 的键是游戏协议写死的 prop id（2000 = 最终生命……）；第三列是「换算到 miao 口径」
   要乘的系数 —— 百分比那边 enka 给小数、miao 给百分数，所以要 ×100。 */
import type { EnkaAvatarInfo, EnkaPayload } from '../src/dbo/enka.ts'
import type { MiaoProfile } from '../src/gateway/miao/materialize.ts'

const FIGHT_PROPS: Array<[string, string, number]> = [
  ['2000', 'hp', 1],
  ['2001', 'atk', 1],
  ['2002', 'def', 1],
  ['28', 'mastery', 1],
  ['20', 'cpct', 100],
  ['22', 'cdmg', 100],
  ['23', 'recharge', 100],
  ['40', 'pyro', 100],
  ['41', 'electro', 100],
  ['42', 'hydro', 100],
  ['43', 'dendro', 100],
  ['44', 'anemo', 100],
  ['45', 'geo', 100],
  ['46', 'cryo', 100],
  ['47', 'phy', 100]
]

/* 容差（实测 12 个角色 / 84 项，最大偏差 0.0402%，出在暴击率上）：绝对值 ≤ 0.05（源头只两位小数，
   这个量级是精度不是错误）**或**相对值 ≤ 0.1%（基础属性取整被百分比放大后仍在范围内）。两条满足一条
   就算过 —— 真翻错了偏差是百分之几，混不过去。 */
export const REL_TOL = 0.001
export const ABS_TOL = 0.05

/** 比一个角色。返回 null 表示没得比（缺 fightPropMap 或 miao 不认识） */
export function diffPanel (avatarInfo: EnkaAvatarInfo | null | undefined, profile: MiaoProfile | null | undefined) {
  if (!avatarInfo || !profile) return null
  const gamePanel = avatarInfo.fightPropMap
  const ourAttr = profile.attr
  if (!gamePanel || !ourAttr) return null

  const rows: Array<{ key: string; game: number; ours: number; diff: number; rel: number; ok: boolean }> = []
  for (const [propId, key, scale] of FIGHT_PROPS) {
    const raw = gamePanel[propId]
    if (raw === undefined) continue          // 游戏不给的项（比如没有物理伤害加成就整条不发）
    const ours = ourAttr[key]
    if (ours === undefined) continue
    const game = Number(raw) * scale
    const diff = ours - game
    const rel = Math.abs(game) > 0.001 ? Math.abs(diff) / Math.abs(game) : Math.abs(diff)
    rows.push({ key, game, ours, diff, rel, ok: Math.abs(diff) <= ABS_TOL || rel <= REL_TOL })
  }
  if (!rows.length) return null
  const worst = rows.reduce((a, b) => (b.rel > a.rel ? b : a))
  return { name: profile.char?.name || String(profile.id), rows, worst, ok: rows.every(r => r.ok) }
}

/** 整包比。profileById 是 Map<avatarId, profile>（materialize 出来的） */
export function diffPanels (payload: EnkaPayload | null | undefined, profileById: Map<number, MiaoProfile>) {
  const list: Array<NonNullable<ReturnType<typeof diffPanel>>> = []
  for (const avatarInfo of payload?.avatarInfoList || []) {
    const id = avatarInfo.avatarId
    if (id === undefined) continue
    const profile = profileById.get(id)
    const panelDiff = profile ? diffPanel(avatarInfo, profile) : null
    if (panelDiff) list.push(panelDiff)
  }
  const worst = list.length ? list.reduce((a, b) => (b.worst.rel > a.worst.rel ? b : a)).worst : null
  return { list, worst, ok: list.length > 0 && list.every(d => d.ok) }
}

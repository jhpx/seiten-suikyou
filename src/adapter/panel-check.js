/*
 * 面板对拍 —— 拿「游戏自己算好的面板」检验「我们喂给 miao 的数据有没有翻错」
 *
 * 为什么值得做：分数算错的原因通常只有两类 —— 要么 miao 内核错了（不可能，我们是内嵌的），
 * 要么我们把它要的数据喂错了。而喂错这件事很难从分数上看出来：一个 7 分的副词条
 * 权重看错，总分可能只差 2 分，肉眼根本发现不了。
 * enka 的 avatarInfo 里带着 fightPropMap —— 那是游戏客户端自己算出来的最终面板，
 * 也就是「标准答案」。拿它和 miao 算出来的 panel 一比，整条链路（角色等级/突破、
 * 武器、圣遗物主副词条）有没有翻错，一目了然。
 *
 * 两个口径差异（实测确认，不是猜的）：
 *   1. 百分比类：enka 给小数（0.5673），miao 给百分数（56.73）→ 差 100 倍，得乘回来
 *   2. 两边的数都不是无限精度：
 *      · 源头的百分比只有两位小数（游戏给 1.5805，也就是 158.05%）
 *      · miao 元数据里的基础生命/攻击/防御是取了整的（迪卢克基础生命 11362.007，
 *        游戏给 11361.5996），再被百分比加成放大
 *      两条都不是我们的锅，所以容差按实测定的（见下面 REL_TOL 的注释）。
 */

/* enka fightPropMap 的键是游戏协议里写死的 prop id（2000 = 最终生命……），
   第三列是「换算到 miao 口径」要乘的系数 */
const FIGHT_PROPS = [
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

/*
 * 容差（实测 12 个角色 / 84 项对比的最大偏差是 0.0402%，出现在暴击率上）：
 *   · 绝对值 ≤ 0.05 —— 百分比源头只有两位小数，这个量级是精度不是错误
 *   · 或相对值 ≤ 0.1% —— 基础属性取整被百分比放大后仍应落在这个范围（实测最大 0.0192%）
 * 两条满足一条就算过。留的余量约 2.5 倍。
 * 底线：真翻错了（词条权重看错、套装效果漏算）偏差是百分之几，绝不可能混过去。
 */
export const REL_TOL = 0.001
export const ABS_TOL = 0.05

/* 比一个角色。返回 null 表示没得比（缺 fightPropMap 或 miao 不认识） */
export function diffPanel (avatarInfo, profile) {
  const fp = avatarInfo?.fightPropMap
  const attr = profile?.attr
  if (!fp || !attr) return null

  const rows = []
  for (const [fid, key, scale] of FIGHT_PROPS) {
    const raw = fp[fid]
    if (raw === undefined) continue          // 游戏不给的项（比如没有物理伤害加成就整条不发）
    const game = Number(raw) * scale
    const ours = attr[key]
    if (ours === undefined) continue
    const diff = ours - game
    const rel = Math.abs(game) > 0.001 ? Math.abs(diff) / Math.abs(game) : Math.abs(diff)
    const pass = Math.abs(diff) <= ABS_TOL || rel <= REL_TOL
    rows.push({ key, game, ours, diff, rel, ok: pass })
  }
  if (!rows.length) return null
  const worst = rows.reduce((a, b) => (b.rel > a.rel ? b : a))
  return { name: profile.char?.name || String(profile.id), rows, worst, ok: rows.every(r => r.ok) }
}

/* 整包比。profileById 是 Map<avatarId, profile>（materialize 出来的） */
export function diffPanels (payload, profileById) {
  const list = []
  for (const info of payload?.avatarInfoList || []) {
    const p = profileById.get(info.avatarId)
    if (!p) continue
    const d = diffPanel(info, p)
    if (d) list.push(d)
  }
  const worst = list.length ? list.reduce((a, b) => (b.worst.rel > a.worst.rel ? b : a)).worst : null
  return { list, worst, ok: list.length > 0 && list.every(d => d.ok) }
}

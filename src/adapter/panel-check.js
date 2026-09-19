/*
 * 面板对拍 —— 拿「游戏自己算好的面板」检验「我们喂给 miao 的数据有没有翻错」
 *
 * 喂错数据很难从分数上看出来：一个副词条权重看错，总分可能只差 2 分。
 * 而 enka 的 avatarInfo.fightPropMap 是游戏客户端自己算出来的最终面板，也就是标准答案 ——
 * 拿它跟 miao 算出来的 attr 一比，角色等级/突破、武器、圣遗物主副词条整条链路一次全验。
 */
/* enka fightPropMap 的键是游戏协议写死的 prop id（2000 = 最终生命……），
   第三列是「换算到 miao 口径」要乘的系数（百分比那边 enka 给小数、miao 给百分数） */
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
 * 容差（实测 12 个角色 / 84 项，最大偏差 0.0402%，出在暴击率上）：
 *   · 绝对值 ≤ 0.05 —— 源头百分比只有两位小数，这个量级是精度不是错误
 *   · 或相对值 ≤ 0.1% —— 基础属性取整被百分比放大后仍落在范围内
 * 两条满足一条就算过。真翻错了偏差是百分之几，混不过去。
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
    const ours = attr[key]
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

/* 整包比。profileById 是 Map<avatarId, profile>（materialize 出来的） */
export function diffPanels (payload, profileById) {
  const list = []
  for (const info of payload?.avatarInfoList || []) {
    const p = profileById.get(info.avatarId)
    const d = p ? diffPanel(info, p) : null
    if (d) list.push(d)
  }
  const worst = list.length ? list.reduce((a, b) => (b.worst.rel > a.worst.rel ? b : a)).worst : null
  return { list, worst, ok: list.length > 0 && list.every(d => d.ok) }
}

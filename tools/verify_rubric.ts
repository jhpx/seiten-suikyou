/*
 * 规则评分引擎保真验证（工具，不进 npm test）。
 * 思路：用 miao 自己造的 profile，跑 getMarkDetail（自动选规则）得到真值；
 * 再对角色的每个规则跑 scoreWithWeights，断言「至少有一个规则逐字等于真值」。
 * 若成立 → 引擎只是把"选哪套权重"从 miao 自动选换成了用户指定，数学与 miao 一致。
 * 覆盖三条适配分支：护摩(武器加生命) / 西风(暴击拉满) / 绝缘4(充能齐平)。
 */
import { ArtisMark } from '../src/index.ts'
import { buildProfile, type ArtisFixture } from '../test/fixtures.ts'
import { scoreWithWeights, getRubrics } from '../src/gateway/miao/rubric.ts'

const ATTR = { hp: 28000, atk: 1300, def: 800, cpct: 70, cdmg: 220, mastery: 250, recharge: 110, dmg: 46.6, heal: 0, phy: 0 }

function arrEq (a: Record<number, any>, b: Record<number, any>): boolean {
  const ka = Object.keys(a).sort(), kb = Object.keys(b).sort()
  if (ka.length !== kb.length) return false
  return ka.every(k => a[+k]._mark === b[+k]._mark)
}

function check (charName: string, weapon: { name: string; affix: number }, cons: number, attr: Record<string, number>, artisList?: ArtisFixture[]): boolean {
  const p = buildProfile(charName, { ...weapon, level: 90 }, cons, attr, artisList)
  const miao = ArtisMark.getMarkDetail(p, true) as any
  const list = getRubrics(p.id) || []
  let matched = 0
  let detail = ''
  for (const s of list) {
    const mine = scoreWithWeights(p, s.weights) as any
    const okMark = mine._mark === miao._mark
    const okWeight = JSON.stringify(mine.charWeight) === JSON.stringify(miao.charWeight)
    const okArtis = arrEq(mine.artis, miao.artis)
    if (okMark && okWeight && okArtis) {
      matched++
      if (!detail) detail = `首匹: ${s.name} (mark=${mine._mark}, charWeight 一致, 逐件一致)`
    }
  }
  const ok = matched >= 1
  console.log(`${ok ? 'OK ' : '!! '}${charName}(id=${p.id}) miao=${miao._mark} 规则${list.length}个 命中${matched} ${detail}`)
  return ok
}

let allOk = true
allOk = check('胡桃', { name: '护摩之杖', affix: 5 }, 0, ATTR) && allOk                       // 武器适配：护摩加生命
allOk = check('芙宁娜', { name: '西风剑', affix: 1 }, 0, { ...ATTR, hp: 20000, atk: 1000 }) && allOk  // 武器适配：西风暴击拉满
allOk = check('行秋', { name: '西风剑', affix: 5 }, 6, ATTR) && allOk                       // 武器适配：西风 + 高命座
allOk = check('迪希雅', { name: '苇海信标', affix: 1 }, 6, ATTR) && allOk                       // 无适配 + 高命座

console.log(allOk ? '\nPASS 引擎与 miao 逐字一致' : '\nFAIL 引擎与 miao 不一致')
process.exit(allOk ? 0 : 1)

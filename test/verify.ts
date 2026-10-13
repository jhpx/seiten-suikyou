/*
 * 评分验证 —— 端到端跑 miao 官方入口 ArtisMark.getMarkDetail
 *
 * 【为什么断言只在失败时打印】
 * 本脚本的 stdout 是「基线」。改完内核后跑
 *     npm run verify > .tmp/after.txt && diff .tmp/baseline.txt .tmp/after.txt
 * 逐字为空才算没跑偏。所以通过时保持静默，免得自己的断言输出把基线搅浑；
 * 一旦有断言不通过，会插一段 [FAIL] 并让退出码变 1。
 */
import { ArtisMark } from '../src/index.ts'
import { buildProfile, ATTR } from './fixtures.ts'

/** 内核返回的评分详情（vendored JS，TS 只推得到 `{}`）—— 按我们真正读到的字段命名 */
interface MarkResult {
  classTitle?: string
  mark?: string
  markClass?: string
  sets?: Record<string, number>
  charWeight?: Record<string, number>
  artis: Record<string, { mark: string; markClass: string; _mark: number; main: { _mark: number } }>
}

let failed = 0

function same (actual: unknown, expected: unknown, label: string): void {
  if (JSON.stringify(actual) === JSON.stringify(expected)) return
  failed++
  console.log(`\n[FAIL] ${label}\n        期望 ${JSON.stringify(expected)}\n        实际 ${JSON.stringify(actual)}`)
}

console.log('=== 1. 基础评分（胡桃 / 护摩之杖 / 0命）===')
const p = buildProfile('胡桃', { name: '护摩之杖', affix: 1, level: 90 }, 0, ATTR)
const r = ArtisMark.getMarkDetail(p, true) as MarkResult
console.log('场景:', r.classTitle)
console.log('总分:', r.mark, '| 档位:', r.markClass)
console.log('各件:', Object.entries(r.artis).map(([i, a]) => `${i}号:${a.mark}(${a.markClass})`).join('  '))
console.log('套装:', JSON.stringify(r.sets))
console.log('权重:', JSON.stringify(r.charWeight))
console.log('\n3号位（精通沙）详情:')
console.log(JSON.stringify(r.artis['3'], null, 2))

same(r.classTitle, '胡桃-护摩', '场景名')
same(r.mark, '191.3', '总分')
same(r.markClass, 'SS', '总档位')
same(
  Object.fromEntries(Object.entries(r.artis).map(([i, a]) => [i, `${a.mark}(${a.markClass})`])),
  { 1: '38.8(SS)', 2: '28.3(S)', 3: '36.8(SS)', 4: '40.2(SS)', 5: '47.1(SSS)' },
  '各件得分/档位'
)
same(r.sets, { 炽烈的炎之魔女: 4 }, '套装统计')
same(r.charWeight, { atk: 50, atkPlus: 50, hp: 90, hpPlus: 90, cpct: 100, cdmg: 100, mastery: 75, dmg: 100 }, '生效权重')
// 下面两个是未取整的原始值：取整后的 mark 会掩盖细微漂移，这里盯住源头
same(r.artis['3']._mark, 36.84341501101314, '3号位 _mark（未取整）')
same(r.artis['3'].main._mark, 150.42827541827543, '3号位主词条 _mark（未取整）')

console.log('\n=== 2. 动态性验证：同一套圣遗物，换武器/命座/面板 ===')
/* ⚠️ 2026-10-06 同步上游后改了基线，两处都是**上游的既定变更**，不是我方回归：
 *   ① 「核爆胡桃」这个面板特判没了 —— 上游删了 `胡桃/artis.js`（现为 75 个角色有，
 *      原来 76 个），面板特判改由 `calc_auto.js` 那套伤害计算表达，而那条链路我们没搬。
 *      低暴击高爆伤面板现在走通用规则（护摩 + 低暴击仍判护摩场景）。
 *   ② 芙宁娜 154.0 → 151.5 —— 上游把她的 recharge 权重 75 提到 100。
 *      同步后若哪天回到 154.0，说明权重表被回退了，要查。 */
const cases: Array<[string, { name: string; affix: number; level?: number }, number, Record<string, number>, string[]]> = [
  ['护摩之杖 / 0命 / 常规面板', { name: '护摩之杖', affix: 1 }, 0, ATTR, ['胡桃-护摩', '191.3', 'SS']],
  ['西风长枪 / 0命 / 常规面板', { name: '西风长枪', affix: 5 }, 0, ATTR, ['胡桃-通用', '195.8', 'SS']],
  ['护摩之杖 / 6命 / 常规面板', { name: '护摩之杖', affix: 1 }, 6, ATTR, ['胡桃-护摩', '191.3', 'SS']],
  /* 核爆面板：上游删了胡桃的 artis.js 之后，低暴击高爆伤不再切场景，
     带护摩就还是护摩场景（下面这条钉住的就是「不再切」这件事）。 */
  ['护摩之杖 / 0命 / 核爆面板(低暴击高暴伤)', { name: '护摩之杖', affix: 1 }, 0, { ...ATTR, cpct: 10, cdmg: 300 }, ['胡桃-护摩', '191.3', 'SS']]
]
for (const [label, weapon, cons, attr, expected] of cases) {
  const rr = ArtisMark.getMarkDetail(buildProfile('胡桃', weapon, cons, attr), false) as MarkResult
  console.log(`${label}\n  场景=${rr.classTitle}  总分=${rr.mark}  档位=${rr.markClass}`)
  same([rr.classTitle, rr.mark, rr.markClass], expected, `动态分支 ${label}`)
}

console.log('\n=== 3. 跨角色验证 ===')
const crossExpected: Record<string, string[]> = {
  /* 151.5 是同步上游后的值（recharge 75 → 100）。见上面第 2 节的说明。 */
  芙宁娜: ['芙宁娜-通用', '151.5', 'S'],
  纳西妲: ['纳西妲-通用', '206.1', 'SS'],
  钟离: ['钟离-月共鸣武神', '199.9', 'SS'],
  班尼特: ['班尼特-输出', '157.0', 'S']
}
for (const name of Object.keys(crossExpected)) {
  const rr = ArtisMark.getMarkDetail(buildProfile(name, { name: '', affix: 1 }, 0, ATTR), false) as MarkResult
  console.log(`${name}: 场景=${rr.classTitle} 总分=${rr.mark} 档位=${rr.markClass}`)
  same([rr.classTitle, rr.mark, rr.markClass], crossExpected[name], `跨角色 ${name}`)
}

if (failed > 0) console.log(`\n[FAIL] 共 ${failed} 项评分与基线不符`)
process.exit(failed > 0 ? 1 : 0)

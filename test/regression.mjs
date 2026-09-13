/*
 * 回归测试 —— 上游 miao 更新后的对齐安全网
 *
 * 设计原则：
 *   - 硬断言：算法常量变了就是破坏性变更，必须 fail
 *   - 软校验：角色数/权重这类会随版本增长的，只 warn 不 fail，避免误报
 *
 * 与 arch.mjs 的分工：本文件管「分数算得对不对」，arch.mjs 管「内核怎么拼起来的」。
 *
 * 用法：npm test
 */
import { ArtisMark, ArtisMarkCfg, Meta } from '../src/index.js'
import { buildProfile, ATTR } from './fixtures.mjs'

let failed = 0
let warned = 0

function eq (actual, expected, label) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  console.log(`${ok ? '[PASS]' : '[FAIL]'} ${label}${ok ? '' : `\n        期望 ${JSON.stringify(expected)}\n        实际 ${JSON.stringify(actual)}`}`)
  if (!ok) failed++
}

function watch (actual, expected, label) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  console.log(`${ok ? '[ ok ]' : '[WARN]'} ${label}${ok ? '' : `\n        记录值 ${JSON.stringify(expected)}\n        当前值 ${JSON.stringify(actual)}  ← 上游可能已更新，请确认`}`)
  if (!ok) warned++
}

console.log('=== 硬断言：算法常量 ===')
const arti = Meta.getMeta('gs', 'arti')
eq(arti.attrMap?.cpct?.value, 3.885, '暴击率单档标准值 = 3.885')
eq(arti.attrMap?.cdmg?.value, 7.77, '暴伤单档标准值 = 7.77')
eq(ArtisMark.getMarkClass(0), 'D', '档位下限 0 → D')
eq(ArtisMark.getMarkClass(27.9), 'A', '档位 27.9 → A')
// 超出 MAX 档（70）后源码循环走完没有 return，即 undefined
eq(ArtisMark.getMarkClass(100), undefined, '档位 100 → 超出 MAX')

console.log('\n=== 硬断言：真实圣遗物得分落在 0~66 ===')
const real = ArtisMark.getMarkDetail(buildProfile('胡桃', { name: '', affix: 1 }, 0, ATTR), false)
const marks = Object.values(real.artis).map((a) => a._mark)
console.log(`        各件得分 = ${marks.map((m) => m.toFixed(1)).join(', ')}`)
eq(marks.every((m) => m >= 0 && m <= 66), true, '每件得分都在 0~66 区间')
eq(marks.length, 5, '五件圣遗物都有分')

console.log('\n=== 软校验：随版本可能变化 ===')
watch(Object.keys(arti.usefulAttr || {}).length, 119, '默认权重表角色数')
watch(arti.usefulAttr?.['胡桃'], { hp: 80, atk: 50, def: 0, cpct: 100, cdmg: 100, mastery: 75, dmg: 100, phy: 0, recharge: 0, heal: 0 }, '胡桃默认权重')

const noWeapon = ArtisMarkCfg.getCfg(buildProfile('胡桃', { name: '', affix: 1 }, 0, ATTR))
watch(
  Object.fromEntries(Object.entries(noWeapon.attrs).map(([k, v]) => [k, v.weight])),
  { atk: 50, atkPlus: 50, hp: 80, hpPlus: 80, cpct: 100, cdmg: 100, mastery: 75, dmg: 100 },
  '胡桃无武器时实际权重'
)
watch(real.artis['5'].mark, '47.6', '胡桃5号位（暴击头）得分基准')

console.log(`\n结果：失败 ${failed} 项，需确认 ${warned} 项`)
process.exit(failed > 0 ? 1 : 0)

/*
 * 评分验证：构造真实 profile，跑 miao 官方入口 ArtisMark.getMarkDetail
 *
 * 这一步的意义：证明垫片不只是"能 import"，而是算出来的分跟 miao 一致。
 */
import { ArtisMark } from '../src/index.js'
import { buildProfile, ATTR } from './fixtures.mjs'

console.log('=== 1. 基础评分（胡桃 / 护摩之杖 / 0命）===')
const p = buildProfile('胡桃', { name: '护摩之杖', affix: 1, level: 90 }, 0, ATTR)
const r = ArtisMark.getMarkDetail(p, true)
console.log('场景:', r.classTitle)
console.log('总分:', r.mark, '| 档位:', r.markClass)
console.log('各件:', Object.entries(r.artis).map(([i, a]) => `${i}号:${a.mark}(${a.markClass})`).join('  '))
console.log('套装:', JSON.stringify(r.sets))
console.log('权重:', JSON.stringify(r.charWeight))
console.log('\n3号位（精通沙）详情:')
console.log(JSON.stringify(r.artis['3'], null, 2))

console.log('\n=== 2. 动态性验证：同一套圣遗物，换武器/命座/面板 ===')
const cases = [
  ['护摩之杖 / 0命 / 常规面板', { name: '护摩之杖', affix: 1 }, 0, ATTR],
  ['西风长枪 / 0命 / 常规面板', { name: '西风长枪', affix: 5 }, 0, ATTR],
  ['护摩之杖 / 6命 / 常规面板', { name: '护摩之杖', affix: 1 }, 6, ATTR],
  ['护摩之杖 / 0命 / 核爆面板(低暴击高暴伤)', { name: '护摩之杖', affix: 1 }, 0, { ...ATTR, cpct: 10, cdmg: 300 }]
]
for (const [label, weapon, cons, attr] of cases) {
  const rr = ArtisMark.getMarkDetail(buildProfile('胡桃', weapon, cons, attr), false)
  console.log(`${label}\n  场景=${rr.classTitle}  总分=${rr.mark}  档位=${rr.markClass}`)
}

console.log('\n=== 3. 跨角色验证 ===')
for (const name of ['芙宁娜', '纳西妲', '钟离', '班尼特']) {
  const rr = ArtisMark.getMarkDetail(buildProfile(name, { name: '', affix: 1 }, 0, ATTR), false)
  console.log(`${name}: 场景=${rr.classTitle} 总分=${rr.mark} 档位=${rr.markClass}`)
}

// 评分内核是纯计算，无残留 handle，脚本自然退出

/*
 * 冒烟测试 —— 证明 miao 评分内核能脱离云崽，在纯 Node 下独立加载
 *
 * 只查「加载得起来吗」，不查具体分数（那是 regression / verify 的事）。
 * 断言同样只在失败时打印。
 */
import { ArtisMark, Meta, Format } from '../src/index.ts'

let failed = 0
function eq (actual: unknown, expected: unknown, label: string): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (ok) return
  failed++
  console.log(`[FAIL] ${label}\n        期望 ${JSON.stringify(expected)}\n        实际 ${JSON.stringify(actual)}`)
}

console.log('=== 1. 模块加载 ===')
console.log('ArtisMark 已加载:', typeof ArtisMark.getMark === 'function')
console.log('Format.comma(1234.567):', Format.comma(1234.567))
console.log('Format.isElem("pyro"):', Format.isElem('pyro'))

eq(typeof ArtisMark.getMark, 'function', 'ArtisMark 可用')
/* 千分位分组来自 Cfg.get('commaGroup', 3)（上游 schema 的 def 也是 3）——
   断的是「带逗号」这一条：Cfg 替身一旦忘了给 def，数字就会静默丢掉千分位。 */
eq(Format.comma(1234.567), '1,235', 'Format.comma 取整 + 千分位分组')
eq(Format.isElem('pyro'), true, 'Format.isElem 认得出火元素')

console.log('\n=== 2. 元数据注册 ===')
const arti = Meta.getMeta('gs', 'arti')
console.log('attrMap 词条数:', Object.keys(arti.attrMap || {}).length)
console.log('usefulAttr 角色数:', Object.keys(arti.usefulAttr || {}).length)
console.log('暴击率标准值:', arti.attrMap?.cpct?.value)
console.log('胡桃默认权重:', JSON.stringify(arti.usefulAttr?.['胡桃']))

eq(Object.keys(arti.attrMap || {}).length, 13, 'attrMap 词条数')
eq(arti.attrMap?.cpct?.value, 3.885, '暴击率单档标准值')
eq(arti.attrMap?.cdmg?.value, 7.77, '暴伤单档标准值')

console.log('\n=== 3. 角色规则 ===')
const charMeta = Meta.create('gs', 'char')
console.log('角色数:', charMeta.getIds().length)
console.log('胡桃 meta.id:', charMeta.getId('胡桃'))

eq(charMeta.getId('胡桃'), 10000046, '胡桃的固定角色 ID')

console.log(failed > 0 ? `\n[FAIL] 冒烟测试有 ${failed} 项不通过` : '\n[OK] 内核加载正常，miao 评分模块在纯 Node 下可用（不依赖云崽）')
process.exit(failed > 0 ? 1 : 0)

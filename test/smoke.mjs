/*
 * 垫片层冒烟测试：证明 miao 评分内核能脱离云崽独立加载
 */
import { ArtisMark, Meta, Format } from '../src/index.js'

console.log('=== 1. 模块加载 ===')
console.log('ArtisMark 已加载:', typeof ArtisMark.getMark === 'function')
console.log('Format.comma(1234.567):', Format.comma(1234.567))
console.log('Format.isElem("pyro"):', Format.isElem('pyro'))

console.log('\n=== 2. 元数据注册 ===')
const arti = Meta.getMeta('gs', 'arti')
console.log('attrMap 词条数:', Object.keys(arti.attrMap || {}).length)
console.log('usefulAttr 角色数:', Object.keys(arti.usefulAttr || {}).length)
console.log('暴击率标准值:', arti.attrMap?.cpct?.value)
console.log('胡桃默认权重:', JSON.stringify(arti.usefulAttr?.['胡桃']))

console.log('\n=== 3. 角色规则 ===')
const charMeta = Meta.create('gs', 'char')
console.log('角色数:', charMeta.getIds().length)
console.log('胡桃 meta.id:', charMeta.getId('胡桃'))

console.log('\n[OK] 垫片层跑通，miao 内核已在纯 Node 下可用')

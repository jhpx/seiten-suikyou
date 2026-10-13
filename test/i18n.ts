/*
 * 多语言测试 —— 证明「id/hash → 各语言文案」这条路是通的
 *
 * 分两类：
 *   1. 正向：真实 id 在 chs / en 下都能取到名字（且两者不同 —— 只测「取到了」
 *      会漏掉「表其实只有中文、英文回落成中文」这种假阳性）
 *   2. 兜底：查不到时返回 null / 回落到默认语言，而不是崩或返回 key 本身给页面去显示
 *
 * 表不在时整段跳过并提示 —— 那是同步脚本的事，不该让测试红。
 */
import { i18n } from '../src/index.ts'

let failed = 0
let passed = 0
/* cond 收 unknown：调用点常传 `表值 && 判断` 这种「真值即可」的表达式 */
function ok (cond: unknown, label: string): void {
  if (cond) { passed++; return }
  failed++
  console.log(`[FAIL] ${label}`)
}
function eq (actual: unknown, expected: unknown, label: string): void {
  const good = JSON.stringify(actual) === JSON.stringify(expected)
  if (good) { passed++; return }
  failed++
  console.log(`[FAIL] ${label}\n        期望 ${JSON.stringify(expected)}\n        实际 ${JSON.stringify(actual)}`)
}

console.log('=== 1. 表是否在 ===')
ok(i18n.available(), '多语言表已同步（vendor/i18n/names.json）')
const locales = i18n.locales().map(l => l.code)
console.log('可用语言:', locales.join(', '))
ok(locales.length >= 1, '至少有一种语言')

if (!i18n.available()) {
  console.log('\n[跳过] 表不存在，跑一次 npm run sync:i18n 再来看')
  process.exit(0)
}

console.log('\n=== 2. 语言解析 ===')
eq(i18n.resolveLocale('zh-cn'), 'chs', 'zh-cn → chs')
eq(i18n.resolveLocale('zh-tw'), 'cht', 'zh-tw → cht')
eq(i18n.resolveLocale('jp'), 'ja', 'jp → ja')
eq(i18n.resolveLocale('kr'), 'ko', 'kr → ko')
eq(i18n.resolveLocale('xx'), 'chs', '认不出的语言回落到默认语言')
eq(i18n.resolveLocale(undefined), 'chs', '不传也回落到默认语言')

console.log('\n=== 3. 各类名字：中文 vs 英文 ===')
const av = i18n.avatarName(10000016, 'chs')
const avEn = i18n.avatarName(10000016, 'en')
console.log(`角色 10000016: chs=${av}  en=${avEn}`)
eq(av, '迪卢克', 'chs 角色名是迪卢克')
eq(avEn, 'Diluc', 'en 角色名是 Diluc')

/* 写死 id 是为了让「数据翻错了」能被测出来 —— 这两个都来自真实数据 */
const wId = 12502 // 狼的末路
const wCn = i18n.weaponName(wId, 'chs')
const wEn = i18n.weaponName(wId, 'en')
console.log(`武器 ${wId}: chs=${wCn}  en=${wEn}`)
eq(wCn, '狼的末路', 'chs 武器名是狼的末路')
ok(wEn && wEn !== wCn, 'en 武器名真的翻译了，不是回落到中文')

const sCn = i18n.slotName(3, 'chs')
const sEn = i18n.slotName(3, 'en')
console.log(`部位 3: chs=${sCn}  en=${sEn}`)
eq(sCn, '时之沙', 'chs 部位 3 是时之沙')
ok(sEn && sEn !== sCn, 'en 部位名真的翻译了')

console.log('\n=== 4. 词条名走 FIGHT_PROP_* ===')
eq(i18n.statName('cpct', 'chs'), '暴击率', 'chs 暴击率')
const cpEn = i18n.statName('cpct', 'en')
console.log('暴击率 en =', cpEn)
ok(cpEn && cpEn !== '暴击率', 'en 词条名真的翻译了')
eq(i18n.statName('不存在的key', 'en'), null, '认不出的词条返回 null，不把 key 丢给页面')

console.log('\n=== 5. hash 变体收敛到同一个名字组 ===')
/* 官方把同一段文案复用在几十处，enka 给哪个变体我们都得认 */
const raw = i18n.raw()
const someHash = Object.keys(raw.nameIndex)[0]
const group = i18n.name(someHash, 'chs')
console.log(`hash ${someHash} → ${group}`)
ok(typeof group === 'string' && group.length > 0, '任意变体 hash 都能解出名字')
eq(i18n.name('压根不存在的hash', 'en'), null, '认不出的 hash 返回 null')

console.log('\n=== 6. 中文反查（miao 的套装键是中文全名）===')
eq(i18n.fromZh('炽烈的炎之魔女', 'chs'), '炽烈的炎之魔女', 'chs 反查回自己')
const zEn = i18n.fromZh('炽烈的炎之魔女', 'en')
console.log('炽烈的炎之魔女 en =', zEn)
ok(zEn && zEn !== '炽烈的炎之魔女', 'en 反查能翻出来')
eq(i18n.fromZh('这套套装根本不存在', 'en'), null, '不存在的中文名返回 null')

console.log('\n=== 7. 界面文字表 ===')
eq(i18n.uiText('panelSection', 'chs'), '面板属性', 'chs 界面文字')
eq(i18n.uiText('panelSection', 'en'), 'Stats', 'en 界面文字')
eq(i18n.uiText('panelSection', 'xx'), '面板属性', '未知语言回落')
console.log('fetchDone(en) =', i18n.uiText('fetchDone', 'en'))
ok(i18n.uiText('fetchDone', 'en').includes('{n}'), '占位符没被提前吃掉')
const tbl = i18n.uiTable('ja')
ok(typeof tbl === 'object' && Object.keys(tbl).length > 10, '整张 ui 表能取出')

console.log(failed > 0
  ? `\n结果：通过 ${passed} 项，失败 ${failed} 项`
  : `\n结果：通过 ${passed} 项，失败 0 项`)
process.exit(failed > 0 ? 1 : 0)

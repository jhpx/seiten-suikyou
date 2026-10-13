/*
 * 伤害计算测试 —— 端到端跑 calcDamage（vendor 出口 ProfileDmg.calcData）
 *
 * 基线不是拍脑袋来的：.tmp/dmg-parity/run.ts 拿同一个 profile 过「原版 miao-plugin
 * 的 ProfileDmg」和「我方的 calcDamage」，逐条 diff 为空后才把数值落到这里。
 * 取 1 位小数硬断言 —— 公式或数据变了必须 fail，逼人确认是上游变了还是我们搬错了。
 *
 * 四个用例各管一种形状：
 *   胡桃      常规攻击流：半血被动火伤 + 护摩生命转攻击 + 蒸发反应系数
 *   可莉      命座参数条目（cons 过滤 + params 开关）与固定值条目（basic 模式 dmg(555)）
 *   瓦列里    没配 calc.js 的角色 → null，且不许抛
 *   旅行者火  旅行者按元素分目录的 calc.js + 天赋多段值（a3 的 [低空, 高空] 对）+ 夜魂
 */
import { Attr, Character } from '../src/index.ts'
import { calcDamage } from '../src/adapter/damage.ts'
import { toMiaoProfile } from '../src/adapter/materialize.ts'
import { buildProfile, buildArtis, ATTR } from './fixtures.ts'
/* 领域层的 Character 与 miao 的同名类不是一回事（见 domain/character.ts 的头注）——
   这里只要域模型，反手标成 Domain* 以免和上面的 miao Character 混。 */
import { Character as DomainCharacter } from '../src/domain/character.ts'

let failed = 0

function eq (actual: unknown, expected: unknown, label: string): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  console.log(`${ok ? '[PASS]' : '[FAIL]'} ${label}${ok ? '' : `\n        期望 ${JSON.stringify(expected)}\n        实际 ${JSON.stringify(actual)}`}`)
  if (!ok) failed++
}

/* 面板 attr 不手填 —— 走 miao 自己的 Attr.create().calc()，与生产链路（materialize）一致 */
function mkProfile (charName: string, weapon: { name: string; affix: number; level: number }): any {
  const profile: any = buildProfile(charName, weapon, 0, ATTR)
  profile.level = 90
  profile.promote = 6
  profile.talent = { a: 9, e: 9, q: 9 }
  profile.weapon.promote = 6
  profile.attr = Attr.create(profile).calc()
  return profile
}

/* 旅行者按元素分目录（旅行者/pyro/calc.js 与 data.json），且不装备武器 —— 两条边界一起测 */
function mkTraveler (): any {
  const char: any = Character.get({ id: 10000007, elem: 'pyro' })
  const profile: any = {
    isProfile: true, isGs: true, game: 'gs',
    id: char.id, elem: 'pyro', char,
    level: 90, promote: 6, cons: 0,
    weapon: { name: '', level: 1, promote: 0, affix: 1 },
    artis: buildArtis([]),
    talent: { a: 9, e: 9, q: 9 }
  }
  profile.attr = Attr.create(profile).calc()
  return profile
}

const num = (v: number | null) => v === null ? null : v.toFixed(1)

console.log('=== 1. 胡桃：护摩之杖 + 炽烈的炎之魔女4（常规攻击流 + 蒸发）===')
const hutao = await calcDamage(mkProfile('胡桃', { name: '护摩之杖', affix: 1, level: 90 }))
eq(hutao && hutao.entries.map((e) => ({ title: e.title, dmg: num(e.dmg), avg: num(e.avg) })), [
  { title: '半血开E重击', dmg: '129082.4', avg: '103096.6' },
  { title: '半血开E重击蒸发', dmg: '275667.5', avg: '220172.4' },
  { title: '半血开E后Q', dmg: '331896.3', avg: '265081.7' }
], '三条伤害（标题 + 暴击/期望）')
eq(hutao?.buffs, [
  '胡桃被动：半血获得33%火伤加成',
  '蝶引来生：开E获得2,858.0点攻击力加成',
  '元素精通：蒸发伤害提高42.4%',
  '护摩之杖：基于生命值上限，获得6,096.7的攻击力提升',
  '护摩之杖：角色生命低于50%时额外获得7,620.9攻击力（默认仅胡桃触发）'
], 'buff 列表（数值已内联进标题）')
eq(hutao?.createdBy, '喵喵', 'calc.js 署名')
eq(hutao?.enemyName, '小宝', '默认敌人（103 级）')
eq(hutao?.enemyLv, 103, '敌人等级')

console.log('\n=== 2. 可莉：四风原典 + 魔女4（命座参数条目 + 固定值条目）===')
const klee = await calcDamage(mkProfile('可莉', { name: '四风原典', affix: 1, level: 90 }))
eq(klee && klee.entries.map((e) => ({ title: e.title, dmg: num(e.dmg), avg: num(e.avg) })), [
  { title: '【魔导·秘仪】「嘭嘭轰击」伤害', dmg: '43124.2', avg: '43124.2' },
  { title: '【魔导·秘仪】「嘭嘭轰击」蒸发伤害', dmg: '92095.8', avg: '92095.8' },
  { title: '单次轰轰火花伤害', dmg: '6360.6', avg: '6360.6' },
  { title: '【魔导·秘仪】6命Q后「嘭嘭轰击」伤害', dmg: '43124.2', avg: '43124.2' },
  { title: '【魔导·秘仪】6命Q后「嘭嘭轰击」蒸发伤害', dmg: '92095.8', avg: '92095.8' }
], '五条伤害（cons_4/cons_6 参数条目按 params 过滤）')
eq(klee?.createdBy, '喵喵 & 冰翼', 'calc.js 署名')
eq(klee?.buffs?.length, 4, 'buff 条数')

console.log('\n=== 3. 瓦列里：没有 calc.js 的角色 → null 且不抛 ===')
const waley = await calcDamage(mkProfile('瓦列里', { name: '护摩之杖', affix: 1, level: 90 }))
eq(waley, null, '算不出就是 null')

console.log('\n=== 4. 旅行者（火）：按元素分目录的 calc.js + 夜魂 ===')
const traveler = await calcDamage(mkTraveler())
eq(traveler && traveler.entries.map((e) => ({ title: e.title, avg: num(e.avg) })), [
  { title: '6命夜魂加持普通攻击·一段伤害', avg: '141.3' },
  { title: '6命夜魂加持普通攻击·五段伤害', avg: '225.0' },
  { title: '（荧）6命夜魂加持重击伤害', avg: '407.3' },
  { title: '6命夜魂加持高空下落伤害', avg: '507.5' },
  { title: 'E点按每跳伤害', avg: '82.6' },
  { title: 'E长按伤害', avg: '290.6' },
  { title: 'E长按每跳伤害', avg: '239.5' },
  { title: 'Q技能伤害', avg: '1256.4' }
], '八条伤害（a3 天赋的 [低空, 高空] 成对取值也走通了）')
eq(traveler?.createdBy, '冰翼', 'calc.js 署名（旅行者七个元素全是冰翼写的）')
eq(traveler?.buffs, ['寒息：触发冰元素或水元素相关反应后，攻击力提升20.0%'], 'buff 列表')

console.log('\n=== 5. materialize 桥：域模型 → profile.talent ===')
/* 天赋等级是伤害计算的必填项（ProfileDmg.talent 读 profile.talent，缺了按 1 级算）。
   域模型存的是 {天赋id: 等级}，materialize 负责换算成 {a/e/q: 等级} —— 这里钉死它。 */
const domainChar = new DomainCharacter({
  uid: '900000001', avatarId: 10000046, level: 90, promote: 6, cons: 0,
  skillLevelMap: { 10461: 9, 10462: 9, 10463: 9 }
})
const mp = toMiaoProfile(domainChar)
eq(mp?.talent, { a: 9, e: 9, q: 9 }, 'skillLevelMap → {a, e, q}')
const dmgOf = await calcDamage(mp!)
eq(dmgOf && dmgOf.entries.map((e) => e.title), ['半血开E重击', '半血开E重击蒸发', '半血开E后Q'], '域模型直出也能算（裸装不校验数值，只校验条目结构）')

console.log(failed ? `\n[FAIL] ${failed} 项未过` : '\n全部通过 ✓')
process.exit(failed ? 1 : 0)

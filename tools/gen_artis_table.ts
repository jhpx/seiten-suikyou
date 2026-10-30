/**
 * 圣遗物评分总表生成器
 *
 * 从 vendor/miao 的规则实测出一张表，写到 docs/ 下：
 *   原神圣遗物评分场景总表：每个角色每个评分分支一行（触发条件 + 权重 + 依赖因子 + 触发样例）
 *   没有自定义规则的角色的兜底权重也占一行，所以这张表覆盖全部角色，不需要另开一张「每角色一行」的表。
 *
 * 怎么做的（两条线互相校验，不靠猜）：
 *   - 静态线：把 artis.js 解析成一棵 if 树，符号执行每条路径，还原出「触发条件」文字；
 *   - 动态线：用桩对象（def / rule / artis.is）实际执行规则函数，网格+随机采样探出每个分支的真实权重；
 *   - 两边按（场景名, 权重）配对，配不上的进警告，最后统一打印校验报告。
 *
 * 表里的权重是「规则原始权重」（artis.js 手写值 / usefulAttr 默认表原值），
 * 不含评分时内核才施加的武器套装适配（护摩之杖加生命、绝缘4 充能齐平、西风系暴击率拉满等）——
 * 那些依赖具体配装，列进来反而失真，详见 HTML 里的说明。
 *
 * 运行：node --disable-warning=ExperimentalWarning tools/gen_artis_table.ts
 */

import { readFileSync, readdirSync, existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { execSync } from 'node:child_process'
import * as artisMark from '../vendor/miao/resources/meta-gs/artifact/artis-mark.js'

const ROOT = join(fileURLToPath(import.meta.url), '..', '..')
const CHAR_DIR = join(ROOT, 'vendor/miao/resources/meta-gs/character')
const DOCS_DIR = join(ROOT, 'docs')

/* ------------------------------------------------------------------ */
/* 基础字典                                                            */
/* ------------------------------------------------------------------ */

type AttrKey = 'hp' | 'atk' | 'def' | 'cpct' | 'cdmg' | 'mastery' | 'dmg' | 'phy' | 'recharge' | 'heal'
const KEYS: AttrKey[] = ['hp', 'atk', 'def', 'cpct', 'cdmg', 'mastery', 'dmg', 'phy', 'recharge', 'heal']
const KEY_CN: Record<AttrKey, string> = {
  hp: '大生命', atk: '大攻击', def: '大防御', cpct: '暴击率', cdmg: '暴击伤害',
  mastery: '精通', dmg: '元素伤害', phy: '物理伤害', recharge: '充能', heal: '治疗'
}
const ATTR_CN: Record<string, string> = {
  hp: '生命', atk: '攻击', def: '防御', cpct: '暴击率', cdmg: '暴伤',
  mastery: '精通', recharge: '充能', heal: '治疗'
}
const MAIN_CN: Record<string, string> = {
  hp: '生命', atk: '攻击', def: '防御', mastery: '精通', recharge: '充能',
  heal: '治疗', dmg: '元素伤害', phy: '物理伤害', cpct: '暴击率', cdmg: '暴伤'
}
const ELEM_CN: Record<string, string> = {
  pyro: '火', hydro: '水', anemo: '风', electro: '雷', cryo: '冰', geo: '岩', dendro: '草', multi: '多'
}
const ELEM_ORDER = ['火', '水', '风', '雷', '冰', '岩', '草', '多']
const FACTOR_ORDER = ['面板', '武器', '命座', '套装', '元素']
const SETS = ['绝缘4', '影中沉凝的幻灭4', '血红之证4', '冰套4']
const WEAPON_SPECIALS = ['磐岩结绿', '猎人之径', '薙草之稻光', '护摩之杖', '西风剑', '西风长枪', '西风大剑', '西风猎弓', '西风秘典']

const usefulAttr = artisMark.usefulAttr as Record<string, Partial<Record<AttrKey, number>>>
/** 内核同款兜底：默认表查不到的角色用这套（ArtisMarkCfg.getCharArtisCfg） */
const FALLBACK_WEIGHT: Partial<Record<AttrKey, number>> = { atk: 75, cpct: 100, cdmg: 100, dmg: 100, phy: 100 }
const FALLBACK_TEXT = '通用兜底 {atk:75, cpct:100, cdmg:100, dmg:100, phy:100}'

/** 把任意权重对象补齐成 10 键，缺的当 0（内核 lodash.extend 也是这个语义） */
function norm (w: Partial<Record<AttrKey, number>> | undefined): Record<AttrKey, number> {
  const ret = {} as Record<AttrKey, number>
  for (const k of KEYS) ret[k] = Math.round((w?.[k] ?? 0) * 100) / 100
  return ret
}
const wKey = (w: Record<AttrKey, number>): string => KEYS.map(k => w[k]).join(',')

/* ------------------------------------------------------------------ */
/* 源码解析：artis.js → if 树                                          */
/* ------------------------------------------------------------------ */

type Stmt =
  | { k: 'let'; name: string; init: string }
  | { k: 'if'; cond: string; body: Stmt[] }
  | { k: 'push'; t: string }
  | { k: 'reset' }
  | { k: 'set'; key: string; val: string }
  | { k: 'sub'; n: number }
  | { k: 'retDef'; arg: string; titled: boolean }
  | { k: 'retRule'; t: string; w: Partial<Record<AttrKey, number>>; dyn?: boolean; sep?: string; fromState?: boolean }
  | { k: 'switchElem'; cases: { elem: string | null; body: Stmt[] }[] }
  | { k: 'nop' }

/** 字符串感知：从 start（必须是某个括号）找到配对的闭合括号 */
function findMatching (s: string, start: number): number {
  const pairs: Record<string, string> = { '(': ')', '[': ']', '{': '}' }
  const open = s[start]
  const close = pairs[open]
  let depth = 0
  for (let i = start; i < s.length; i++) {
    const c = s[i]
    if (c === "'" || c === '"' || c === '`') { i = skipString(s, i); continue }
    if (c === open) depth++
    else if (c === close) { depth--; if (depth === 0) return i }
  }
  throw new Error('括号不配对: ' + s.slice(start, start + 40))
}
function skipString (s: string, i: number): number {
  const q = s[i]
  let j = i + 1
  while (j < s.length) {
    if (s[j] === '\\') { j += 2; continue }
    if (s[j] === q) return j
    j++
  }
  return j
}
/** 括号/字符串感知地按分隔符切顶层 */
/** 括号/字符串感知地按分隔符切顶层（分隔符可以是 && 这种多字符的） */
function splitTop (s: string, sep: string): string[] {
  const out: string[] = []
  let depth = 0, start = 0
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (c === "'" || c === '"' || c === '`') { i = skipString(s, i); continue }
    if (c === '(' || c === '[' || c === '{') depth++
    else if (c === ')' || c === ']' || c === '}') depth--
    else if (depth === 0 && s.startsWith(sep, i)) {
      out.push(s.slice(start, i))
      i += sep.length - 1
      start = i + 1
    }
  }
  out.push(s.slice(start))
  return out
}
/** 解析 { hp: 0, atk: 75 } 这样的对象字面量 */
function parseObj (s: string): Partial<Record<AttrKey, number>> {
  const ret: Partial<Record<AttrKey, number>> = {}
  const re = /(\w+)\s*:\s*(-?\d+(?:\.\d+)?)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(s))) ret[m[1] as AttrKey] = Number(m[2])
  return ret
}

function classify (text: string): Stmt {
  let m: RegExpExecArray | null
  if ((m = /^let\s+(\w+)\s*=\s*([\s\S]+)$/.exec(text))) return { k: 'let', name: m[1], init: m[2].trim() }
  if ((m = /^title\.push\('([^']*)'\)$/.exec(text))) return { k: 'push', t: m[1] }
  if (/^title\s*=\s*\[\]$/.test(text)) return { k: 'reset' }
  if ((m = /^particularAttr\.(\w+)\s*=\s*([\s\S]+)$/.exec(text))) return { k: 'set', key: m[1], val: m[2].trim() }
  if ((m = /^recharge\s*-=\s*(\d+)$/.exec(text))) return { k: 'sub', n: Number(m[1]) }
  if ((m = /^return\s+def\s*\(([\s\S]*)\)$/.exec(text))) {
    const parts = splitTop(m[1], ',')
    return { k: 'retDef', arg: parts[0].trim(), titled: parts.length > 1 && parts[1].trim() !== '' }
  }
  if ((m = /^return\s+rule\s*\(\s*'([^']*)'\s*,\s*(\{[\s\S]*\})\s*\)$/.exec(text))) {
    return { k: 'retRule', t: m[1], w: parseObj(m[2]) }
  }
  // 模板字符串标题：rule(`钟离-${title.join('')}`, {...}) —— 前缀写死，后缀是运行时拼的分支名
  // 权重第二个参数也可能是变量名 particularAttr（芭芭拉/钟离），那就用符号状态里累积的权重
  // 注意别用 [^`$] 去圈前缀——模板内容里本来就有 $，会一个都匹配不上；先整串抓下来再截 ${ 之前
  if ((m = /^return\s+rule\s*\(\s*`([^`]*)`\s*,\s*([\s\S]+?)\s*\)$/.exec(text))) {
    const sep = /title\.join\('([^']*)'\)/.exec(text)
    const arg2 = m[2].trim()
    const fromState = arg2 === 'particularAttr'
    return {
      k: 'retRule',
      t: m[1].split('${')[0],
      w: fromState ? {} : parseObj(arg2),
      dyn: true, sep: sep ? sep[1] : '', fromState
    }
  }
  return { k: 'nop' }
}

/** 解析一段语句块（if 体内 / 函数体） */
function parseBlock (src: string): Stmt[] {
  const out: Stmt[] = []
  let i = 0
  while (i < src.length) {
    const c = src[i]
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') { i++; continue }
    if (src.startsWith('//', i)) { while (i < src.length && src[i] !== '\n') i++; continue }
    if (src.startsWith('/*', i)) { i += 2; while (i < src.length && !src.startsWith('*/', i)) i++; i += 2; continue }
    const rest = src.slice(i)
    let m: RegExpExecArray | null
    if ((m = /^if\s*\(/.exec(rest))) {
      const pOpen = i + m[0].length - 1
      const pClose = findMatching(src, pOpen)
      const cond = src.slice(pOpen + 1, pClose).trim()
      const bOpen = src.indexOf('{', pClose)
      const bClose = findMatching(src, bOpen)
      out.push({ k: 'if', cond, body: parseBlock(src.slice(bOpen + 1, bClose)) })
      i = bClose + 1
      continue
    }
    if ((m = /^switch\s*\(/.exec(rest))) {
      const pOpen = i + m[0].length - 1
      const pClose = findMatching(src, pOpen)
      const bOpen = src.indexOf('{', pClose)
      const bClose = findMatching(src, bOpen)
      out.push({ k: 'switchElem', ...parseSwitch(src.slice(bOpen + 1, bClose)) })
      i = bClose + 1
      continue
    }
    // 普通语句：这些文件基本不带分号、靠换行结尾，所以顶层看到 ; 或换行都算一条语句结束
    let j = i, depth = 0, textEnd = -1
    while (j < src.length) {
      const cc = src[j]
      if (cc === "'" || cc === '"' || cc === '`') { j = skipString(src, j) + 1; continue }
      if (cc === '(' || cc === '[' || cc === '{') depth++
      else if (cc === ')' || cc === ']' || cc === '}') depth--
      if (depth === 0 && (cc === ';' || cc === '\n')) { textEnd = j; break }
      j++
    }
    if (textEnd === -1) textEnd = src.length
    out.push(classify(src.slice(i, textEnd).trim()))
    i = textEnd + 1
  }
  return out
}
/** 解析 switch 体：按 case/default 切开，default 的 elem 记 null */
function parseSwitch (inner: string): { cases: { elem: string | null; body: Stmt[] }[] } {
  const marks: { elem: string | null; hStart: number; start: number }[] = []
  const re = /case\s+'([^']+)'\s*:|default\s*:/g
  let m: RegExpExecArray | null
  while ((m = re.exec(inner))) marks.push({ elem: m[1] ?? null, hStart: m.index, start: m.index + m[0].length })
  const cases: { elem: string | null; body: Stmt[] }[] = []
  for (let idx = 0; idx < marks.length; idx++) {
    const end = idx + 1 < marks.length ? marks[idx + 1].hStart : inner.length
    cases.push({ elem: marks[idx].elem, body: parseBlock(inner.slice(marks[idx].start, end)) })
  }
  return { cases }
}

/* ------------------------------------------------------------------ */
/* 符号执行：if 树 → 每条路径的产出（场景名 + 权重 + 条件）               */
/* ------------------------------------------------------------------ */

type Decision = { text: string; taken: boolean; nested: boolean; ctrl: boolean }
type Leaf = {
  seq: number
  kind: 'def-titled' | 'def-fallback' | 'rule'
  form: 'table' | 'expr' | 'rule'
  titles: string[]
  weights: Record<AttrKey, number>
  conds: Decision[]
  tableName: string
}
type SymState = { titles: string[]; attr: Record<AttrKey, number>; delta: number; table: string }

const isCtrl = (cond: string): boolean =>
  /^title\.length\s*>\s*0$/.test(cond) || /^recharge\s*!=\s*particularAttr\.recharge$/.test(cond)

/**
 * 这个 if 条件能静态判出真假吗？认两种写法：
 *   - recharge != particularAttr.recharge：那几个角色（哥伦比娅/娜维娅/菲林斯/闲云）
 *     都是 let recharge = particularAttr.recharge 然后 recharge -= n，所以 recharge 恒等于
 *     particularAttr.recharge + delta —— delta 不为 0 条件恒真、为 0 恒假；
 *   - title.length > 0：title 只有 push 和整体清空两种写法，到这里非空就恒真。
 * 认不出来的返回 null（两个分支都得走）。
 * 静态判掉的意义：不判的话会枚举出幽灵路径——「6命却跳过 >0命」「没 push 过却进 title 守卫」，
 * 这些路径运行时根本走不到，只会污染配对。
 */
function staticTruth (cond: string, st: SymState): boolean | null {
  if (/^recharge\s*!=\s*particularAttr\.recharge$/.test(cond)) return st.delta !== 0
  if (/^title\.length\s*>\s*0$/.test(cond)) return st.titles.length > 0
  return null
}
const cloneState = (s: SymState): SymState => ({ titles: [...s.titles], attr: { ...s.attr }, delta: s.delta, table: s.table })

const sat = (v: number, op: string, n: number): boolean =>
  op === '>=' ? v >= n : op === '<=' ? v <= n : op === '>' ? v > n : op === '<' ? v < n
    : op === '!==' || op === '!=' ? v !== n : v === n

/** 把条件拆成合取原子：芙宁娜那种 `weapon.name === '西风剑' && attr.recharge >= 250` 要拆开才看得见武器名 */
function condAtoms (text: string): string[] {
  return splitTop(text, '&&').map(a => a.trim())
}

/**
 * 这条路径本身自相矛盾吗？两种常见情况：
 *   1) 两个命中条件要求同一把武器叫两个不同的名字（西风秘典 和 讨龙英杰谭 互斥；
 *      芙宁娜四个武器分支也是互斥的，只是各自还带了充能条件，得拆开原子才看得出来）
 *   2) 命座上，命中的条件蕴含被跳过的条件（命中 6 命却跳过 >0 命 —— 6 命必然 >0）
 * 矛盾路径留着只会污染配对，直接丢掉。
 */
function isContradictory (decs: Decision[]): boolean {
  const taken: string[] = []
  const skipped: string[] = []
  for (const d of decs) (d.taken ? taken : skipped).push(...condAtoms(d.text))
  const weapons = new Set<string>()
  for (const a of taken) {
    const m = /^weapon\.name\s*===\s*'([^']+)'$/.exec(a)
    if (m) weapons.add(m[1])
  }
  if (weapons.size > 1) return true
  const consDom = [0, 1, 2, 3, 4, 5, 6]
  for (const t of taken) {
    const mT = /^cons\s*(>=|<=|===|==|>|<)\s*(\d+)$/.exec(t)
    if (!mT) continue
    for (const s of skipped) {
      const mS = /^cons\s*(>=|<=|===|==|>|<)\s*(\d+)$/.exec(s)
      if (!mS) continue
      // 满足命中条件的每个命座值，也都满足被跳过的条件 → 这个「跳过」不可能发生
      if (consDom.every(v => !sat(v, mT[1], Number(mT[2])) || sat(v, mS[1], Number(mS[2])))) return true
    }
  }
  return false
}

/**
 * 续算函数：把「走到这里时的状态」和「一路上攒下的判定」都当参数传下来。
 * 早期版本只传状态、判定用闭包捕获外层数组，结果命中分支走完 if 体继续往下时，
 * 拿到的是没有这次命中的旧判定——叶子条件全错。状态和判定都必须沿路径流动。
 */
type Cont = (st: SymState, decs: Decision[]) => void

function symbolicWalk (stmts: Stmt[], idx: number, st: SymState, decisions: Decision[], depth: number, leaves: Leaf[], next: Cont): void {
  if (TRACE && TRACE_CHAR === DUMP) console.log(`${'  '.repeat(depth)}walk idx=${idx} kind=${stmts[idx]?.k ?? 'END'} titles=${JSON.stringify(st.titles)} decs=${decisions.map(d => (d.taken ? '+' : '-') + d.text).join(',')}`)
  if (idx >= stmts.length) { next(st, decisions); return }
  const s = stmts[idx]
  const after: Cont = (st2, decs2) => symbolicWalk(stmts, idx + 1, st2, decs2, depth, leaves, next)
  switch (s.k) {
    case 'let': {
      const m = /usefulAttr\['([^']+)'\]/.exec(s.init)
      if (s.name === 'title') st.titles = []
      else if (s.name === 'particularAttr' && m) { st.table = m[1]; st.attr = norm(usefulAttr[m[1]]) }
      // let recharge = ... 只是记账，符号执行里不用管
      after(st, decisions)
      return
    }
    case 'if': {
      const ctrl = isCtrl(s.cond)
      const dT: Decision = { text: s.cond, taken: true, nested: depth > 0, ctrl }
      const dS: Decision = { text: s.cond, taken: false, nested: depth > 0, ctrl }
      const before = cloneState(st)
      // 能静态判真假的条件只走成立那一支，别枚举出幽灵路径（闲云的「战斗」单飞就是这么来的：
      // 6 命必然 >0 命、充能差已经被减过了，符号上却还按没命中算）
      const truth = staticTruth(s.cond, st)
      if (truth === true) {
        symbolicWalk(s.body, 0, st, [...decisions, dT], depth + 1, leaves, after)
        return
      }
      if (truth === false) {
        symbolicWalk(stmts, idx + 1, before, [...decisions, dS], depth, leaves, next)
        return
      }
      // 命中这条路：走 if 体，出来后带着 body 末尾的状态和这次命中一起继续往下
      symbolicWalk(s.body, 0, st, [...decisions, dT], depth + 1, leaves, after)
      // 没命中：状态回滚到 if 之前，继续往下
      symbolicWalk(stmts, idx + 1, before, [...decisions, dS], depth, leaves, next)
      return
    }
    case 'push': st.titles.push(s.t); after(st, decisions); return
    case 'reset': st.titles = []; after(st, decisions); return
    case 'set': {
      if (s.val === 'recharge') st.attr.recharge = (usefulAttr[st.table]?.recharge ?? 0) + st.delta
      else st.attr[s.key as AttrKey] = Number(s.val)
      after(st, decisions)
      return
    }
    case 'sub': st.delta -= s.n; after(st, decisions); return
    case 'retDef': {
      const form: 'table' | 'expr' = /^usefulAttr\[/.test(s.arg) ? 'table' : 'expr'
      // def(x, title) 都在 if (title.length > 0) 守卫里调用：路径枚举到这里 title 却空着，
      // 说明这是一条自相矛盾的路径（守卫不可能放行），直接丢弃，免得产出幽灵叶子
      if (s.titled && st.titles.length === 0) return
      if (isContradictory(decisions)) return
      let weights: Record<AttrKey, number>
      if (!s.titled) {
        weights = form === 'table' ? norm(usefulAttr[st.table])
          : s.arg === 'particularAttr' ? { ...st.attr }
            : norm(parseObj(s.arg))
      } else weights = { ...st.attr }
      leaves.push({
        seq: leaves.length, kind: s.titled ? 'def-titled' : 'def-fallback', form,
        titles: [...st.titles], weights, conds: decisions, tableName: st.table
      })
      return // return 即路径终点
    }
    case 'retRule': {
      // 动态标题（模板字符串）：前缀 + 路径上累积的分支名；静态标题原样用
      const title = s.dyn ? s.t + st.titles.join(s.sep ?? '') : s.t
      if (isContradictory(decisions)) return
      // 权重写的是变量 particularAttr → 用符号状态里一路累积下来的值
      const weights = s.fromState ? { ...st.attr } : norm(s.w)
      leaves.push({
        seq: leaves.length, kind: 'rule', form: 'rule', titles: [title],
        weights, conds: decisions, tableName: ''
      })
      return
    }
    case 'switchElem': {
      // 每个 case 是一条独立路径（旅行者按元素切规则）；default 的 elem 记 null
      for (const c of s.cases) {
        const d: Decision = {
          text: c.elem === null ? '元素 = 其他' : `元素 = ${ELEM_CN[c.elem] ?? c.elem}`,
          taken: true, nested: false, ctrl: false
        }
        symbolicWalk(c.body, 0, cloneState(st), [...decisions, d], depth + 1, leaves, () => {})
      }
      after(st, decisions)
      return
    }
    case 'nop': after(st, decisions); return
  }
}

/* ------------------------------------------------------------------ */
/* 运行时探测：桩环境 + 网格/随机采样                                   */
/* ------------------------------------------------------------------ */

type Profile = {
  attr: Record<string, number>
  cons: number
  weapon: { name: string; bonusKey: string }
  mains: Record<'3' | '4' | '5', string>
  sets: string[]
  elem: string
}

const BASE: Profile = {
  attr: { hp: 30000, atk: 2000, def: 800, cpct: 5, cdmg: 50, mastery: 0, recharge: 200, heal: 0 },
  cons: 0,
  weapon: { name: '', bonusKey: '' },
  mains: { '3': 'def', '4': 'dmg', '5': 'hp' },
  sets: [],
  elem: 'multi'
}
const ELEM_KEYS = ['pyro', 'hydro', 'anemo', 'electro', 'cryo', 'geo', 'dendro']

const artisStub = (p: Profile) => ({
  /** 复刻 Artis.is：带槽位=查主词条，不带=查套装简称 */
  is (check: string, pos: string | number = ''): boolean {
    if (pos !== '') {
      const want = check.split(',')
      return String(pos).split(',').every(slot => {
        const k = p.mains[slot as '3' | '4' | '5']
        if (want.includes(k)) return true
        // 元素伤害杯：4 号位主词条是某元素伤时也算 dmg（内核 Format.isElem 同款规则）
        if (slot === '4' && want.includes('dmg') && ELEM_KEYS.includes(k)) return true
        return false
      })
    }
    return check.split(',').some(s => p.sets.includes(s.trim()))
  }
})

/** 确定性伪随机（mulberry32），保证每次生成结果一致 */
function mulberry32 (seed: number): () => number {
  let a = seed
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

type Outcome = { title: string; weights: Record<AttrKey, number>; profile: Profile; dev: number }

/** 叶子对应的运行时标题：rule() 自己写全名；def() 的被内核加了「abbr-」前缀 */
function leafTitleOf (l: Leaf, abbr: string): string {
  if (l.kind === 'rule') return l.titles[0]
  if (l.kind === 'def-titled') return `${abbr}-${l.titles.join('|')}`
  return `${abbr}-通用`
}

/**
 * 按一条源码路径的条件，构造一个「大概率能走到这条路径」的面板。
 * 只认有限几种原子条件（面板属性 / 双暴评分 / 命座 / 武器 / 套装 / 主词条 / 元素），
 * 认不出来的条件直接放过——构造出来是运气，构造不出来也不过少探到一个分支。
 * 先满足「没命中」的条件、后满足「命中」的：两者冲突时以命中为准（真冲突的路径本来就是矛盾的）。
 */
function witnessFor (leaf: Leaf, baseElem: string): Profile {
  const p: Profile = {
    attr: { ...BASE.attr }, cons: BASE.cons, weapon: { ...BASE.weapon },
    mains: { ...BASE.mains }, sets: [...BASE.sets], elem: baseElem
  }
  const satisfy = (expr: string, ok: boolean): void => {
    const e = expr.trim()
    let m: RegExpExecArray | null
    // 双暴评分：cpct*2 + cdmg
    if ((m = /^attr\.cpct\s*\*\s*2\s*\+\s*attr\.cdmg\s*(>=|<=|>|<|===)\s*(-?[\d.]+)$/.exec(e))) {
      const n = Number(m[2])
      const q = ok
        ? (m[1] === '>=' || m[1] === '>' ? n + 1 : m[1] === '<=' || m[1] === '<' ? n - 1 : n)
        : (m[1] === '>' || m[1] === '>=' ? n - 1 : n + 1)
      // 把双暴评分拆成 cpct / cdmg：cdmg 先吃 50，剩下的给 cpct，cpct 封顶 100
      const cpct = Math.min(100, Math.max(0, Math.round((q - 50) / 2)))
      p.attr.cpct = cpct
      p.attr.cdmg = Math.max(0, q - cpct * 2)
      return
    }
    // 面板属性
    if ((m = /^attr\.(\w+)\s*(>=|<=|>|<|===)\s*(-?[\d.]+)$/.exec(e))) {
      const key = m[1], op = m[2], n = Number(m[3])
      p.attr[key] = ok
        ? (op === '>=' || op === '>' ? n + 1 : op === '<=' || op === '<' ? n - 1 : n)
        : (op === '>' || op === '>=' ? n - 1 : op === '<' ? n + 1 : n + 1)
      return
    }
    // 命座
    if ((m = /^cons\s*(>=|<=|>|<|===)\s*(\d+)$/.exec(e))) {
      const op = m[1], n = Number(m[2])
      p.cons = ok
        ? (op === '>=' || op === '>' ? Math.min(6, n + 1) : op === '<=' || op === '<' ? Math.max(0, n - 1) : n)
        : (op === '>' || op === '>=' ? Math.max(0, n - 1) : Math.min(6, n + 1))
      return
    }
    // 武器名 / 武器副词条
    if ((m = /^weapon\.name\s*(===|!==)\s*'([^']+)'$/.exec(e))) {
      p.weapon.name = (m[1] === '===') === ok ? m[2] : ''
      return
    }
    if ((m = /^weapon\.bonusKey\s*(===|!==)\s*'([^']+)'$/.exec(e))) {
      p.weapon.bonusKey = (m[1] === '===') === ok ? m[2] : ''
      return
    }
    // artis.is：带槽位=主词条，不带=套装
    if ((m = /^(!?)artis\.is\(\s*'([^']+)'\s*,\s*'?([\d,]+)'?\s*\)$/.exec(e))) {
      const want = (m[1] === '!') !== ok
      if (want) {
        for (const slot of m[3].split(',')) p.mains[slot as '3' | '4' | '5'] = m[2]
      } else {
        // 让第一个槽位装个别的主词条，is 就假了
        const slot = m[3].split(',')[0]
        p.mains[slot as '3' | '4' | '5'] = m[2] === 'hp' ? 'atk' : 'hp'
      }
      return
    }
    if ((m = /^(!?)artis\.is\(\s*'([^']+)'\s*\)$/.exec(e))) {
      p.sets = (m[1] === '!') !== ok ? [m[2]] : []
      return
    }
    // 元素（switch(elem) 的 case）
    if ((m = /^元素 = (.+)$/.exec(e))) {
      const cn = m[1]
      const key = Object.keys(ELEM_CN).find(k => ELEM_CN[k] === cn)
      if (key) p.elem = ok ? key : (baseElem === 'multi' ? 'multi' : baseElem)
      return
    }
    // 认不出来的（比如 recharge != particularAttr.recharge）：放过
  }
  // 没命中的条件先满足、命中的后满足，冲突时以命中为准
  for (const d of leaf.conds) {
    if (d.ctrl || d.taken) continue
    const ands = splitTop(d.text, '&&')
    if (ands.length === 1) satisfy(d.text, false)
  }
  for (const d of leaf.conds) {
    if (d.ctrl || !d.taken) continue
    const ors = splitTop(d.text, '||')
    const ands = ors.length > 1 ? [ors[0]] : splitTop(d.text, '&&')
    for (const a of ands) satisfy(a, true)
  }
  return p
}

/** 单维扫描 + 随机联合采样 + 定向补测，探出规则函数能产出的全部（场景名, 权重） */
function probe (ruleFn: (env: Record<string, unknown>) => { title: string; attrWeight: Partial<Record<AttrKey, number>> } | undefined,
  charName: string, abbr: string, meta: { elem: string }, leaves: Leaf[]): Map<string, Outcome> {
  const def = (attrWeight: Partial<Record<AttrKey, number>>, title: string[] = []): { title: string; attrWeight: Partial<Record<AttrKey, number>> } =>
    ({ title: `${abbr}-${title.length ? title.join('|') : '通用'}`, attrWeight })
  const rule = (title: string, attrWeight: Partial<Record<AttrKey, number>>): { title: string; attrWeight: Partial<Record<AttrKey, number>> } =>
    ({ title, attrWeight })
  const run = (p: Profile): Outcome | null => {
    const ret = ruleFn({ attr: p.attr, elem: p.elem, artis: artisStub(p), weapon: p.weapon, cons: p.cons, def, rule })
    if (!ret || typeof ret.title !== 'string') return null
    return { title: ret.title, weights: norm(ret.attrWeight), profile: p, dev: deviations(p) }
  }
  const deviations = (p: Profile): number => {
    let n = 0
    if (p.attr.hp !== BASE.attr.hp) n++
    if (p.attr.cpct !== BASE.attr.cpct || p.attr.cdmg !== BASE.attr.cdmg) n++
    if (p.attr.mastery !== BASE.attr.mastery) n++
    if (p.attr.recharge !== BASE.attr.recharge) n++
    if (p.cons !== BASE.cons) n++
    if (p.weapon.name !== BASE.weapon.name) n++
    if (p.weapon.bonusKey !== BASE.weapon.bonusKey) n++
    if (p.sets.length !== BASE.sets.length) n++
    for (const s of ['3', '4', '5'] as const) if (p.mains[s] !== BASE.mains[s]) n++
    if (p.elem !== meta.elem) n++
    return n
  }
  const clone = (p: Profile): Profile => ({ attr: { ...p.attr }, cons: p.cons, weapon: { ...p.weapon }, mains: { ...p.mains }, sets: [...p.sets], elem: p.elem })

  // 探测基准：元素按角色自己的算。BASE 里写死 multi 是给旅行者那类多元素角色用的，
  // 别的角色要是也从 multi 起跑，触发样例里会多出一行没意义的「元素:多」
  const B: Profile = { attr: { ...BASE.attr }, cons: BASE.cons, weapon: { ...BASE.weapon }, mains: { ...BASE.mains }, sets: [...BASE.sets], elem: meta.elem }

  const outcomes = new Map<string, Outcome>()
  const add = (o: Outcome | null): void => {
    if (!o) return
    const key = o.title + '|' + wKey(o.weights)
    const old = outcomes.get(key)
    if (!old || o.dev < old.dev) outcomes.set(key, o)
  }

  // 采样网格：每个维度单独扫一遍（其余保持基准），再随机联合采样覆盖交叉条件
  const grid: [string, (string | number)[]][] = [
    ['attr.hp', [30000, 40000, 50000]],
    ['attr.cpct', [5, 15, 20, 30, 50, 70, 100]],
    ['attr.cdmg', [50, 100, 150, 200, 250, 280, 300, 330, 350]],
    ['attr.mastery', [0, 50, 80, 100, 120, 150, 200, 250, 500, 600]],
    ['attr.recharge', [100, 150, 180, 200, 220, 250, 260, 300]],
    ['cons', [0, 1, 2, 4, 6]],
    ['weapon.name', weaponNames(charName)],
    ['weapon.bonusKey', ['', 'recharge']],
    ['sets', SETS],
    ['mains.3', MAIN_POOL['3']],
    ['mains.4', MAIN_POOL['4']],
    ['mains.5', MAIN_POOL['5']],
    ['elem', meta.elem === 'multi' ? [...ELEM_KEYS, 'multi'] : [meta.elem]]
  ]
  const apply = (p: Profile, dim: string, v: string | number): Profile => {
    if (dim.startsWith('attr.')) p.attr[dim.slice(5)] = v as number
    else if (dim === 'cons') p.cons = v as number
    else if (dim === 'weapon.name') p.weapon.name = v as string
    else if (dim === 'weapon.bonusKey') p.weapon.bonusKey = v as string
    else if (dim === 'sets') p.sets = v === '' ? [] : [v as string]
    else if (dim.startsWith('mains.')) p.mains[dim.slice(6) as '3' | '4' | '5'] = v as string
    else if (dim === 'elem') p.elem = v as string
    return p
  }
  for (const [dim, vals] of grid) for (const v of vals) add(run(apply(clone(B), dim, v)))

  const rnd = mulberry32(20260918)
  const pick = <T> (arr: T[]): T => arr[Math.floor(rnd() * arr.length)]
  for (let n = 0; n < 3000; n++) {
    const p = clone(B)
    for (const [dim, vals] of grid) apply(p, dim, pick(vals))
    add(run(p))
  }
  // 定向补测：网格是单维扫的、随机采样撞中大联合条件的概率又太低（迪希雅-血牛要
  // 3/4/5 全生命 且 生命>40000 且 双暴<100 同时成立），干脆按路径条件构造面板再测一遍。
  // 已经探到过的分支也照跑——构造出来的面板通常改动项最少（add 只留 dev 小的那个），
  // 拿它当「触发样例」比随机撞到的干净（不会出现钟离拿西风剑这种不搭的配置）
  for (const l of leaves) add(run(witnessFor(l, meta.elem)))
  return outcomes
}
const MAIN_POOL: Record<'3' | '4' | '5', string[]> = {
  '3': ['def', 'hp', 'atk', 'mastery', 'recharge', 'heal', 'phy'],
  '4': ['dmg', 'atk', 'def', 'mastery', 'pyro', 'hydro', 'anemo', 'electro', 'cryo', 'geo', 'dendro', 'phy'],
  '5': ['hp', 'atk', 'def', 'mastery', 'recharge', 'heal', 'cpct', 'cdmg']
}
/** 该角色 artis.js 里点过名的武器 + 内核特判武器，全部进采样网格 */
function weaponNames (charName: string): string[] {
  const names = new Set<string>(WEAPON_SPECIALS)
  try {
    const src = readFileSync(join(CHAR_DIR, charName, 'artis.js'), 'utf-8')
    const re = /weapon\.name === '([^']+)'/g
    let m: RegExpExecArray | null
    while ((m = re.exec(src))) names.add(m[1])
  } catch { /* 没有 artis.js 也无所谓 */ }
  return [...names]
}

/* ------------------------------------------------------------------ */
/* 触发条件：JS 表达式 → 中文                                          */
/* ------------------------------------------------------------------ */

const OP_CN: Record<string, string> = { '>=': '≥', '<=': '≤', '>': '>', '<': '<', '===': '=', '==': '=', '!==': '≠', '!=': '≠' }
const OP_FLIP: Record<string, string> = { '>=': '<', '<=': '>', '>': '<=', '<': '>=', '===': '!==', '==': '!=', '!==': '===', '!=': '==' }

function atomText (expr: string, flip = false): string {
  const e = expr.trim()
  let m: RegExpExecArray | null
  // 双暴评分：cpct*2 + cdmg
  if ((m = /^attr\.cpct\s*\*\s*2\s*\+\s*attr\.cdmg\s*(>=|<=|===|!==|==|!=|>|<)\s*(-?[\d.]+)$/.exec(e))) {
    return `双暴评分 ${flip ? OP_CN[OP_FLIP[m[1]]] : OP_CN[m[1]]} ${m[2]}`
  }
  // 面板属性
  if ((m = /^attr\.(\w+)\s*(>=|<=|===|!==|==|!=|>|<)\s*(-?[\d.]+)$/.exec(e))) {
    const name = ATTR_CN[m[1]] ?? m[1]
    return `${name} ${flip ? OP_CN[OP_FLIP[m[2]]] : OP_CN[m[2]]} ${m[3]}`
  }
  // 命座
  if ((m = /^cons\s*(>=|<=|===|!==|==|!=|>|<)\s*(\d+)$/.exec(e))) {
    return `命座 ${flip ? OP_CN[OP_FLIP[m[1]]] : OP_CN[m[1]]} ${m[2]}`
  }
  // 武器名 / 武器副词条
  if ((m = /^weapon\.name\s*(===|!==)\s*'([^']+)'$/.exec(e))) {
    const eq = (m[1] === '===') !== flip
    return `武器 ${eq ? '=' : '≠'} ${m[2]}`
  }
  if ((m = /^weapon\.bonusKey\s*(===|!==)\s*'([^']+)'$/.exec(e))) {
    const eq = (m[1] === '===') !== flip
    return `武器副词条 ${eq ? '=' : '≠'} ${m[2]}`
  }
  // artis.is：带槽位=主词条，不带=套装
  if ((m = /^(!?)artis\.is\(\s*'([^']+)'\s*,\s*'?([\d,]+)'?\s*\)$/.exec(e))) {
    const slots = m[3].split(',').join('/')
    const keys = m[2].split(',').map(k => MAIN_CN[k] ?? k).join('/')
    const eq = (m[1] === '!') !== flip
    return `${slots}号位主词条 ${eq ? '≠' : '='} ${keys}`
  }
  if ((m = /^(!?)artis\.is\(\s*'([^']+)'\s*\)$/.exec(e))) {
    const eq = (m[1] === '!') !== flip
    return `套装 ${eq ? '≠' : '='} ${m[2]}`
  }
  return e // 认不出来的原样吐出，校验报告里能看见
}

function renderExpr (expr: string, flip = false): string {
  const e = expr.trim()
  // 整体取反
  if (flip) {
    if (e.startsWith('!')) return renderExpr(e.slice(1), false)
    const ors = splitTop(e, '||')
    if (ors.length > 1) return wrapAnd(ors.map(o => renderExpr(o, true)))
    const ands = splitTop(e, '&&')
    if (ands.length > 1) return wrapOr(ands.map(a => renderExpr(a, true)))
    if (e.startsWith('(') && e.endsWith(')')) return renderExpr(e.slice(1, -1), true)
    return atomText(e, true)
  }
  const ors = splitTop(e, '||')
  if (ors.length > 1) return ors.map(o => renderExpr(o, false)).join(' 或 ')
  const ands = splitTop(e, '&&')
  if (ands.length > 1) {
    const parts = ands.map(a => {
      const t = renderExpr(a, false)
      return t.includes(' 或 ') ? `（${t}）` : t
    })
    return parts.join(' 且 ')
  }
  if (e.startsWith('(') && e.endsWith(')')) return renderExpr(e.slice(1, -1), false)
  return atomText(e, false)
}
const wrapOr = (parts: string[]): string => parts.map(p => (p.includes(' 且 ') ? `（${p}）` : p)).join(' 或 ')
const wrapAnd = (parts: string[]): string => parts.map(p => (p.includes(' 或 ') ? `（${p}）` : p)).join(' 且 ')

/**
 * 合取化简，删两种废话：
 *   1) 同变量的弱条件：命座 ≥ 4 且 命座 = 6 → 命座 = 6；
 *   2) 互斥变量：武器只有一个名字，有了「武器 = 西风剑」，「武器 ≠ 苍古自由之誓」就是废话；
 *      命座写死等于几，别的命座条件也全是废话。
 */
function simplifyAnd (parts: string[]): string[] {
  // 武器只有一个名字：整条合取里「武器 = X」只剩一种时，别的 武器 ≠ Y 才是废话
  // （真出现两种不同的 武器 = X 说明路径自相矛盾，那种情况不敢删，留着让人看出来）
  const weaponEqs = [...new Set(parts.filter(p => /^武器 = /.test(p)))]
  const weaponEq = weaponEqs.length === 1 ? weaponEqs[0] : ''
  const consEq = parts.find(p => /^命座 = \d+$/.test(p))
  const filtered = parts.filter(p => {
    if (weaponEq && p !== weaponEq && /^武器 [=≠] /.test(p)) return false
    if (consEq && p !== consEq && /^命座 [=≠≥≤><] /.test(p)) return false
    return true
  })
  const parsed = filtered.map(p => {
    const m = /^(命座|精通|生命|充能|攻击|防御|双暴评分|暴击率|暴伤)\s*(≥|≤|>|<|=|≠)\s*([\d.]+)$/.exec(p)
    return m ? { p, var: m[1], op: m[2], num: Number(m[3]) } : { p, var: '', op: '', num: 0 }
  })
  // 同变量的条件互相吃掉：A 蕴含 B 就删 B（命座 ≥ 1 且 命座 ≥ 4 → 命座 ≥ 4）
  const dropped = new Set<number>()
  for (let j = 0; j < parsed.length; j++) {
    const b = parsed[j]
    if (!b.var) continue
    for (let i = 0; i < parsed.length; i++) {
      if (i === j) continue
      const a = parsed[i]
      if (!a.var || a.var !== b.var) continue
      if (!implies(a, b)) continue
      // 互相蕴含（等价）时只留下标小的那条，避免两条都删掉
      if (implies(b, a) && i > j) continue
      dropped.add(j)
      break
    }
  }
  return parsed.filter((_, i) => !dropped.has(i)).map(k => k.p)
}

/** 一个条件原子是否「析取地」蕴含另一个（只看同一变量，跨变量不管） */
type Atom = { p: string; var: string; op: string; num: number }
const OP_ASCII: Record<string, string> = { '=': '===', '≠': '!==', '≥': '>=', '≤': '<=', '>': '>', '<': '<' }
function implies (a: Atom, b: Atom): boolean {
  // 命座是 0~6 的有限域，直接枚举判蕴含，比手写规则可靠得多
  if (a.var === '命座') {
    const dom = [0, 1, 2, 3, 4, 5, 6]
    return dom.every(v => !sat(v, OP_ASCII[a.op], a.num) || sat(v, OP_ASCII[b.op], b.num))
  }
  if (b.op === '=') return a.op === '=' && a.num === b.num
  if (a.op === '=') return sat(a.num, OP_ASCII[b.op], b.num)
  if (a.op === '≠') return b.op === '≠' && a.num === b.num
  // b 是「不等于某个具体值」：区间完全不含这个值时蕴含成立
  if (b.op === '≠') {
    if (a.op === '≤' || a.op === '<') return b.num > a.num
    if (a.op === '≥' || a.op === '>') return b.num < a.num
    return false
  }
  // 同向区间：把严格不等号挪半个单位，剩下就是单纯的「谁的界更紧」
  const up = (o: string): boolean => o === '≥' || o === '>'
  if (up(a.op) !== up(b.op)) return false
  if (up(a.op)) {
    const ba = a.num + (a.op === '>' ? 0.5 : 0)
    const bb = b.num + (b.op === '>' ? 0.5 : 0)
    return ba >= bb
  }
  const ba = a.num - (a.op === '<' ? 0.5 : 0)
  const bb = b.num - (b.op === '<' ? 0.5 : 0)
  return ba <= bb
}

/**
 * 一条源码路径的**全部**条件原子（渲染成中文）：命中=正写，没命中=反写。
 * 顶层没命中的条件也必须反写进来——哥伦比娅「专武」那条路要求命座 < 4，
 * 只写「武器 = 帷间夜曲」会让人以为 6 命也是这套权重，实际 6 命走的是「专武|高命」。
 */
function leafAtoms (leaf: Leaf): string[] {
  const parts: string[] = []
  for (const d of leaf.conds) {
    if (d.ctrl) continue
    parts.push(renderExpr(d.text, !d.taken))
  }
  return parts
}
function leafCondText (leaf: Leaf): string {
  const parts = leafAtoms(leaf)
  if (!parts.length) return ''
  return wrapAnd(simplifyAnd(parts))
}
/** 条件原子压成短标签，用来给同名场景加后缀：命座 = 6 → 6命，武器 = 鹤鸣余音 → 鹤鸣余音 */
function shortAtom (atom: string): string {
  const c = /^命座 ([=≠≥≤><]) (\d+)$/.exec(atom)
  if (c) {
    const n = Number(c[2])
    if (c[1] === '=') return `${n}命`
    if (c[1] === '>') return `${n + 1}命+`
    if (c[1] === '≥') return `${n}命+`
    if (c[1] === '<') return `≤${n - 1}命`
    if (c[1] === '≤') return `≤${n}命`
    return `≠${n}命`
  }
  const w = /^武器 ([=≠]) (.+)$/.exec(atom)
  if (w) return w[1] === '=' ? w[2] : `非${w[2]}`
  return atom.replace(/\s+/g, '')
}

/**
 * 这条场景的命座取值范围（命座是 0~6 有限域，逐条路径枚举再求并集——
 * 一条场景可能由多条路径凑成，比如闲云「高配」是 0命带专武 或 1命以上不带专武）。
 * 和命座无关就返回空。
 */
function consRange (s: Scenario): number[] {
  const out = new Set<number>()
  for (const l of s.leaves) {
    const atoms = leafAtoms(l).filter(a => /^命座 [=≠≥≤><] \d+$/.test(a))
    if (!atoms.length) continue
    for (const v of [0, 1, 2, 3, 4, 5, 6]) {
      if (atoms.every(a => {
        const m = /^命座 ([=≠≥≤><]) (\d+)$/.exec(a)!
        return sat(v, OP_ASCII[m[1]], Number(m[2]))
      })) out.add(v)
    }
  }
  return [...out].sort((a, b) => a - b)
}
function rangeText (vs: number[]): string {
  if (!vs.length) return ''
  if (vs.length === 1) return `${vs[0]}命`
  const consecutive = vs.every((v, i) => i === 0 || v === vs[i - 1] + 1)
  return consecutive ? `${vs[0]}~${vs[vs.length - 1]}命` : `${vs.join('/')}命`
}

/**
 * 命座是有限域（0~6）。如果这批路径**除了命座约束别的都一样**，且命座约束拼起来
 * 正好覆盖整个域，说明命座在这批路径里是个「无所谓」的变量——典型是芙宁娜那种
 * 武器分支会把 title 清空重写，命座条件只是顺路被带上来的。把命座约束全删掉，
 * 条件能从三段析取缩成一段。非命座部分不一致时不敢删，删了会改变含义。
 */
function dropFreeCons (sets: string[][]): boolean {
  if (sets.length < 2) return false
  const dom = [0, 1, 2, 3, 4, 5, 6]
  const rest = sets.map(a => a.filter(p => !/^命座 [=≠≥≤><] \d+$/.test(p)))
  const first = rest[0]
  if (!rest.every(r => r.length === first.length && r.every((x, i) => x === first[i]))) return false
  const covered = new Set<number>()
  for (const a of sets) {
    const cs = a.filter(p => /^命座 [=≠≥≤><] \d+$/.test(p))
    if (!cs.length) return false
    for (const v of dom) {
      const ok = cs.every(c => {
        const m = /^命座 ([=≠≥≤><]) (\d+)$/.exec(c)!
        // 渲染出来的原子用中文运算符，sat 只认 ASCII，得翻译一遍
        const op = ({ '=': '===', '≠': '!==', '≥': '>=', '≤': '<=', '>': '>', '<': '<' } as Record<string, string>)[m[1]]
        return sat(v, op, Number(m[2]))
      })
      if (ok) covered.add(v)
    }
  }
  if (covered.size < dom.length) return false
  for (const a of sets) for (let i = a.length - 1; i >= 0; i--) if (/^命座 [=≠≥≤><] \d+$/.test(a[i])) a.splice(i, 1)
  return true
}

/**
 * 同一个场景可能由多条路径产出（权重碰巧一样），条件是这些路径的并集。
 * 先删「无所谓」的命座约束，再按析取吸收化简：(A 且 B) 或 A = A ——
 * 原子集是别人超集的那条，条件更严，被更松的吃掉。
 */
function orTexts (atomSets: string[][]): string {
  dropFreeCons(atomSets)
  const uniq: string[][] = []
  for (const a of atomSets) {
    if (!uniq.some(u => u.length === a.length && u.every((x, i) => x === a[i]))) uniq.push(a)
  }
  const keep = uniq.filter(a => !uniq.some(b => b !== a && b.length < a.length && b.every(x => a.includes(x))))
  const texts = keep.map(a => wrapAnd(simplifyAnd(a))).filter(t => t)
  return texts.length > 1 ? wrapOr(texts) : (texts[0] ?? '')
}

/* ------------------------------------------------------------------ */
/* 依赖因子 / 触发样例                                                  */
/* ------------------------------------------------------------------ */

function condFactors (cond: string): Set<string> {
  const f = new Set<string>()
  if (/attr\./.test(cond)) f.add('面板')
  if (/artis\.is\(\s*'[^']+'\s*,/.test(cond)) f.add('面板') // 带槽位 = 查主词条
  if (/weapon\./.test(cond)) f.add('武器')
  if (/\bcons\b/.test(cond)) f.add('命座')
  if (/artis\.is\(\s*'[^']+'\s*\)/.test(cond)) f.add('套装')
  if (/^元素 = /.test(cond)) f.add('元素') // switch(elem) 的 case
  return f
}
const factorText = (fs: Set<string>): string => FACTOR_ORDER.filter(f => fs.has(f)).join('/')

/** 触发样例：相对基准面板差了多少，Old 表同款思路 */
function sampleText (p: Profile, baseElem: string): string {
  const parts: string[] = []
  if (p.attr.hp !== BASE.attr.hp) parts.push(`生命${p.attr.hp}`)
  if (p.attr.cpct !== BASE.attr.cpct || p.attr.cdmg !== BASE.attr.cdmg) parts.push(`暴击${p.attr.cpct}/暴伤${p.attr.cdmg}`)
  if (p.attr.mastery !== BASE.attr.mastery) parts.push(`精通${p.attr.mastery}`)
  if (p.attr.recharge !== BASE.attr.recharge) parts.push(`充能${p.attr.recharge}`)
  if (p.cons !== BASE.cons) parts.push(`${p.cons}命`)
  if (p.weapon.name) parts.push(`武器:${p.weapon.name}`)
  if (p.sets.length) parts.push(`套装:${p.sets.join('+')}`)
  const mainDiffs: string[] = []
  for (const s of ['3', '4', '5'] as const) if (p.mains[s] !== BASE.mains[s]) mainDiffs.push(`${s}号位${MAIN_CN[p.mains[s]] ?? p.mains[s]}`)
  if (mainDiffs.length) {
    // 连续同样词条的槽位合并：3号位生命 4号位生命 5号位生命 → 3/4/5号位生命
    const merged: string[] = []
    for (const d of mainDiffs) {
      const last = merged[merged.length - 1]
      const curKey = d.slice(d.indexOf('号位') + 2)
      if (last && last.endsWith(curKey)) {
        const slots = last.slice(0, last.indexOf('号位'))
        merged[merged.length - 1] = `${slots}/${d.slice(0, d.indexOf('号位'))}号位${curKey}`
      } else merged.push(d)
    }
    parts.push(`主词条:${merged.join(',')}`)
  }
  if (p.elem !== baseElem) parts.push(`元素:${ELEM_CN[p.elem] ?? p.elem}`)
  return parts.length ? parts.join(' ') : '基准面板'
}

/* ------------------------------------------------------------------ */
/* 主流程                                                              */
/* ------------------------------------------------------------------ */

type Scenario = {
  name: string
  cond: string
  source: string
  weights: number[]
  deps: string
  sample: string
  isBase: boolean
  leaves: Leaf[]
}
type CharRow = {
  name: string; abbr: string; elem: string; star: number; id: number
  hasRule: boolean
  inTable: boolean
  scenarios: Scenario[]
}

const warnings: string[] = []
function warn (msg: string): void { warnings.push(msg) }

/** --dump <角色目录名>：调试开关，打印符号叶子与运行时结果的配对键 */
const DUMP = process.argv.includes('--dump') ? process.argv[process.argv.indexOf('--dump') + 1] : ''
/** --trace（配合 --dump）：只打印被 dump 角色的符号执行步骤 */
const TRACE = process.argv.includes('--trace')
let TRACE_CHAR = ''

async function buildChar (dirName: string): Promise<CharRow> {
  const meta = JSON.parse(readFileSync(join(CHAR_DIR, dirName, 'data.json'), 'utf-8')) as {
    id: number; name: string; abbr?: string; elem: string; star: number; weapon: string
  }
  const abbr = meta.abbr || meta.name
  const row: CharRow = {
    name: meta.name, abbr, elem: ELEM_CN[meta.elem] ?? meta.elem, star: meta.star, id: meta.id,
    hasRule: existsSync(join(CHAR_DIR, dirName, 'artis.js')),
    inTable: !!usefulAttr[meta.name],
    scenarios: []
  }

  if (!row.hasRule) {
    // 没有自定义规则：默认表或通用兜底，一行了事
    const w = row.inTable ? norm(usefulAttr[meta.name]) : norm(FALLBACK_WEIGHT)
    row.scenarios = [{
      name: row.inTable ? '默认表' : '通用兜底',
      cond: row.inTable
        ? '无 artis.js，固定取默认表权重'
        : '无 artis.js 且默认表无此角色，取通用兜底',
      source: row.inTable ? '默认表 usefulAttr[角色] 原值' : FALLBACK_TEXT,
      weights: KEYS.map(k => w[k]), deps: '', sample: '无特殊配置', isBase: true, leaves: []
    }]
    return row
  }

  // 有自定义规则：静态解析 + 动态探测
  const src = readFileSync(join(CHAR_DIR, dirName, 'artis.js'), 'utf-8')
  const fnStart = src.indexOf('export default function')
  // 函数体的大括号在参数列表配对括号之后（参数列表自己也有花括号，不能直接找第一个 {）
  const pOpen = src.indexOf('(', fnStart)
  const pClose = findMatching(src, pOpen)
  const bodyOpen = src.indexOf('{', pClose)
  const bodyClose = findMatching(src, bodyOpen)
  const stmts = parseBlock(src.slice(bodyOpen + 1, bodyClose))
  if (DUMP === dirName) console.log('--- STMTS ---\n' + JSON.stringify(stmts, null, 1))
  TRACE_CHAR = dirName
  const leaves: Leaf[] = []
  symbolicWalk(stmts, 0, { titles: [], attr: norm({}), delta: 0, table: meta.name }, [], 0, leaves, () => {})
  const mod = await import(pathToFileURL(join(CHAR_DIR, dirName, 'artis.js')).href) as { default: unknown }
  const ruleFn = mod.default as Parameters<typeof probe>[0]
  const outcomes = probe(ruleFn, dirName, abbr, { elem: meta.elem }, leaves)

  // 叶子按 (运行时标题, 权重) 归类；运行时结果反向找叶子
  const leafTitle = (l: Leaf): string => leafTitleOf(l, abbr)
  const byKey = new Map<string, Leaf[]>()
  for (const l of leaves) {
    const key = leafTitle(l) + '|' + wKey(l.weights)
    if (!byKey.has(key)) byKey.set(key, [])
    byKey.get(key)!.push(l)
  }

  // --dump <角色目录名>：把符号叶子和运行时结果的配对键打出来，排查用
  if (DUMP === dirName) {
    console.log(`--- LEAVES (${dirName}) ---`)
    for (const l of leaves) console.log(`${leafTitle(l)} | ${wKey(l.weights)} | ${l.kind}/${l.form} | titles=${JSON.stringify(l.titles)}`)
    console.log(`--- OUTCOMES (${dirName}) ---`)
    for (const k of outcomes.keys()) console.log(k)
  }

  // 源码里点过的分支名，探测必须全部命中（漏一个说明采样没覆盖到）
  // 名字要和表里显示的一致：统一剥掉开头的角色名前缀
  const srcTitles = new Set<string>()
  for (const l of leaves) {
    if (!l.titles.length) continue
    let t = l.kind === 'rule' ? l.titles[0] : `${abbr}-${l.titles.join('|')}`
    for (const pre of [meta.name + '-', abbr + '-']) {
      if (t.startsWith(pre) && t.length > pre.length) { t = t.slice(pre.length); break }
    }
    srcTitles.add(t)
  }

  const scenarios: Scenario[] = []
  // 有没有特判分支，决定兜底行的条件文字怎么写
  const specialLeaves = leaves.filter(l => l.kind !== 'def-fallback')
  const hasSpecial = specialLeaves.length > 0
  for (const [key, o] of outcomes) {
    const matched = byKey.get(key) ?? []
    const leaf = matched[0]
    const isBase = !leaf || leaf.kind === 'def-fallback'
    // 场景名统一剥掉开头的「角色名-」/「角色简称-」：旁边就是角色列，再重复一遍是噪声
    // （内核返回的标题本来就带前缀：def() 加 abbr-，rule() 是作者写全的）
    let name = o.title
    for (const pre of [meta.name + '-', abbr + '-']) {
      if (name.startsWith(pre) && name.length > pre.length) { name = name.slice(pre.length); break }
    }
    if (isBase) name = '基础'
    // 条件文字：命中路径的正条件；兜底行写唯一特判分支的反面（信息量比「未命中」大），
    // 多个分支时反面求交集太绕，就统一说未命中
    let cond: string
    if (isBase) {
      if (!hasSpecial) cond = '恒取此权重（规则无条件分支）'
      else if (specialLeaves.length === 1 && specialLeaves[0].conds.every(d => d.ctrl || d.taken)) {
        // 只有一个特判分支、且路上没有被跳过的嵌套条件 → 兜底就是它的反面
        const taken = specialLeaves[0].conds.filter(d => !d.ctrl)
        cond = taken.length ? wrapOr(taken.map(d => renderExpr(d.text, true))) : '未命中上述任一分支'
      } else cond = '未命中上述任一分支'
    } else {
      // 多条路径同一个场景：条件取并集，再按析取吸收化简
      const sets = matched.map(leafAtoms).filter(a => a.length)
      cond = sets.length ? orTexts(sets) : ''
    }
    // 依赖因子：本行条件的读数；兜底行取全角色特判分支的并集
    let deps: Set<string>
    if (isBase) {
      deps = new Set<string>()
      for (const l of leaves) if (l.kind !== 'def-fallback') for (const d of l.conds) if (!d.ctrl) for (const f of condFactors(d.text)) deps.add(f)
    } else {
      deps = new Set<string>()
      for (const l of matched) for (const d of l.conds) if (!d.ctrl) for (const f of condFactors(d.text)) deps.add(f)
    }
    let source: string
    if (!leaf) { source = '（未能从源码还原）'; warn(`[${dirName}] 运行时结果无对应源码路径: ${o.title}`) }
    else if (leaf.kind === 'rule') source = '分支内权重（artis.js 显式给出）'
    else if (leaf.kind === 'def-titled') source = '分支内权重（artis.js 显式给出）'
    else if (leaf.form === 'table') source = '默认表 usefulAttr[角色] 原值'
    else source = 'artis.js 内置基准（不走默认表）'

    scenarios.push({
      name, cond, source, weights: KEYS.map(k => o.weights[k]),
      deps: factorText(deps), sample: sampleText(o.profile, meta.elem), isBase, leaves: matched
    })
  }

  // 校验 1：源码点过的分支名（组合标题按 | 连起来查，别拆开——拆开会把「高命」这种
  // 只在组合里出现的半截名字当成漏探，其实是误报），运行时必须见到
  const seenTitles = new Set(scenarios.filter(s => !s.isBase).map(s => s.name))
  for (const t of srcTitles) {
    if (!seenTitles.has(t)) warn(`[${dirName}] 源码分支「${t}」未被探测命中`)
  }
  // 校验 2：所有叶子都应该至少对一个运行时结果（不可达路径进警告）
  for (const [key, ls] of byKey) {
    if (!outcomes.has(key)) warn(`[${dirName}] 源码路径不可达或自相矛盾: ${leafTitle(ls[0])}`)
  }

  // 同名不同权：miao 的标题是写死的，只有中间量（命座/武器）变，名字不变——
  // 比如娜维娅 1~5命和 6命都叫「高命」，权重却不一样。表里两行同名会被当成重复行，
  // 给「更具体」的那条补个条件摘要后缀（6命 / ≥4命 / 鹤鸣余音）区分开。
  const byName = new Map<string, Scenario[]>()
  for (const s of scenarios) {
    if (s.isBase) continue
    if (!byName.has(s.name)) byName.set(s.name, [])
    byName.get(s.name)!.push(s)
  }
  for (const [n, list] of byName) {
    if (new Set(list.map(s => s.weights.join(','))).size < 2) continue
    // 首选：差别就是命座，而且各行命座区间不重叠 → 每行标自己的区间（1~5命 / 6命），对称好读
    const ranges = list.map(consRange)
    const disjoint = ranges.every((r, i) => r.length > 0 && ranges.every((o, j) => j === i || !o.some(v => r.includes(v))))
    if (disjoint && ranges.every(r => r.length > 0)) {
      list.forEach((s, i) => { s.name = `${n}（${rangeText(ranges[i])}）` })
      continue
    }
    // 其次：命座切不开（比如闲云「高配」还夹着武器条件），但权重只差一两列 → 用那列的读数标
    // （比拿条件碎片拼后缀准确，读者一眼看到「这套权重和那套差在充能」）
    const diffKeys = KEYS.filter((_, i) => new Set(list.map(s => s.weights[i])).size > 1)
    if (diffKeys.length > 0 && diffKeys.length <= 2) {
      for (const s of list) {
        const tag = diffKeys.map(k => KEY_CN[k] + s.weights[KEYS.indexOf(k)]).join(' ')
        s.name = `${n}（${tag}）`
      }
      continue
    }
    // 兜底：挑条件最短的那条留原名，其余补「多出来的那个条件」当后缀
    const sorted = [...list].sort((a, b) => a.cond.split(' 且 ').length - b.cond.split(' 且 ').length)
    const anchor = sorted[0]
    const anchorAtoms = new Set(anchor.leaves.flatMap(leafAtoms))
    for (const s of sorted.slice(1)) {
      const extra = [...new Set(s.leaves.flatMap(leafAtoms))].filter(a => !anchorAtoms.has(a))
      const tag = extra.map(shortAtom).slice(0, 2).join('+')
      if (tag) s.name = `${n}（${tag}）`
    }
  }

  // 场景排序：按中文名（和旧表一致），兜底行沉底
  scenarios.sort((a, b) => (a.isBase !== b.isBase ? (a.isBase ? 1 : -1) : a.name.localeCompare(b.name, 'zh')))
  row.scenarios = scenarios
  return row
}

/* ------------------------------------------------------------------ */
/* 输出                                                                */
/* ------------------------------------------------------------------ */

function csvCell (v: string | number): string {
  const s = String(v)
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}
const csvLine = (cells: (string | number)[]): string => cells.map(csvCell).join(',') + '\n'

/** 网页表格里权重来源压短一点，不然每行都折成两行——CSV 里留全称 */
const shortSrc = (s: string): string =>
  s.startsWith('分支内') ? '分支内（artis.js）'
    : s.startsWith('默认表') ? '默认表（usefulAttr）'
      : s.startsWith('artis.js 内置') ? '内置基准（artis.js）'
        : s

function gitInfo (): string {
  try {
    // 分两次调、格式串里不带空格和竖线：Windows 下 cmd 会把 | 当管道、空格会拆参数
    const hash = execSync('git log -1 --format=%h -- vendor/miao', { cwd: ROOT, encoding: 'utf-8' }).trim()
    const date = execSync('git log -1 --format=%cs -- vendor/miao', { cwd: ROOT, encoding: 'utf-8' }).trim()
    return `${hash}（${date}）`
  } catch { return '' }
}

const CSS = `<style>
*{box-sizing:border-box}
body{margin:0;padding:24px 28px 60px;background:#FBFBF9;color:#2C2C2A;font-family:-apple-system,"Segoe UI","Microsoft YaHei",sans-serif;font-size:13px;line-height:1.6}
h1{font-size:18px;font-weight:500;margin:0 0 6px}
.sub{color:#5F5E5A;margin:0 0 16px;font-size:12px}
.sub b{font-weight:500;color:#2C2C2A}
.bar{display:flex;flex-wrap:wrap;gap:10px;align-items:center;margin-bottom:6px}
input[type=text]{padding:6px 10px;border:1px solid rgba(0,0,0,.15);border-radius:8px;font-size:13px;width:200px;background:#fff;color:#2C2C2A}
input[type=text]:focus{outline:none;border-color:#378ADD}
.chip{padding:4px 11px;border:1px solid rgba(0,0,0,.15);border-radius:999px;background:#fff;cursor:pointer;font-size:12px;color:#5F5E5A;user-select:none}
.chip:hover{border-color:rgba(0,0,0,.3)}
.chip.on{background:#378ADD;border-color:#378ADD;color:#fff}
label.ck{display:flex;align-items:center;gap:5px;font-size:12px;color:#5F5E5A;cursor:pointer;user-select:none}
.count{margin-left:auto;font-size:12px;color:#888780}
.tw{overflow:auto;border:1px solid rgba(0,0,0,.12);border-radius:12px;background:#fff;max-height:78vh}
table{border-collapse:separate;border-spacing:0;width:100%;font-size:12.5px}
th,td{padding:7px 9px;text-align:center;white-space:nowrap;border-bottom:1px solid rgba(0,0,0,.07)}
thead th{position:sticky;top:0;background:#F1EFE8;font-weight:500;cursor:pointer;z-index:2;font-size:12px;color:#444441}
thead th:hover{background:#E8E6DF}
th.sn,td.sn{position:sticky;left:0;background:#fff;z-index:1;text-align:left;min-width:80px;font-weight:500}
thead th.sn{background:#F1EFE8;z-index:3}
td.ws{text-align:left;white-space:normal;min-width:132px;max-width:168px;font-size:11.5px;color:#5F5E5A}
td.ws.base{color:#993C1D}
td.sn{border-right:1px solid rgba(0,0,0,.07)}
td.cd{text-align:left;white-space:normal;min-width:230px;max-width:330px;color:#3C3489;font-size:12px}
td.tt{text-align:left;min-width:96px}
/* 隔行底色和 hover 只刷非数值单元格——数值格自己带底色，被刷掉就成白字白底，100 直接看不见 */
tbody tr:hover td:not(.n){background-color:#F7F9FC}
tbody tr.alt td:not(.n){background-color:#FCFCFA}
td.n{font-variant-numeric:tabular-nums}
.w0{color:#C4C2BA}
.w1{background:#F2F7FD;color:#3E6E9E}
.w2{background:#E1EDFA;color:#185FA5}
.w3{background:#C6DDF7;color:#0C447C}
.w4{background:#185FA5;color:#fff;font-weight:600}
.el{display:inline-block;padding:1px 7px;border-radius:6px;font-size:11.5px}
.e-火{background:#FCEBEB;color:#A32D2D}.e-水{background:#E6F1FB;color:#185FA5}.e-风{background:#E1F5EE;color:#0F6E56}
.e-雷{background:#EEEDFE;color:#534AB7}.e-冰{background:#EAF3DE;color:#3B6D11}.e-岩{background:#FAEEDA;color:#854F0B}
.e-草{background:#FBEAF0;color:#993556}
.df{font-size:11px;padding:1px 6px;border-radius:5px;background:#F1EFE8;color:#5F5E5A;margin-right:3px}
.tip{margin-top:14px;font-size:12px;color:#888780;line-height:1.8}
.tip b{font-weight:500;color:#5F5E5A}
details{margin-top:12px;font-size:12px;color:#5F5E5A}
summary{cursor:pointer;color:#378ADD}
</style>`

const RENDER_JS = `
let st={q:'',e:'',d:'',t:'',mul:false,k:'',dir:1};
const bd=document.getElementById('bd'),cnt=document.getElementById('cnt');
let sortFn=null;
function cell(v){return !v?'w0':v>=100?'w4':v>=80?'w3':v>=50?'w2':'w1'}
function render(){
  let list=DATA.filter(r=>{
    if(st.q){const k=st.q.toLowerCase();
      if(!(r.n.toLowerCase().includes(k)||(r.t||'').toLowerCase().includes(k)||(r.c||'').toLowerCase().includes(k)))return false}
    if(st.e&&r.e!==st.e)return false;
    if(st.d==='#none'){if(r.d)return false}else if(st.d&&!(r.d||'').split('/').includes(st.d))return false;
    if(st.t==='b'&&r.b)return false;
    if(st.t==='base'&&!r.b)return false;
    if(st.mul&&!r.m)return false;
    return true;
  });
  if(sortFn)list=list.slice().sort((a,b)=>sortFn(a,b)*st.dir);
  cnt.textContent='共 '+list.length+' 个场景';
  bd.innerHTML=list.map((r,i)=>{
    let h='<tr class="'+(i%2?'alt':'')+'"><td class="sn">'+r.n+'</td><td><span class="el e-'+r.e+'">'+(r.e||'-')+'</span></td><td>'+(r.s||'-')+'</td>';
    h+='<td class="tt">'+r.t+'</td><td class="cd">'+(r.c||'-')+'</td>';
    h+='<td class="ws'+(r.b?' base':'')+'">'+r.w+'</td>';
    r.v.forEach(v=>{h+='<td class="n '+cell(v)+'">'+(v||'-')+'</td>'});
    h+='<td>'+(r.d?r.d.split('/').map(x=>'<span class="df">'+x+'</span>').join(''):'<span style="color:#B4B2A9">静态</span>')+'</td></tr>';
    return h;
  }).join('');
}
const setSort=k=>{
  st.dir=st.k===k?-st.dir:1;st.k=k;
  if(k==='n')sortFn=(a,b)=>a.n.localeCompare(b.n,'zh');
  else if(k==='e')sortFn=(a,b)=>(a.e||'').localeCompare(b.e||'','zh');
  else if(k==='s')sortFn=(a,b)=>(b.s||0)-(a.s||0);
  else if(k==='t')sortFn=(a,b)=>(a.t||'').localeCompare(b.t||'','zh');
  else if(k==='d')sortFn=(a,b)=>(a.d||'').localeCompare(b.d||'','zh');
  else if(k==='w')sortFn=(a,b)=>(a.w||'').localeCompare(b.w||'','zh');
  else sortFn=null;
  render();
};
document.querySelectorAll('th[data-k]').forEach(th=>{th.onclick=()=>setSort(th.dataset.k)});
document.getElementById('q').oninput=e=>{st.q=e.target.value.trim();render()};
document.getElementById('mul').onchange=e=>{st.mul=e.target.checked;render()};
document.querySelectorAll('.chip[data-e]').forEach(c=>{c.onclick=()=>{
  document.querySelectorAll('.chip[data-e]').forEach(x=>x.classList.remove('on'));c.classList.add('on');st.e=c.dataset.e;render()}});
document.querySelectorAll('.chip[data-d]').forEach(c=>{c.onclick=()=>{
  document.querySelectorAll('.chip[data-d]').forEach(x=>x.classList.remove('on'));c.classList.add('on');
  st.d=(c.dataset.d===''&&c.textContent==='无（静态）')?'#none':c.dataset.d;render()}});
document.querySelectorAll('.chip[data-t]').forEach(c=>{c.onclick=()=>{
  document.querySelectorAll('.chip[data-t]').forEach(x=>x.classList.remove('on'));c.classList.add('on');
  st.t=c.dataset.t;render()}});
render();
`

function pageHtml (title: string, sub: string, bars: string, thead: string, data: unknown[], tip: string): string {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
${CSS}
</head>
<body>
<h1>${title}</h1>
<p class="sub">${sub}</p>
${bars}
<div class="tw">
<table id="tb">
<thead><tr>${thead}</tr></thead>
<tbody id="bd"></tbody>
</table>
</div>
${tip}
<script>
const DATA=${JSON.stringify(data)};
${RENDER_JS}
</script>
</body>
</html>
`
}

/* ------------------------------------------------------------------ */
/* 入口                                                                */
/* ------------------------------------------------------------------ */

/** 扫全部角色目录、跑符号执行+运行时探测、按元素→星级→上线顺序排序，返回带场景的整张表。
 *  文档表与场景 JSON 共用这一份，保证两者口径永远一致。 */
async function buildAllChars (): Promise<CharRow[]> {
  const dirs = readdirSync(CHAR_DIR, { withFileTypes: true })
    .filter(d => d.isDirectory() && existsSync(join(CHAR_DIR, d.name, 'data.json')))
    .map(d => d.name)
  const chars: CharRow[] = []
  for (const d of dirs) chars.push(await buildChar(d))
  chars.sort((a, b) =>
    ELEM_ORDER.indexOf(a.elem) - ELEM_ORDER.indexOf(b.elem) ||
    b.star - a.star ||
    a.id - b.id)
  return chars
}

async function main (): Promise<void> {
  const chars = await buildAllChars()

  const genTime = new Date().toLocaleString('zh-CN', { hour12: false })
  const src = gitInfo()
  const srcNote = src ? `数据来源：<b>vendor/miao</b>（miao-plugin 同步于 ${src}）` : '数据来源：<b>vendor/miao</b>'

  /* ---------------- 场景总表 ---------------- */
  const sceneCsv = ['角色,元素,星级,场景,触发条件,权重来源,' + KEYS.map(k => KEY_CN[k]).join(',') + ',依赖因子,触发样例\n']
  const sceneData: Record<string, unknown>[] = []
  let sceneCount = 0
  for (const c of chars) {
    for (const s of c.scenarios) {
      sceneCount++
      sceneCsv.push(csvLine([c.name, c.elem, c.star, s.name, s.cond, s.source, ...s.weights, s.deps, s.sample]))
      sceneData.push({ n: c.name, e: c.elem, s: c.star, t: s.name, c: s.cond, w: shortSrc(s.source), v: s.weights, d: s.deps, b: s.isBase ? 1 : 0, m: c.scenarios.length > 1 ? 1 : 0 })
    }
  }
  writeFileSync(join(DOCS_DIR, '原神圣遗物评分场景总表.csv'), '\uFEFF' + sceneCsv.join(''), 'utf-8')

  const multiCount = chars.filter(c => c.scenarios.length > 1).length
  const sceneBars = `<div class="bar">
<input type="text" id="q" placeholder="搜索角色 / 场景名 / 条件">
<span class="chip on" data-e="">全部元素</span>
${ELEM_ORDER.map(e => `<span class="chip" data-e="${e}">${e}</span>`).join('')}
<label class="ck"><input type="checkbox" id="mul">仅看多套权重角色</label>
<span class="count" id="cnt"></span>
</div>
<div class="bar" style="margin-bottom:14px">
<span class="chip on" data-d="">全部依赖</span>
${FACTOR_ORDER.map(f => `<span class="chip" data-d="${f}">${f}</span>`).join('')}
<span class="chip" data-d="">无（静态）</span>
<span style="width:14px"></span>
<span class="chip on" data-t="">全部场景</span><span class="chip" data-t="b">仅分支场景</span><span class="chip" data-t="base">仅兜底场景</span>
</div>`
  const sceneThead = `<th class="sn" data-k="n">角色</th><th data-k="e">元素</th><th data-k="s">星</th><th class="tt" data-k="t">场景</th><th class="cd">触发条件</th><th class="ws" data-k="w">权重来源</th>`
    + KEYS.map(k => `<th data-k="${k}">${KEY_CN[k]}</th>`).join('')
    + `<th data-k="d">依赖</th>`
  const sceneSub = `每个角色的<b>每个评分分支</b>一行，共 <b>${sceneCount}</b> 个场景 / <b>${chars.length}</b> 个角色，其中 <b>${multiCount}</b> 个角色存在多套权重。条件由源码 <code>if</code> 分支还原，权重由脚本实际执行规则函数测得。生成时间：${genTime}。${srcNote}。`
  const sceneTip = `<div class="tip">
<b>说明</b>：① 权重是规则原始值（artis.js 手写 / usefulAttr 默认表原值），不含评分时内核施加的武器套装适配（护摩之杖加生命、绝缘4 充能齐平、西风系暴击率拉满等），那些要看具体配装；② 「未命中上述任一分支」即兜底行；③ 依赖因子：面板=读面板属性或圣遗物主词条，武器=读武器，命座=读命座，套装=读圣遗物套装，元素=按元素切换规则（旅行者）；④ 触发样例见 CSV，是相对基准面板的差异项，基准面板=生命30000/攻击2000/防御800/暴击5/暴伤50/精通0/充能200/命座0/无武器/无套装/3号位防御/4号位元素伤害/5号位生命；⑤ 默认排序 元素→星级→上线顺序，点表头可改。
</div>
<details><summary>列定义与生成方式</summary>
<div class="tip">
场景：分支名（自定义规则命中特判时）或 基础/默认表/通用兜底（未命中任何特判）。角色名前缀（<code>钟离-武神</code> → <code>武神</code>）已剥掉，旁边就是角色列。<br>
<b>场景名带括号后缀的</b>（如 <code>高命（6命）</code>、<code>高配（充能40）</code>）：artis.js 里的标题是写死的字符串，命座或武器不同时返回的是<b>同一个名字、不同权重</b>，直接列出来会像重复行。后缀是本表加的区分标记——能按命座切开就标命座区间，切不开就标那套权重与众不同的读数。<br>
触发条件：由 artis.js 的 if 树符号执行还原，「或」表示多条等价路径。<b>兜底行</b>指所有特判都没命中时走的路径，条件是那些特判条件的反面。权重来源：分支内权重=artis.js 显式给出；默认表原值=兜底时直接取 usefulAttr；内置基准=artis.js 手写了一整套兜底权重、不查默认表。<br>
生成器：tools/gen_artis_table.ts。静态解析 if 树还原条件文字，动态执行规则函数实测权重，两边按（场景名, 权重）配对校验；本页由该脚本生成，请勿手改。
</div>
</details>`
  writeFileSync(join(DOCS_DIR, '原神圣遗物评分场景总表.html'), pageHtml(
    '原神圣遗物评分场景总表', sceneSub, sceneBars, sceneThead, sceneData, sceneTip), 'utf-8')

  /* ---------------- 场景 JSON（供后端运行时 serve，与文档表同源） ----------------
   * 键 = 角色 avatar_id（= miao data.json 的 id），值是该角色的全部评分场景。
   * weights 是 artis.js 的**原始 attrWeight**（未叠加护摩/绝缘4/西风这类武器套装适配——
   * 那些要看具体配装，运行期按真实 build 现算）。后端 scoreWithWeights 拿到它后再叠适配，
   * 所以这份 JSON 只存「场景本身长啥样」。 */
  const scenarioMap: Record<string, Array<{ name: string; cond: string; weights: number[]; isBase: boolean; deps: string }>> = {}
  for (const c of chars) {
    scenarioMap[String(c.id)] = c.scenarios.map(s => ({
      name: s.name, cond: s.cond, weights: s.weights, isBase: s.isBase, deps: s.deps
    }))
  }
  const scenarioJson = { keys: KEYS, scenarios: scenarioMap }
  writeFileSync(join(ROOT, 'src', 'gateway', 'miao', 'scenarios.json'), JSON.stringify(scenarioJson), 'utf-8')
  console.log(`场景 JSON：${Object.keys(scenarioMap).length} 个角色已写入 src/gateway/miao/scenarios.json`)

  /* ---------------- 校验报告 ---------------- */
  console.log(`角色 ${chars.length} 个，场景 ${sceneCount} 行，多套权重角色 ${multiCount} 个`)
  const bad = chars.filter(c => c.scenarios.some(s => s.source === '（未能从源码还原）'))
  if (bad.length) console.log(`!! ${bad.length} 个角色存在无法还原的场景`)
  if (warnings.length) {
    console.log(`!! ${warnings.length} 条警告:`)
    for (const w of warnings) console.log('   ' + w)
  } else {
    console.log('校验通过：源码分支全部命中，运行时结果全部配对，无不可达路径')
  }
  // 抽查几个已知样例，防呆
  const spot = (name: string, scene: string, expect: number[]): void => {
    const c = chars.find(x => x.name === name)
    const s = c?.scenarios.find(x => x.name === scene)
    const got = s ? s.weights.join(',') : '(无此行)'
    const ok = got === expect.join(',')
    console.log(`${ok ? 'OK ' : '!! '}抽查 ${name}/${scene}: ${got}${ok ? '' : ' 期望 ' + expect.join(',')}`)
  }
  spot('阿蕾奇诺', '纯火', [0, 85, 0, 100, 100, 0, 100, 0, 30, 0])
  spot('阿蕾奇诺', '基础', [0, 75, 0, 100, 100, 75, 100, 0, 30, 0])
  spot('迪希雅', '血牛', [100, 30, 0, 41, 41, 0, 0, 0, 30, 0])
  spot('迪希雅', '基础', [75, 75, 0, 100, 100, 0, 100, 0, 75, 0])
  spot('班尼特', '输出', [100, 100, 0, 100, 100, 0, 100, 0, 75, 100])
  spot('芙宁娜', '板砖纯辅', [100, 0, 0, 0, 0, 0, 0, 0, 100, 95])
  spot('芙宁娜', '基础', [100, 0, 0, 100, 100, 0, 95, 0, 100, 95])
  spot('哥伦比娅', '专武', [100, 0, 0, 100, 100, 75, 0, 0, 85, 0])
  spot('胡桃', '默认表', [80, 50, 0, 100, 100, 75, 100, 0, 0, 0])
}

main().catch(e => { console.error(e); process.exit(1) })

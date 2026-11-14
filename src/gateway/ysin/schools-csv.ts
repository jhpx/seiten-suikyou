/*
 * YSIN 流派预设的 CSV 读写：后端直接读 schools.csv。
 *
 * 列用中文表头 + `#` 注释行说明（见 COLUMNS / NOTES），可用表格软件或文本编辑器改。
 * 文件顶部两行 `# source:` / `# fetchedAt:` 记录原始出处与时间。
 * 本模块不依赖评分代码，tools/ 下的工具可以直接复用。
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/** 一个流派的种子数据（与 schools.ts 的 SchoolSeed 同形） */
export interface SchoolSeed {
  id: string
  name: string
  /** 网站给的评估对象，例如「霜华矢（两段）期望」 */
  skill: string
  note: string
  /** 网站流派里的核心技能 id，例如 q1 / a2 / c6 */
  core: string
  talentSlot: 'a' | 'e' | 'q'
  reaction: boolean
  bench: { atk: number, em: number, cpct: number, cdmg: number }
  /** 当前四维模型装不下的基准条数 */
  extraBench: { hp: number, def: number, recharge: number }
  dmgDefault: number
  /** 网站的 cPanel：进面板的数值。引擎另有不进面板的隐性加成，见 implicit */
  basis: { baseAtk: number, atkPct: number, flatAtk: number, baseCpct: number, baseCdmg: number, baseMastery: number }
  /** 引擎隐性面板加成：GearBasis 字段名 → 增量。与角色 id 无关，缺列就是没有 */
  implicit?: Partial<Record<keyof SchoolSeed['basis'], number>>
  /** 核心天赋 15 个等级的绝对倍率；缺列用常数（词条分里约掉，只影响数据分） */
  talentScale?: number[]
  /** 相对 9 级的倍率覆盖：等级 → 倍率。用于 YSIN 引擎与上游倍率表有偏差的场合 */
  talentRatio?: Record<number, number>
  /** 各命座给核心技能的抗性降低，6 项；缺列就是没有 */
  consShred?: number[]
  /** miao 真公式的伤害条目下标（calc.js 详情数组下标）；缺列就不走 miao 路径 */
  entry?: number
  /** 角色被动给核心技能的额外暴击率（小数），如甘雨 a2 = 0.2；缺列按 0 */
  passiveCpct?: number
  /** 充能残差 f_u 的七个参数；没有充能机制的角色留空，f_u ≡ 1 */
  rechargeModel?: {
    uBonus: number
    etaRate: number
    etaCap: number
    thetaRate: number
    thetaFlatRate: number
    thetaFlatCap: number
    phi0: number
  }
  wText: string
  aText: string
}

export interface CharacterSeed {
  /** 角色稳定数字 id（= 游戏 avatarId / enka avatarId），与语言无关；接口用它当角色主键 */
  id: number
  schools: SchoolSeed[]
}

export interface SchoolsFile {
  source: string
  fetchedAt: string
  characters: CharacterSeed[]
}

/* 中文表头（顺序即 CSV 列顺序），与 NOTES 一一对应 */
export const COLUMNS = [
  '角色ID', '流派ID', '流派名', '评估对象', '备注', '核心技能', '天赋槽', '是否反应',
  '基准攻击%', '基准精通', '基准暴击率', '基准爆伤', '基准生命%', '基准防御%', '基准充能',
  '默认伤害', '面板白字攻击', '面板攻击%', '面板固定攻击', '面板暴击率', '面板爆伤', '面板精通',
  '武器', '圣遗物',
  '隐性面板加成', '天赋倍率表', '等级倍率覆盖', '命座降抗',
  '伤害条目', '被动暴击', '充能转换'
] as const

/* 每列的说明，写进 CSV 顶部的 # 注释 */
export const NOTES: Record<string, string> = {
  '角色ID': '角色数字 id，接口用它与 i18n 查名字；纯标识，不参与算分',
  '流派ID': '流派唯一 id，同一角色内不重复；下拉切换用',
  '流派名': '流派名称；纯标识',
  '评估对象': '该流派算分的输出技能；仅作展示',
  '备注': '备注；不参与计算',
  '核心技能': '流派核心技能 id（如 a1 / e2 / q）；决定技能列表第 0 项与天赋槽',
  '天赋槽': 'a 普攻 / e 战技 / q 爆发；只决定标题显示哪个天赋等级',
  '是否反应': 'true 时精通进伤害公式，反应因子才计入分数',
  '基准攻击%': '标准词条的攻击条数，作词条分分母',
  '基准精通': '标准词条的精通条数；仅 是否反应=true 时起作用',
  '基准暴击率': '标准词条的暴击条数，参与双爆配平',
  '基准爆伤': '标准词条的爆伤条数，配平另一侧',
  '基准生命%': '生命条数；本模型只评攻/精/暴/爆四维，仅占位',
  '基准防御%': '防御条数；同上，仅占位',
  '基准充能': '充能条数；同上，仅占位',
  '默认伤害': '默认整套的引擎伤害，数据分分母；数据分 = 当前伤害 / 它 × 100',
  '面板白字攻击': 'defaultBasis.baseAtk，角色基础攻击 + 武器基础攻击',
  '面板攻击%': 'defaultBasis.atkPct，主词条与武器攻击% 的小数',
  '面板固定攻击': 'defaultBasis.flatAtk，羽毛等固定攻击主词条',
  '面板暴击率': 'defaultBasis.baseCpct，含天生 5% 暴击',
  '面板爆伤': 'defaultBasis.baseCdmg，含天生 50% 爆伤',
  '面板精通': 'defaultBasis.baseMastery；仅 是否反应=true 时生效',
  '武器': '默认整套武器；展示用',
  '圣遗物': '默认整套套装；展示用',
  '隐性面板加成': '引擎算伤害时叠上、但不进面板的量，格式 `字段:增量;字段:增量`；字段取 defaultBasis 的六个名字。技能额外暴击写「被动暴击」列，不要写这里',
  '天赋倍率表': '核心天赋 15 个显示等级的绝对倍率，用 `;` 分隔；缺列按常数 1',
  '等级倍率覆盖': '相对 9 级的倍率，格式 `等级:倍率;等级:倍率`，可写分式保持精度；优先于天赋倍率表',
  '命座降抗': '6 个命座各自的敌人抗性降低（小数），用 `;` 分隔；只累加已解锁部分',
  '伤害条目': '取 calc.js 详情数组的哪一项（从 0 起）；填了才走引擎算当前伤害，留空走近似',
  '被动暴击': '角色被动给核心技能的额外暴击率（小数）；当前侧与参考侧都叠加，Q 流派写 0 或留空',
  '充能转换': 'f_u 的七个参数：`uBonus;etaRate;etaCap;thetaRate;thetaFlatRate;thetaFlatCap;phi0`；没有充能机制的角色留空，f_u ≡ 1'
}

/* ---------- 基础 CSV 解析（支持引号、逗号、换行、双引号转义） ---------- */

function parseCsv (text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let inQuotes = false
  let i = 0
  const n = text.length
  while (i < n) {
    const c = text[i]
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue }
        inQuotes = false; i++; continue
      }
      field += c; i++; continue
    }
    if (c === '"') { inQuotes = true; i++; continue }
    if (c === ',') { row.push(field); field = ''; i++; continue }
    if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++
      row.push(field); field = ''; rows.push(row); row = []; i++; continue
    }
    field += c; i++
  }
  if (field !== '' || row.length > 0) { row.push(field); rows.push(row) }
  return rows.filter(r => r.length > 1 || (r.length === 1 && r[0] !== ''))
}

function csvField (v: string): string {
  if (/[",\n\r]/.test(v)) return '"' + v.replace(/"/g, '""') + '"'
  return v
}

/* 紧凑格式解析：允许写 105983/100189 这种分式，避免手工四舍五入 */
function numExpr (s: string): number {
  const m = /^\s*(-?[\d.]+)\s*\/\s*(-?[\d.]+)\s*$/.exec(s)
  if (m) return Number(m[1]) / Number(m[2])
  return Number(s)
}
function pairsOf (s: string): Array<[string, number]> {
  return s.split(';').map(x => x.trim()).filter(Boolean).map(x => {
    const i = x.indexOf(':')
    return [x.slice(0, i).trim(), numExpr(x.slice(i + 1))] as [string, number]
  })
}
function listOf (s: string): number[] {
  return s.split(';').map(x => numExpr(x.trim())).filter(Number.isFinite)
}
const IMPLICIT_KEYS = new Set(['baseAtk', 'atkPct', 'flatAtk', 'baseCpct', 'baseCdmg', 'baseMastery'])

/* ---------- 序列化：SchoolsFile → CSV 文本 ---------- */

export function serializeSchoolsCsv (data: SchoolsFile): string {
  const lines: string[] = []
  lines.push('# YSIN 流派预设（手维护源文件，UTF-8 无 BOM）')
  lines.push('# 直接编辑本文件即可维护流派数据；改完重启后端服务生效。')
  lines.push(`# source: ${data.source || 'manual-csv'}`)
  lines.push(`# fetchedAt: ${data.fetchedAt || new Date().toISOString()}`)
  lines.push('#')
  lines.push('# 列说明（按列顺序）：')
  for (const cn of COLUMNS) lines.push(`#   ${cn} = ${NOTES[cn] ?? ''}`)
  lines.push('#')
  lines.push(COLUMNS.join(','))
  for (const ch of data.characters) {
    for (const s of ch.schools) {
      const cells = [
        String(ch.id), s.id, s.name, s.skill, s.note, s.core, s.talentSlot, String(s.reaction),
        String(s.bench.atk), String(s.bench.em), String(s.bench.cpct), String(s.bench.cdmg),
        String(s.extraBench.hp), String(s.extraBench.def), String(s.extraBench.recharge),
        String(s.dmgDefault),
        String(s.basis.baseAtk), String(s.basis.atkPct), String(s.basis.flatAtk),
        String(s.basis.baseCpct), String(s.basis.baseCdmg), String(s.basis.baseMastery),
        s.wText, s.aText,
        s.implicit ? Object.entries(s.implicit).map(([k, v]) => `${k}:${v}`).join(';') : '',
        s.talentScale?.join(';') ?? '',
        s.talentRatio ? Object.entries(s.talentRatio).map(([k, v]) => `${k}:${v}`).join(';') : '',
        s.consShred?.join(';') ?? '',
        s.entry === undefined ? '' : String(s.entry),
        s.passiveCpct === undefined ? '' : String(s.passiveCpct),
        s.rechargeModel
          ? [
              s.rechargeModel.uBonus, s.rechargeModel.etaRate, s.rechargeModel.etaCap,
              s.rechargeModel.thetaRate, s.rechargeModel.thetaFlatRate,
              s.rechargeModel.thetaFlatCap, s.rechargeModel.phi0
            ].join(';')
          : ''
      ]
      lines.push(cells.map(c => csvField(String(c))).join(','))
    }
  }
  return lines.join('\n') + '\n'
}

/* ---------- 反序列化：CSV 文本 → SchoolsFile ---------- */

const TALENT = new Set(['a', 'e', 'q'])

type EngineCols = Pick<SchoolSeed, 'implicit' | 'talentScale' | 'talentRatio' | 'consShred'>

/** 四列可选标定 → 结构化字段；空列不产生字段，装配时走统一默认值 */
function engineColsOf (implicit: string, scale: string, ratio: string, shred: string): EngineCols {
  const out: EngineCols = {}
  if (implicit) {
    const m: NonNullable<SchoolSeed['implicit']> = {}
    for (const [k, v] of pairsOf(implicit)) {
      if (IMPLICIT_KEYS.has(k) && Number.isFinite(v)) m[k as keyof typeof m] = v
    }
    if (Object.keys(m).length) out.implicit = m
  }
  if (scale) {
    const a = listOf(scale)
    if (a.length) out.talentScale = a
  }
  if (ratio) {
    const m: Record<number, number> = {}
    for (const [k, v] of pairsOf(ratio)) {
      const lv = Number(k)
      if (Number.isInteger(lv) && Number.isFinite(v)) m[lv] = v
    }
    if (Object.keys(m).length) out.talentRatio = m
  }
  if (shred) {
    const a = listOf(shred)
    if (a.length) out.consShred = a
  }
  return out
}

export function parseSchoolsCsv (text: string): SchoolsFile {
  const rawLines = text.split(/\r?\n/)
  let source = 'manual-csv'
  let fetchedAt = new Date().toISOString()
  const dataLines: string[] = []
  for (const ln of rawLines) {
    const t = ln.trimStart()
    if (t.startsWith('#')) {
      const m = /^#\s*(source|fetchedAt)\s*[:=]\s*(.+?)\s*$/i.exec(t)
      if (m) {
        if (m[1].toLowerCase() === 'source') source = m[2]
        else fetchedAt = m[2]
      }
      continue
    }
    if (t === '') continue
    dataLines.push(ln)
  }
  const rows = parseCsv(dataLines.join('\n'))
  if (rows.length < 1) return { source, fetchedAt, characters: [] }
  const header = rows[0].map(h => h.trim())
  const pos = new Map<string, number>()
  header.forEach((h, i) => pos.set(h, i))
  const cell = (cn: string, r: string[]): string => {
    const i = pos.get(cn)
    return i === undefined ? '' : (r[i] ?? '').trim()
  }
  const byChar = new Map<number, CharacterSeed>()
  for (let r = 1; r < rows.length; r++) {
    const charId = Number(cell('角色ID', rows[r]))
    const schoolName = cell('流派名', rows[r])
    if (!Number.isFinite(charId) || charId <= 0 || !schoolName) continue
    if (!byChar.has(charId)) byChar.set(charId, { id: charId, schools: [] })
    const ch = byChar.get(charId)!
    const num = (cn: string) => Number(cell(cn, rows[r]))
    const slot = cell('天赋槽', rows[r])
    ch.schools.push({
      id: cell('流派ID', rows[r]),
      name: schoolName,
      skill: cell('评估对象', rows[r]),
      note: cell('备注', rows[r]),
      core: cell('核心技能', rows[r]),
      talentSlot: (TALENT.has(slot) ? slot : 'a') as 'a' | 'e' | 'q',
      reaction: cell('是否反应', rows[r]) === 'true',
      bench: {
        atk: num('基准攻击%'), em: num('基准精通'),
        cpct: num('基准暴击率'), cdmg: num('基准爆伤')
      },
      extraBench: {
        hp: num('基准生命%'), def: num('基准防御%'), recharge: num('基准充能')
      },
      dmgDefault: num('默认伤害'),
      basis: {
        baseAtk: num('面板白字攻击'), atkPct: num('面板攻击%'), flatAtk: num('面板固定攻击'),
        baseCpct: num('面板暴击率'), baseCdmg: num('面板爆伤'), baseMastery: num('面板精通')
      },
      wText: cell('武器', rows[r]),
      aText: cell('圣遗物', rows[r]),
      /* 四列引擎标定都是可选的：缺列 / 空串一律给 undefined，走通用默认值 */
      ...engineColsOf(
        cell('隐性面板加成', rows[r]), cell('天赋倍率表', rows[r]),
        cell('等级倍率覆盖', rows[r]), cell('命座降抗', rows[r])
      ),
      /* 缺列 / 空串给 undefined，evaluateCharacter 据此决定是否走引擎 */
      entry: (() => {
        const v = cell('伤害条目', rows[r])
        return v === '' ? undefined : Number(v)
      })(),
      passiveCpct: (() => {
        const v = cell('被动暴击', rows[r])
        return v === '' ? undefined : Number(v)
      })(),
      rechargeModel: (() => {
        const v = cell('充能转换', rows[r])
        if (v === '') return undefined
        const a = listOf(v)
        if (a.length < 7) return undefined
        return {
          uBonus: a[0], etaRate: a[1], etaCap: a[2], thetaRate: a[3],
          thetaFlatRate: a[4], thetaFlatCap: a[5], phi0: a[6]
        }
      })()
    })
  }
  const characters = [...byChar.values()].sort((a, b) => a.id - b.id)
  return { source, fetchedAt, characters }
}

/* 工具函数：把现有 JSON 文件转成 CSV 并写盘（一次性迁移用） */
export function jsonFileToCsv (jsonPath: string, csvPath: string): { characters: number, schools: number } {
  const data = JSON.parse(fs.readFileSync(jsonPath, 'utf8')) as SchoolsFile
  /* JSON 必须带数字角色 id，否则写出 undefined */
  for (const ch of data.characters) {
    const id = Number((ch as { id?: unknown }).id)
    if (!Number.isFinite(id) || id <= 0) {
      throw new Error('这份 schools.json 没有数字角色 id，请先补上 avatarId 再迁移')
    }
    ch.id = id
  }
  fs.writeFileSync(csvPath, serializeSchoolsCsv(data), 'utf8')
  const schools = data.characters.reduce((n, c) => n + c.schools.length, 0)
  return { characters: data.characters.length, schools }
}

/* 手维护体检：解析并报告可疑行（角色ID/数字非法、天赋槽非法、反应列非法、重复 id、缺流派名） */
const NUMERIC_COLS = [
  '基准攻击%', '基准精通', '基准暴击率', '基准爆伤', '基准生命%', '基准防御%', '基准充能',
  '默认伤害', '面板白字攻击', '面板攻击%', '面板固定攻击', '面板暴击率', '面板爆伤', '面板精通'
]

export function validateSchoolsCsv (text: string): { characters: number, schools: number, issues: string[] } {
  const rawLines = text.split(/\r?\n/)
  const dataLines: string[] = []
  for (const ln of rawLines) {
    const t = ln.trimStart()
    if (t.startsWith('#') || t === '') continue
    dataLines.push(ln)
  }
  const rows = parseCsv(dataLines.join('\n'))
  const issues: string[] = []
  if (rows.length < 1) return { characters: 0, schools: 0, issues: ['没有表头行'] }
  const header = rows[0].map(h => h.trim())
  const pos = new Map<string, number>()
  header.forEach((h, i) => pos.set(h, i))
  const cell = (cn: string, r: string[]): string => {
    const i = pos.get(cn)
    return i === undefined ? '' : (r[i] ?? '').trim()
  }
  const ids = new Map<number, Set<string>>()
  let schools = 0
  for (let r = 1; r < rows.length; r++) {
    const charId = Number(cell('角色ID', rows[r]))
    const schoolName = cell('流派名', rows[r])
    if (!Number.isFinite(charId) || charId <= 0 || !schoolName) {
      issues.push(`第 ${r + 1} 行缺少/非法 角色ID 或 流派名，已跳过`)
      continue
    }
    schools++
    for (const cn of NUMERIC_COLS) {
      const v = cell(cn, rows[r])
      if (v !== '' && !Number.isFinite(Number(v))) issues.push(`第 ${r + 1} 行 ${cn}=「${v}」不是数字`)
    }
    const slot = cell('天赋槽', rows[r])
    if (!TALENT.has(slot)) issues.push(`第 ${r + 1} 行 天赋槽=「${slot}」（应为 a/e/q）`)
    const re = cell('是否反应', rows[r])
    if (re !== 'true' && re !== 'false') issues.push(`第 ${r + 1} 行 是否反应=「${re}」（应为 true/false）`)
    const id = cell('流派ID', rows[r])
    if (!ids.has(charId)) ids.set(charId, new Set())
    const set = ids.get(charId)!
    if (set.has(id)) issues.push(`${charId} 流派ID 重复：${id}`)
    else set.add(id)
  }
  return { characters: ids.size, schools, issues }
}

export const CSV_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), 'schools.csv')

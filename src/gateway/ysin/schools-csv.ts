/*
 * YSIN 流派预设的 CSV 读写 —— 单一数据来源就是 schools.csv，后端直接读它。
 *
 * 列用中文表头 + `#` 注释行说明（见 COLUMNS / NOTES），Excel / WPS / 记事本都能改。
 * 文件顶部两行 `# source:` / `# fetchedAt:` 保留原始出处与时间，仅作排查用。
 *
 * 这个模块不依赖 score.ts 等评分代码，方便 tools/ 下的迁移工具直接复用。
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
  basis: { baseAtk: number, atkPct: number, flatAtk: number, baseCpct: number, baseCdmg: number, baseMastery: number }
  wText: string
  aText: string
}

export interface CharacterSeed {
  name: string
  key: string
  schools: SchoolSeed[]
}

export interface SchoolsFile {
  source: string
  fetchedAt: string
  characters: CharacterSeed[]
}

/* 中文表头（顺序即 CSV 列顺序），与 NOTES 一一对应 */
export const COLUMNS = [
  '角色名', '角色键', '流派ID', '流派名', '评估对象', '备注', '核心技能', '天赋槽', '是否反应',
  '基准攻击%', '基准精通', '基准暴击率', '基准爆伤', '基准生命%', '基准防御%', '基准充能',
  '默认伤害', '面板白字攻击', '面板攻击%', '面板固定攻击', '面板暴击率', '面板爆伤', '面板精通',
  '武器', '圣遗物'
] as const

/* 每列的说明，写进 CSV 顶部的 `#` 注释 */
export const NOTES: Record<string, string> = {
  '角色名': '角色中文名，接口查询的 key（如 甘雨）',
  '角色键': '网站原始 key（如 abeiduo / 10000096），同名角色去重用',
  '流派ID': '流派唯一 id，同一角色内不能重复（下拉切换用）',
  '流派名': '流派名称（如 伤害 / 蒸发）',
  '评估对象': '网站给的评估技能描述（如 霜华矢（两段）期望）',
  '备注': '备注',
  '核心技能': '网站核心技能 id（如 a1 / e2 / c6）',
  '天赋槽': 'a 普攻 / e 战技 / q 爆发，决定标题条显示哪个天赋等级',
  '是否反应': 'true / false；反应流派精通才进伤害公式',
  '基准攻击%': '默认基准词条数（整数）',
  '基准精通': '默认基准词条数（整数）',
  '基准暴击率': '默认基准词条数（整数）',
  '基准爆伤': '默认基准词条数（整数）',
  '基准生命%': '四维模型装不下的余量词条数（整数）',
  '基准防御%': '余量词条数（整数）',
  '基准充能': '余量词条数（整数）',
  '默认伤害': '默认整套期望伤害（整数，网站 dText）',
  '面板白字攻击': '基础攻击力（整数 / 小数）',
  '面板攻击%': '攻击加成，小数（0.466 表示 46.6%）',
  '面板固定攻击': '固定攻击（整数）',
  '面板暴击率': '小数（0.36 表示 36%）',
  '面板爆伤': '小数（0.5 表示 50%）',
  '面板精通': '基础精通（整数）',
  '武器': '默认整套武器（如 辰砂之纺锤5精）',
  '圣遗物': '默认整套套装（如 华馆4件）'
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

/* ---------- 序列化：SchoolsFile → CSV 文本 ---------- */

export function serializeSchoolsCsv (data: SchoolsFile): string {
  const lines: string[] = []
  lines.push('# YSIN 流派预设（手维护源文件，UTF-8 无 BOM）')
  lines.push('# 直接编辑本文件即可维护流派数据；改完重启后端服务生效。')
  lines.push('# YSIN 网页版已停更，本文件由 tools/ysin-schools-csv.ts 从原 schools.json 迁移而来。')
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
        ch.name, ch.key, s.id, s.name, s.skill, s.note, s.core, s.talentSlot, String(s.reaction),
        String(s.bench.atk), String(s.bench.em), String(s.bench.cpct), String(s.bench.cdmg),
        String(s.extraBench.hp), String(s.extraBench.def), String(s.extraBench.recharge),
        String(s.dmgDefault),
        String(s.basis.baseAtk), String(s.basis.atkPct), String(s.basis.flatAtk),
        String(s.basis.baseCpct), String(s.basis.baseCdmg), String(s.basis.baseMastery),
        s.wText, s.aText
      ]
      lines.push(cells.map(c => csvField(String(c))).join(','))
    }
  }
  return lines.join('\n') + '\n'
}

/* ---------- 反序列化：CSV 文本 → SchoolsFile ---------- */

const TALENT = new Set(['a', 'e', 'q'])

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
  const byChar = new Map<string, CharacterSeed>()
  for (let r = 1; r < rows.length; r++) {
    const charName = cell('角色名', rows[r])
    const schoolName = cell('流派名', rows[r])
    if (!charName || !schoolName) continue
    const key = cell('角色键', rows[r])
    if (!byChar.has(charName)) byChar.set(charName, { name: charName, key, schools: [] })
    const ch = byChar.get(charName)!
    if (!ch.key && key) ch.key = key
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
      aText: cell('圣遗物', rows[r])
    })
  }
  const characters = [...byChar.values()].sort((a, b) => a.name.localeCompare(b.name, 'zh'))
  return { source, fetchedAt, characters }
}

/* 工具函数：把现有 JSON 文件转成 CSV 并写盘（一次性迁移用） */
export function jsonFileToCsv (jsonPath: string, csvPath: string): { characters: number, schools: number } {
  const data = JSON.parse(fs.readFileSync(jsonPath, 'utf8')) as SchoolsFile
  fs.writeFileSync(csvPath, serializeSchoolsCsv(data), 'utf8')
  const schools = data.characters.reduce((n, c) => n + c.schools.length, 0)
  return { characters: data.characters.length, schools }
}

/* 手维护体检：解析并报告可疑行（非数字、天赋槽非法、反应列非法、重复 id、缺名） */
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
  const ids = new Map<string, Set<string>>()
  let schools = 0
  for (let r = 1; r < rows.length; r++) {
    const charName = cell('角色名', rows[r])
    const schoolName = cell('流派名', rows[r])
    if (!charName || !schoolName) {
      issues.push(`第 ${r + 1} 行缺少 角色名/流派名，已跳过`)
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
    if (!ids.has(charName)) ids.set(charName, new Set())
    const set = ids.get(charName)!
    if (set.has(id)) issues.push(`${charName} 流派ID 重复：${id}`)
    else set.add(id)
  }
  return { characters: ids.size, schools, issues }
}

export const CSV_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), 'schools.csv')

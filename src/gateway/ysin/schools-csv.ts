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
  '武器', '圣遗物'
] as const

/* 每列的说明，写进 CSV 顶部的 `#` 注释；对齐《YSIN算法数学推导》的符号 / 定义 / 定理 */
export const NOTES: Record<string, string> = {
  '角色ID': '角色稳定数字 id（游戏 avatarId / enka avatarId，如 甘雨=10000037、空=10000005、荧=10000007）。与语言无关，接口用它当角色主键；纯标识，不参与算分。角色名不进 CSV，显示时按 id 走 i18n',
  '流派ID': '流派唯一 id，同一角色内不能重复（下拉切换用）；纯标识',
  '流派名': '流派名称（如 伤害 / 蒸发）；纯标识',
  '评估对象': '该流派算分的输出技能（论文 §12.2「霜华矢（两段）期望」）。calc=true 流派里它就是分子 dmgYou 对应的那个技能；其余流派仅作标题展示',
  '备注': '备注；不参与计算',
  '核心技能': '网站 core（如 a1 / e2 / c6，论文 §12.2/§12.5）。决定技能列表第 0 项与天赋槽，仅影响标题展示的技能等级，不改变分数',
  '天赋槽': 'a 普攻 / e 战技 / q 爆发；仅决定标题条显示哪个天赋的等级，不进评分公式（论文无对应变量）',
  '是否反应': 'true / false，对应论文反应乘区 reaction(em)（§6.3③、A5）。true 时精通才进伤害公式，反应因子才计入词条分 / 数据分',
  '基准攻击%': 'bench·攻击（论文 D3 默认基准 7 元组第 2 维 / §1.3）。是"正常毕业"的攻击词条数，作为词条分分母 dmgBench 与极限分 dmgLimit 的输入（§12.1 四个数），经 convertMinor 反解成面板后跑引擎；改它平移分母，分数反比变化',
  '基准精通': 'bench·精通（D3 第 4 维）。同上进入分母；仅当 是否反应=true 才对伤害有贡献（§6.1 不改流派则 6.7 条精通零贡献）',
  '基准暴击率': 'bench·暴击（D3 第 5 维）。进入词条分分母，并参与双爆配平 balanceOf（T2/D5：按 critValue/4 配平）',
  '基准爆伤': 'bench·爆伤（D3 第 6 维）。同上，配平的另一侧（critValue = 2·暴击+爆伤，T3 守恒）',
  '基准生命%': 'bench·生命（D3 第 1 维）。本模型只评攻/精/暴/爆四维，生命归"未计入"，仅占位',
  '基准防御%': 'bench·防御（D3 第 3 维）。同生命，未计入，仅占位',
  '基准充能': 'bench·充能（D3 第 7 维）。同未计入（除非该流派 output 含充能，如绝缘四件）',
  '默认伤害': 'dmgDefault（论文 D7 / §12.1 baseScore）。数据分分母：数据分 = dmgYou / dmgDefault × 100；是"默认整套（默认武器1精/默认主词条/90级/0命/技能999）"的引擎伤害，约掉当前配置；改它等比例缩放数据分',
  '面板白字攻击': 'defaultBasis·atkBase（论文 §1.1 白字攻 = 角色基础+武器基础）。喂进 panelOf 重建攻击面板（D1），也是双爆配平的基线；决定每点攻击%值多少（T4 边际权重）',
  '面板攻击%': 'defaultBasis·atkPct（论文 §1.1 atkMain+atkWeapon 折算成小数，0.466=46.6%）。经 panelOf 计入攻击面板，平移攻击因子',
  '面板固定攻击': 'defaultBasis·atkFlat（论文 羽毛 311，§1.1/D7）。固定攻击主词条，加进面板攻击',
  '面板暴击率': 'defaultBasis·baseCpct（论文 §1.1 生效暴击率，已含基础5%）。喂进面板 critRate 与双爆配平（D5/T2），决定暴击括号项 1+cpct×cdmg',
  '面板爆伤': 'defaultBasis·baseCdmg（论文 §1.1 生效爆伤，已含基础50%）。同上，爆伤侧',
  '面板精通': 'defaultBasis·baseMastery（论文 §1.1 elemMastery）。反应乘区输入；仅 是否反应=true 时生效',
  '武器': '默认整套武器（如 辰砂之纺锤5精）；展示用，标记 dmgDefault 对应的配装',
  '圣遗物': '默认整套套装（如 华馆4件）；展示用'
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
  lines.push('# 各列对应《YSIN算法数学推导》的符号 / 定义 / 定理（论文 PDF：')
  lines.push('#   ../ysin-math/ysin/YSIN算法数学推导.pdf；配套说明见 YSIN-词条分算法.md）。')
  lines.push('# 记号：Dn=论文定义，Tn=论文定理，§n=章节；bench/rolls/dmgX 等符号与论文一致。')
  lines.push(`# source: ${data.source || 'manual-csv'}`)
  lines.push(`# fetchedAt: ${data.fetchedAt || new Date().toISOString()}`)
  lines.push('#')
  lines.push('# 列说明（按列顺序；每列都标了它对应论文里的哪个量、用在哪里、怎么影响分数）：')
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
      aText: cell('圣遗物', rows[r])
    })
  }
  const characters = [...byChar.values()].sort((a, b) => a.id - b.id)
  return { source, fetchedAt, characters }
}

/* 工具函数：把现有 JSON 文件转成 CSV 并写盘（一次性迁移用） */
export function jsonFileToCsv (jsonPath: string, csvPath: string): { characters: number, schools: number } {
  const data = JSON.parse(fs.readFileSync(jsonPath, 'utf8')) as SchoolsFile
  /* 新版以 avatarId 为键；旧版 name/key 形态的 JSON 没有 id，先拒绝，避免写出 undefined */
  for (const ch of data.characters) {
    const id = Number((ch as { id?: unknown }).id)
    if (!Number.isFinite(id) || id <= 0) {
      throw new Error('这份 schools.json 没有数字角色 id（旧版 name/key 形态），请先补上 avatarId 再迁移')
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

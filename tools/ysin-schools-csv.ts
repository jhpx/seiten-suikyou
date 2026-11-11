/*
 * YSIN 流派预设：CSV 迁移与体检工具（单一数据来源就是 schools.csv）。
 *
 * 用法（在仓库根目录执行）：
 *   node tools/ysin-schools-csv.ts to-csv [json路径]
 *       把一份 schools.json 转成带中文注释表头的 schools.csv（一次性迁移；
 *       不给路径时优先用 src/gateway/ysin/schools.json，其次 schools.json.bak）。
 *   node tools/ysin-schools-csv.ts validate
 *       解析 schools.csv 做一次体检：统计角色/流派数，报告角色ID/数字非法、天赋槽非法、
 *       是否反应非法、重复 id、缺流派名等问题。日常手改 CSV 后跑一下很合适。
 *   node tools/ysin-schools-csv.ts refresh
 *       用当前数据就地重写 CSV 顶部的注释表头（数据本身不动）。改了 schools-csv.ts
 *       里的 NOTES 或注释后跑它，把最新论文对照说明刷进文件。
 *
 * 注意：本工具只负责「JSON→CSV 迁移」和「体检」。日常维护就是直接改 schools.csv，
 * 后端（src/gateway/ysin/schools.ts）已经直接读它，不需要再生成 JSON。
 */
import fs from 'node:fs'
import path from 'node:path'

import { CSV_PATH, jsonFileToCsv, parseSchoolsCsv, serializeSchoolsCsv, validateSchoolsCsv } from '../src/gateway/ysin/schools-csv.ts'

const cmd = process.argv[2] ?? 'validate'

if (cmd === 'to-csv') {
  const arg = process.argv[3]
  const dir = path.dirname(CSV_PATH)
  const candidates = [
    arg,
    path.join(dir, 'schools.json'),
    path.join(dir, 'schools.json.bak')
  ].filter(Boolean) as string[]
  const jsonPath = candidates.find(p => p && fs.existsSync(p))
  if (!jsonPath) {
    console.error('找不到 schools.json（可显式传入路径：node tools/ysin-schools-csv.ts to-csv <json路径>）')
    process.exit(1)
  }
  const { characters, schools } = jsonFileToCsv(jsonPath, CSV_PATH)
  console.log(`[to-csv] ${jsonPath} → ${path.relative(process.cwd(), CSV_PATH)}：角色 ${characters} / 流派 ${schools}`)
} else if (cmd === 'refresh') {
  /* 就地用当前数据重写注释表头（改了 NOTES 或注释后跑，数据不动） */
  if (!fs.existsSync(CSV_PATH)) {
    console.error(`找不到 ${CSV_PATH}`)
    process.exit(1)
  }
  const data = parseSchoolsCsv(fs.readFileSync(CSV_PATH, 'utf8'))
  fs.writeFileSync(CSV_PATH, serializeSchoolsCsv(data), 'utf8')
  const schools = data.characters.reduce((n, c) => n + c.schools.length, 0)
  console.log(`[refresh] 重写注释表头：角色 ${data.characters.length} / 流派 ${schools} → ${path.relative(process.cwd(), CSV_PATH)}`)
} else if (cmd === 'validate') {
  if (!fs.existsSync(CSV_PATH)) {
    console.error(`找不到 ${CSV_PATH}`)
    process.exit(1)
  }
  const text = fs.readFileSync(CSV_PATH, 'utf8')
  const { characters, schools, issues } = validateSchoolsCsv(text)
  console.log(`[validate] 角色 ${characters} / 流派 ${schools}`)
  if (issues.length) {
    console.log(`[问题 ${issues.length} 条]`)
    for (const it of issues) console.log('  - ' + it)
    process.exitCode = 1
  } else {
    console.log('[validate] 未发现可疑项 ✔')
  }
} else {
  console.error(`未知命令：${cmd}（用 to-csv / refresh / validate）`)
  process.exit(1)
}

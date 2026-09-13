/*
 * 架构契约测试 —— 锁住「源码内嵌 + 别名解析」这套组装方式
 *
 * 与 regression.mjs 的分工：
 *   regression 管「分数算得对不对」，本文件管「内核是怎么拼起来的」。
 *   评分逻辑一行没动、但边界被无声破坏（改了 package.json 的 imports、
 *   手工动过 vendor/、悄悄引进了新依赖），regression 照样全绿。
 *
 * 全部断言只看本仓库当前状态，不碰上游 miao-plugin 目录。
 */
import fs from 'node:fs'
import path from 'node:path'
import { builtinModules } from 'node:module'
import { fileURLToPath } from 'node:url'

import * as comp from '#miao'
import * as models from '#miao.models'
import * as miaoPath from '#miao.path'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const VENDOR = path.join(ROOT, 'vendor', 'miao')
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))

let failed = 0
let passed = 0

function eq (actual, expected, label) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  console.log(`${ok ? '[PASS]' : '[FAIL]'} ${label}` +
    (ok ? '' : `\n        期望 ${JSON.stringify(expected)}\n        实际 ${JSON.stringify(actual)}`))
  ok ? passed++ : failed++
}

function ok (cond, label) {
  console.log(`${cond ? '[PASS]' : '[FAIL]'} ${label}`)
  cond ? passed++ : failed++
}

/** 列出目录下所有 .js */
function jsFiles (dir) {
  const out = []
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) out.push(...jsFiles(p))
    else if (e.name.endsWith('.js')) out.push(p)
  }
  return out
}

/** 逐行取 import 的模块标识符，跳过注释行 */
function specifiersOf (file) {
  const out = []
  fs.readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
    const t = line.trim()
    if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) return
    for (const m of t.matchAll(/\bfrom\s+['"]([^'"]+)['"]/g)) out.push([m[1], i + 1])
    const bare = t.match(/^import\s+['"]([^'"]+)['"]/)
    if (bare) out.push([bare[1], i + 1])
  })
  return out
}

const FILES = jsFiles(VENDOR)
const rel = (f) => path.relative(VENDOR, f).replace(/\\/g, '/')

// ─────────────────────────────────────────────────────────── 1. 别名解析
console.log('=== 1. 别名解析（package.json imports）===')

eq(Object.keys(pkg.imports || {}).sort(), ['#miao', '#miao.models', '#miao.path'],
  'imports 只声明这三个别名')
for (const [spec, target] of Object.entries(pkg.imports || {})) {
  ok(fs.existsSync(path.resolve(ROOT, target)), `${spec} → ${target} 落地`)
}
eq(Object.keys(comp).sort(), ['Cfg', 'Data', 'Format', 'Meta', 'MiaoError', 'Version'],
  '#miao 导出集合')
eq(Object.keys(models).sort(), ['Artifact', 'ArtifactSet', 'Base', 'Character', 'Material', 'Weapon'],
  '#miao.models 导出集合（云崽模型已摘除）')
eq(path.resolve(miaoPath.miaoPath), VENDOR, '#miao.path 的 miaoPath 指向 vendor/miao')

// ─────────────────────────────────────────── 2. 本地替代的边界
console.log('\n=== 2. 本地替代的边界（Cfg / Version / Data.getRoot）===')

ok(fs.existsSync(path.join(VENDOR, 'components', '_local', 'Cfg.js')), '_local/Cfg.js 存在（生成物）')
ok(fs.existsSync(path.join(VENDOR, 'components', '_local', 'Version.js')), '_local/Version.js 存在（生成物）')

// 上游读不到配置文件时，Cfg.get 返回的是 ret（undefined）而不是 def —— 这里逐字复刻
eq(comp.Cfg.get('notReleasedData'), undefined, "Cfg.get('notReleasedData') → undefined（与上游无配置一致）")
eq(comp.Cfg.get('任意键', '默认值'), undefined, 'Cfg.get(缺省) → 不回落到 def（上游就是这么写的）')
eq(comp.Version.isMiao, false, 'Version.isMiao → false（本项目不在云崽下）')

// 位置敏感点：tools/path.js 靠自身位置推算 miao 根，挪动目录会在这里炸
eq(path.resolve(comp.Data.getRoot('miao')), VENDOR, 'Data.getRoot("miao") → vendor/miao（目录层级硬约束）')

// ─────────────────────────────────────────────────────────── 3. 依赖策略
console.log('\n=== 3. 依赖策略（公共依赖用真的，云崽专属才做替身）===')

eq(Object.keys(pkg.dependencies || {}), ['lodash'], 'dependencies 只有 lodash')
eq(Object.keys(pkg.devDependencies || {}), [], '无 devDependencies')

const lodash = (await import('lodash')).default
ok(typeof lodash.get === 'function' && typeof lodash.isUndefined === 'function',
  'lodash 真的可加载（不是自造 stub）')

// ─────────────────────────────────────────────── 4. vendor 自包含
console.log('\n=== 4. vendor 自包含（不引外部包、不越出目录）===')

const BUILTIN = new Set(builtinModules)
const ALLOWED_BARE = new Set(['lodash'])   // 唯一的运行时依赖
const offenders = []

for (const file of FILES) {
  for (const [spec, line] of specifiersOf(file)) {
    const where = `${rel(file)}:${line}`
    if (spec.startsWith('#')) {
      if (!(pkg.imports || {})[spec]) offenders.push(`${where} 未定义的别名 ${spec}`)
    } else if (spec.startsWith('.')) {
      // 相对 import 必须落在 vendor/miao 内 —— 越出去就说明依赖了仓库别处
      const abs = path.resolve(path.dirname(file), spec)
      if (abs !== VENDOR && !abs.startsWith(VENDOR + path.sep)) {
        offenders.push(`${where} 越出 vendor/miao：${spec}`)
      }
    } else {
      const head = (spec.startsWith('node:') ? spec.slice(5) : spec).split('/')[0]
      if (!ALLOWED_BARE.has(head) && !BUILTIN.has(head)) {
        offenders.push(`${where} 未知外部依赖：${spec}`)
      }
    }
  }
}
ok(offenders.length === 0, `vendor/miao 下 ${FILES.length} 个文件的 import 全在边界内`)
for (const o of offenders.slice(0, 20)) console.log('        ' + o)

// 防止老架构复活：vendor/ 下只应有 miao/ 一个目录
eq(fs.readdirSync(path.join(ROOT, 'vendor')).sort(), ['miao'],
  'vendor/ 下只有 miao/（没有手写替身 _runtime.js 之类）')
ok(fs.existsSync(path.join(VENDOR, 'VENDOR.md')), 'VENDOR.md 生成物标记存在')

// ─────────────────────────────────────── 5. 云崽全局变量零残留
console.log('\n=== 5. 云崽全局变量零残留 ===')

const FORBIDDEN = /(?<![.\w$])(redis|logger|Bot|segment|Renderer|Yunzai)\b/
const leftovers = []
for (const file of FILES) {
  fs.readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
    const t = line.trim()
    if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) return
    const hit = FORBIDDEN.exec(line)
    if (hit) leftovers.push(`${rel(file)}:${i + 1}  →  ${hit[1]}`)
  })
}
ok(leftovers.length === 0, '未残留云崽注入的全局（redis / logger / Bot / segment / Renderer / Yunzai）')
for (const o of leftovers.slice(0, 20)) console.log('        ' + o)

console.log(`\n结果：通过 ${passed} 项，失败 ${failed} 项`)
process.exit(failed > 0 ? 1 : 0)

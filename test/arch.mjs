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

/* Cfg.get 查不到键时**必须回落到调用点给的 def** —— 这是「本地替代」唯一的对外行为约定。
   上游那句 `lodash.isUndefined(cfg) ? def : ret` 判断的是**整个 cfg 对象**，而上游的 cfg
   永远不是 undefined（它是「schema 默认值 + 用户存档」合并出来的），所以那是死代码。
   上游实际给出的就是 **schema 默认值**；我们手上没有那份 schema，只能靠调用点自带的默认值还原。
   ⚠️ 这条断言原来写反了（当时写的是「→ undefined，上游就是这么写的」），
   于是把一个 bug 当成规矩钉死在这里，谁也没发现：
   `components/Format.js` 的 `Cfg.get('commaGroup', 3)` 拿到 undefined 后，
   千分位正则 `\d(?=(\d{undefined})+$)` 一个都匹配不上 → **全站数字丢掉千分位**
   （面板写 17395、词条写 +4778.6），而 miao 自己的结果图是 `+4,778.6` / `18,926`。 */
eq(comp.Cfg.get('commaGroup', 3), 3, "Cfg.get('commaGroup', 3) → 3（与上游 schema 里的 def 一致）")
eq(comp.Cfg.get('任意键', '默认值'), '默认值', 'Cfg.get(缺省) → 回落到调用点给的 def')
/* 端到端：这条才是千分位真正生效的证据（分组数由上面那个 3 决定） */
eq(comp.Format.comma(1234.567), '1,235', 'Format.comma 按 Cfg.get 的分组数打千分位')
/* 另两个调用点（notReleasedData / qFace）只看真假：不给 def 时 def 默认是空串，
   空串与 undefined 一样是 falsy —— 所以这两处行为没变。断「falsy」而不是断 undefined。 */
eq(Boolean(comp.Cfg.get('notReleasedData')), false, "Cfg.get('notReleasedData') → falsy（与上游无配置一致）")
eq(comp.Version.isMiao, false, 'Version.isMiao → false（本项目不在云崽下）')

// 位置敏感点：tools/path.js 靠自身位置推算 miao 根，挪动目录会在这里炸
eq(path.resolve(comp.Data.getRoot('miao')), VENDOR, 'Data.getRoot("miao") → vendor/miao（目录层级硬约束）')

// ─────────────────────────────────────────────────────────── 3. 依赖策略
console.log('\n=== 3. 依赖策略（公共依赖用真的，云崽专属才做替身）===')

/* 依赖策略（2026-10-08 用户校准）：核心是「代码最精简 + 依赖量最小」，
   **允许加轻量第三方库**，所以这里盯的是「清单里都有谁」，而不是「只能有一个」。
   - lodash：miao 内核本来就要，公共依赖用真的，不自造替代
   - limiter：限流的令牌桶，零传递依赖、103KB、原生 ESM
   新加依赖时想清楚：省下的行数配不配得上这个体积。 */
eq(Object.keys(pkg.dependencies || {}).sort(), ['limiter', 'lodash'],
  'dependencies 只有 lodash 与 limiter')
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

// 防止老架构复活：vendor/ 下只应有生成物目录（miao/ 内核 + i18n/ 名字表），
// 不许出现手写的替身文件（_runtime.js 之类）。生成物一律带 VENDOR.md 标记。
eq(fs.readdirSync(path.join(ROOT, 'vendor')).sort(), ['i18n', 'miao'],
  'vendor/ 下只有生成物目录 miao/ 与 i18n/（没有手写替身 _runtime.js 之类）')
for (const dir of ['miao', 'i18n']) {
  ok(fs.existsSync(path.join(ROOT, 'vendor', dir, 'VENDOR.md')), `vendor/${dir}/VENDOR.md 生成物标记存在`)
}

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

// ─────────────────────────────────── 6. 属性图标 SVG 的洁净度与单一配色
console.log('\n=== 6. 属性图标 SVG（assets/character/svgs/）===')

const SVG_DIR = path.join(ROOT, 'src/server/public/assets/character/svgs')
const svgs = fs.readdirSync(SVG_DIR).filter(f => f.endsWith('.svg')).sort()
ok(svgs.length === 16, `16 张属性图标齐（实际 ${svgs.length}）`)

/* 这批 SVG 是从 FIGHT_PROP_* 官方资源导出的，第一版带着一堆导出残留：
 * `class="SvgIcon FIGHT_PROP_*"`、`style="undefined"`、`id="svg-…__path6"`、
 * `data-name="Livello 2"`、Inkscape 的 `<defs><style>.cls-1{fill:…}</style></defs>`
 * 和 `-inkscape-stroke:none;paint-order:…`（那些图根本没有 stroke，全是废话）。
 * 2026-10-07 一次性清干净了，这里钉住 —— **手改 SVG 时最容易漏的就是 style**，
 * 而在 mask 下颜色类属性对渲染**没有任何影响**（只取 alpha），漏了肉眼根本看不出来。
 */
const JUNK = [
  [/class="SvgIcon/, '导出残留 class="SvgIcon …"'],
  [/style="undefined"/, '导出残留 style="undefined"'],
  [/\sid="svg-/, '导出残留 id="svg-…"'],
  [/data-name=/, '导出残留 data-name="Livello N"'],
  [/<defs/, 'Inkscape <defs> 块（.cls-1 配色）'],
  [/-inkscape-stroke/, 'Inkscape 私有属性 -inkscape-stroke'],
  [/paint-order:/, 'Inkscape 私有属性 paint-order'],
  [/<style/, '<style> 块'],
]
for (const f of svgs) {
  const txt = fs.readFileSync(path.join(SVG_DIR, f), 'utf8')
  const bad = JUNK.filter(([re]) => re.test(txt)).map(([, why]) => why)
  ok(bad.length === 0, `${f} 无导出残留${bad.length ? '（' + bad.join('、') + '）' : ''}`)
}

/* 十六张一律白色：形状走 mask，颜色由 CSS 的 background-color 给（= currentColor = 白）。
 * 元素图标曾各自带彩色 fill（#f95 / #b380ff / #5df …），在 CSS 里另配一组 background-color ——
 * 一行属性一种颜色，和其余九个不是一套语言。已统一成 currentColor。 */
const colored = svgs.filter(f => /fill="(?!currentColor|none)[#a-zA-Z]/.test(
  fs.readFileSync(path.join(SVG_DIR, f), 'utf8')))
ok(colored.length === 0, `16 张都不带自己的颜色（实际有色的：${colored.join(', ') || '无'}）`)

/* mask 只取 alpha —— 半透明层次全靠 fill-opacity / opacity撑着，清理时不能一起删。
 * 少了它们，充能那圈淡环、暴击伤害的半透明星、生命值的高光都会变成实心。 */
for (const f of ['icon_charge_efficiency.svg', 'icon_critical_hurt.svg', 'icon_hp.svg']) {
  const txt = fs.readFileSync(path.join(SVG_DIR, f), 'utf8')
  ok(/fill-opacity="\.5"|opacity="\.5"|fill-opacity="\.496933"/.test(txt),
    `${f} 保留半透明层次（fill-opacity / opacity）`)
}
/* 冰是唯一带 stroke 的一张，stroke-width 决定雪花枝的粗细，删了形状会变。 */
ok(/stroke-width="\.3"/.test(fs.readFileSync(path.join(SVG_DIR, 'icon_ice_add_hurt.svg'), 'utf8')),
  'icon_ice_add_hurt.svg 保留 stroke-width（冰花枝的粗细靠它）')

// ─────────────────────────────────── 7. 领域层不许反向依赖外层
console.log('\n=== 7. 领域层（src/domain）只描述「是什么」，不依赖任何外层 ===')

/* 领域模型是最内层（domain/artifact.js、domain/stat.js）。它存在的意义正是
   「让内存里的形状不再由 DB 列名决定」，所以它**不许**反过来知道：
   DB 列名（store）、enka 的响应（adapter）、miao 内核、页面渲染（view）。
   一旦引了，它就退化成「跟着存储列名走的数据袋」—— 那正是它要解决的问题。
   只许引同目录（`./xxx.js`），不比配 miao、不引三方包。 */
const DOMAIN_DIR = path.join(ROOT, 'src', 'domain')
const domainFiles = fs.readdirSync(DOMAIN_DIR).filter(f => f.endsWith('.js')).sort()
ok(domainFiles.length > 0, `src/domain 下有 ${domainFiles.length} 个领域模型文件`)
const domainOffenders = []
for (const f of domainFiles) {
  for (const [spec, line] of specifiersOf(path.join(DOMAIN_DIR, f))) {
    const where = `src/domain/${f}:${line}`
    if (!spec.startsWith('./')) domainOffenders.push(`${where} 引了外层/外部：${spec}`)
  }
}
ok(domainOffenders.length === 0,
  'src/domain 只引同目录（不碰 store / adapter / view / miao / 三方包）')
for (const o of domainOffenders.slice(0, 20)) console.log('        ' + o)

console.log(`\n结果：通过 ${passed} 项，失败 ${failed} 项`)
process.exit(failed > 0 ? 1 : 0)

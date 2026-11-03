/*
 * 架构契约测试 —— 锁住「源码内嵌 + 别名解析」这套组装方式
 *
 * 与 regression.ts 的分工：
 *   regression 管「分数算得对不对」，本文件管「内核是怎么拼起来的」。
 *   评分逻辑一行没动、但边界被无声破坏（改了 package.json 的 imports、
 *   手工动过 vendor/、悄悄引进了新依赖），regression 照样全绿。
 *
 * 全部断言只看本仓库当前状态，不碰上游 miao-plugin 目录。
 */
import fs from 'node:fs'
import path from 'node:path'
import { builtinModules, createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

import * as comp from '#miao'
import * as models from '#miao.models'
import * as miaoPath from '#miao.path'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const VENDOR = path.join(ROOT, 'vendor', 'miao')

/* package.json 的运行时形状 —— 这个测试要断的正是「里面有哪些键」 */
interface PkgShape {
  imports?: Record<string, string>
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
}
const pkg: PkgShape = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))

let failed = 0
let passed = 0

function eq (actual: unknown, expected: unknown, label: string): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  console.log(`${ok ? '[PASS]' : '[FAIL]'} ${label}` +
    (ok ? '' : `\n        期望 ${JSON.stringify(expected)}\n        实际 ${JSON.stringify(actual)}`))
  ok ? passed++ : failed++
}

function ok (cond: unknown, label: string): void {
  console.log(`${cond ? '[PASS]' : '[FAIL]'} ${label}`)
  cond ? passed++ : failed++
}

/** 列出目录下所有 .js（只用来扫 vendor/miao —— 那边永远是 .js） */
function jsFiles (dir: string): string[] {
  const out: string[] = []
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) out.push(...jsFiles(p))
    else if (e.name.endsWith('.js')) out.push(p)
  }
  return out
}

/** 逐行取 import 的模块标识符，跳过注释行 */
function specifiersOf (file: string): Array<[string, number]> {
  const out: Array<[string, number]> = []
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
const rel = (f: string): string => path.relative(VENDOR, f).replace(/\\/g, '/')

// ─────────────────────────────────────────────────────────── 1. 别名解析
console.log('=== 1. 别名解析（package.json imports）===')

eq(Object.keys(pkg.imports || {}).sort(), ['#miao', '#miao.models', '#miao.path'],
  'imports 只声明这三个别名')
for (const [spec, target] of Object.entries(pkg.imports || {})) {
  ok(fs.existsSync(path.resolve(ROOT, target)), `${spec} → ${target} 落地`)
}
eq(Object.keys(comp).sort(), ['Data', 'Format', 'Meta', 'MiaoError'],
  '#miao 导出集合（Cfg / Version 替身已删除）')
eq(Object.keys(models).sort(), ['Artifact', 'ArtifactSet', 'Base', 'Character', 'Material', 'Weapon'],
  '#miao.models 导出集合（云崽模型已摘除）')
eq(path.resolve(miaoPath.miaoPath), VENDOR, '#miao.path 的 miaoPath 指向 vendor/miao')

// ─────────────────────────────────────────── 2. 本地替代的边界
console.log('\n=== 2. 本地替代的边界（Data.getRoot）===')

/* 历史说明：Cfg / Version 两个「云崽替身」已于 2026-11-03 删除。
   - Version 只被 Cfg 内部一个恒 false 的 isMiao 分支引用，纯死代码；
   - Cfg 唯一活着的调用点是 Format.js 的 `Cfg.get('commaGroup', 3)`，而 Cfg 在我们这边
     永远回落到调用点给的 def（3），等价于常量 3，故 Format.js 直接写死 3，不再依赖 Cfg。
   删除后 `#miao` 不再导出 Cfg / Version（见上面导出集合断言）。 */

// 千分位仍按分组数 3 生效（端到端证据；原本由 Cfg.get 的分组数决定，现写死为 3）
eq(comp.Format.comma(1234.567), '1,235', 'Format.comma 按分组数 3 打千分位')

// 位置敏感点：tools/path.js 靠自身位置推算 miao 根，挪动目录会在这里炸
eq(path.resolve(comp.Data.getRoot('miao')), VENDOR, 'Data.getRoot("miao") → vendor/miao（目录层级硬约束）')

// ─────────────────────────────────────────────────────────── 3. 依赖策略
console.log('\n=== 3. 依赖策略（公共依赖用真的，云崽专属才做替身）===')

/* 依赖策略：核心是「代码最精简 + 依赖量最小」—— 允许加轻量第三方库，
   所以这里盯的是「清单里都有谁」：
   - lodash：miao 内核本来就要，公共依赖用真的，不自造替代
   - limiter：限流的令牌桶，零传递依赖、原生 ESM
   - hono / @hono/node-server：HTTP 框架（路由、跨域、静态托管），零传递依赖、纯 JS
   - drizzle-orm：SQL 查询与表定义。纯 JS，不引原生驱动（库还是 node:sqlite 自带那个）
   新加依赖时想清楚：省下的行数配不配得上这个体积，以及是不是纯 JS。 */
eq(Object.keys(pkg.dependencies || {}).sort(), ['@hono/node-server', 'drizzle-orm', 'hono', 'limiter', 'lodash'],
  'dependencies 只有 miao 的 lodash、限流的 limiter、HTTP 的 hono、查询的 drizzle-orm')
/* devDependencies 只容许「不进运行时」的东西：
   - typescript：`tsc --noEmit` 类型检查。运行时用不到它 —— Node 原生剥类型就能直接跑 .ts。
   - @types/node：Node 内置模块（node:fs 等）的类型声明。
   - drizzle-kit：可选的开发期工具（`npx drizzle-kit push` 就地改表、`npx drizzle-kit export --sql` 导 DDL）。
     **运行时不引它**：它连不上 node:sqlite 的内存库，建表是 config/db.ts 现算的。
   想再往里塞（测试框架 / 打包器 / linter）之前先问一句：不加真的不行吗。 */
eq(Object.keys(pkg.devDependencies || {}).sort(), ['@types/node', 'drizzle-kit', 'typescript'],
  'devDependencies 只有 TS 工具链 + 可选的 drizzle-kit')

/* node_modules 的 JS 不在 allowJs 扫描范围内 → 动态 import 会报「找不到声明文件」。
   用 createRequire 取同一个模块（CJS 的 module.exports 就是 lodash 本体），
   免得为一条「依赖是真的」的断言去引 @types/lodash。 */
const lodash = createRequire(import.meta.url)('lodash')
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
const leftovers: string[] = []
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

const SVG_DIR = path.join(ROOT, 'web/assets/character/svgs')
const svgs = fs.readdirSync(SVG_DIR).filter(f => f.endsWith('.svg')).sort()
ok(svgs.length === 16, `16 张属性图标齐（实际 ${svgs.length}）`)

/* 这批 SVG 是从 FIGHT_PROP_* 官方资源导出的，这里钉住「导出残留清干净了」：
   `class="SvgIcon FIGHT_PROP_*"`、`style="undefined"`、`id="svg-…__path6"`、
   `data-name="Livello 2"`、Inkscape 的 `<defs><style>.cls-1{fill:…}</style></defs>`
   和 `-inkscape-stroke:none;paint-order:…`（那些图根本没有 stroke，全是废话）。
   手改 SVG 时最容易漏的就是 style —— 而在 mask 下颜色类属性对渲染**没有任何影响**（只取 alpha），
   漏了肉眼根本看不出来。 */
const JUNK: Array<[RegExp, string]> = [
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

// ─────────────────────────────── 7. dbo 不许反向依赖外层；共用件零依赖
console.log('\n=== 7. 数据库对象层（src/repository/dbo）只描述「是什么」，不依赖任何外层 ===')

/* 数据库对象（repository/dbo/）存在的意义正是「让内存里的形状不再由 DB 列名决定」，
   所以它**不许**反过来知道：行读写（repository 的 .repo.ts）、外部系统（gateway）、
   接口形状（service / rest）。一旦引了，它就退化成「跟着存储列名走的数据袋」。
   能引的只有：同目录（`./xxx.ts`）、以及更底一层的 `../../common/util.ts`（纯 TS 零依赖）
   与 `../../common/stat.ts`（词条词汇表）—— 两个 common 叶子，不带运行环境或外层概念。
   ⚠️ 只放这两个文件进来，**不是整个 common/**：names.ts 要读 vendor 文案表，
   引它等于把 IO 拽进数据库对象层。 */
const DBO_DIR = path.join(ROOT, 'src', 'repository', 'dbo')
const COMMON_DIR = path.join(ROOT, 'src', 'common')
const UTIL_FILE = path.join(COMMON_DIR, 'util.ts')
const STAT_FILE = path.join(COMMON_DIR, 'stat.ts')
const UTIL_SPEC = /^\.\.\/\.\.\/common\/util\.ts$/
const STAT_SPEC = /^\.\.\/\.\.\/common\/stat\.ts$/
const dboFiles = fs.readdirSync(DBO_DIR).filter(f => f.endsWith('.ts')).sort()
ok(dboFiles.length > 0, `src/repository/dbo 下有 ${dboFiles.length} 个数据库对象文件`)
const dboOffenders = []
for (const f of dboFiles) {
  for (const [spec, line] of specifiersOf(path.join(DBO_DIR, f))) {
    const where = `src/repository/dbo/${f}:${line}`
    if (spec.startsWith('./') || UTIL_SPEC.test(spec) || STAT_SPEC.test(spec)) continue
    dboOffenders.push(`${where} 引了外层/外部：${spec}`)
  }
}
ok(dboOffenders.length === 0,
  'src/repository/dbo 只引同目录与 src/common/util.ts、src/common/stat.ts（不碰 .repo.ts / config / gateway / service / rest / miao / 三方包）')
for (const o of dboOffenders.slice(0, 20)) console.log('        ' + o)

/* util 反过来必须**零依赖** —— dbo 层引它，所以它一条 import 都不能有：
   引了 `node:` 就把运行环境带进 dbo 层（`payload_hash` 的 crypto 之所以留在 gateway/enka/，
   就是这个道理），引了任何 src 模块则等于开了条绕过分层的后门。
   common/ 里另外三个不受这条约束：names.ts 天生要读 vendor/i18n/ 下的 json，
   ui.ts 是纯数据表，i18n.ts 是两张表的门面（谁也不引它，它引那两张）。
   默认值全在 config/constants.ts（可以引 `node:path` 拼路径）。 */
const sharedOffenders = []
for (const [spec, line] of specifiersOf(UTIL_FILE)) {
  sharedOffenders.push(`src/common/util.ts:${line} 引了 ${spec}`)
}
ok(sharedOffenders.length === 0, 'src/common/util.ts 零依赖（不引 node: 内置模块、不引任何 src 模块）')
for (const o of sharedOffenders.slice(0, 20)) console.log('        ' + o)

/* common/ 内部的方向也是单向的，别再绕成环：names.ts 只放官方文案表 + 认语言，
   「把界面文字也接进来」是 i18n.ts 门面的活。 */
const NAMES_FILE = path.join(COMMON_DIR, 'names.ts')
const UI_FILE = path.join(COMMON_DIR, 'ui.ts')
const namesToUi = specifiersOf(NAMES_FILE)
  .filter(([spec]) => spec.startsWith('.') && path.resolve(COMMON_DIR, spec) === UI_FILE)
ok(namesToUi.length === 0, 'common/names.ts 不反过来引 ui.ts（接两张表是 i18n.ts 门面的事，否则成环）')
for (const [spec, line] of namesToUi) console.log(`        src/common/names.ts:${line} → ${spec}`)

/* config.ts 是「所有默认值」的最底层：只能有字面量和 node:path 拼路径，**不许引任何 src 模块**。
   一旦它开始引业务（读库、查文案、算分数），配置文件就变成了第二个 service 层，
   「改运维参数」和「改业务逻辑」的分界也跟着没了。 */
const CONFIG_FILE = path.join(ROOT, 'src', 'config', 'constants.ts')
const configToSrc = specifiersOf(CONFIG_FILE).filter(([spec]) => spec.startsWith('.'))
ok(configToSrc.length === 0, 'config/constants.ts 只放默认值（不引任何 src 模块）')
for (const [spec, line] of configToSrc) console.log(`        src/config/constants.ts:${line} → ${spec}`)

// ────────────────────────── 8. 分层：server(+cli) → rest → service → repository（含 dbo）
console.log('\n=== 8. 分层方向（server / rest → service → repository，只能从上往下引）===')

/* 当前形状：
 *     server/      装配（createApp / startServer / CLI 入口）+ URL 表 + 限流   ← 与 cli/ 平级
 *     rest/        控制器：一个资源一个文件，直接平铺，外加 params / reply 两个共用件
 *     service/     用例编排 + 视图组装 + 能力契约（context）
 *     repository/  仓储 + DAO（.repo.ts 行读写）+ dbo/ 数据库对象
 *     gateway/     外部系统隔离：miao/ 引擎适配 + enka/ 抓取与原始响应 → dbo
 *     common/      字典与纯函数
 *
 * 拆目录本身没有约束力 —— 只要 controller 能顺手 `import * as repo`，分层当晚就会塌回去。
 * 所以这里把方向钉死，五条最容易被违反的：
 *   ① repository 不碰任何上层（server / rest / service / gateway）；
 *   ② service 不碰 server / rest（业务层不该知道 HTTP 存在，判空就返回 null / 判别结果）；
 *   ③ rest 不碰 server —— 装配与路由在外层，控制器不该反过来看它，也不能自己起服务 / 托管静态；
 *      控制器还不直接引 repository / service，只认 context 给的那组用例能力；
 *   ④ gateway 是**叶子适配层**：只认识 dbo / common / 三方，不向上引；
 *   ⑤ repository 不许反向引 ../config/store.ts（存储门面引 repository，再引回去就成环）。
 * 反过来允许：server → rest / service（装配点要 openDb、要接能力集；例外只开给这一个目录）。 */
const SRC = path.join(ROOT, 'src')

function tsFiles (dir: string): string[] {
  if (!fs.existsSync(dir)) return []
  const out: string[] = []
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) out.push(...tsFiles(p))
    else if (e.name.endsWith('.ts')) out.push(p)
  }
  return out
}

/** 一批文件里，有没有 import 落进 src/<layer>/ —— 返回人话描述，空数组=干净。
 *  except 里的路径算「合法例外」：精确文件匹配（如 service/context.ts），
 *  或以 `/` 结尾的目录前缀（如 repository/dbo/，排除该目录下所有文件）。 */
function importsInto (files: string[], layer: string, except: string[] = []): string[] {
  const base = path.join(SRC, layer) + path.sep
  const out: string[] = []
  for (const f of files) {
    for (const [spec, line] of specifiersOf(f)) {
      if (!spec.startsWith('.')) continue
      const abs = path.resolve(path.dirname(f), spec)
      if (!abs.startsWith(base)) continue
      const exc = except.some(e =>
        e.endsWith('/') || e.endsWith('\\') ? abs.startsWith(e) : (abs === e || abs + '.ts' === e))
      if (exc) continue
      out.push(`${path.relative(ROOT, f).replace(/\\/g, '/')}:${line} → ${spec}`)
    }
  }
  return out
}

for (const layer of ['server', 'rest', 'service', 'repository', 'config']) {
  ok(fs.existsSync(path.join(SRC, layer)), `src/${layer}/ 是分层目录之一`)
}
/* server 与 cli 是并列的两个进程入口，缺一个都说不通 */
ok(fs.existsSync(path.join(SRC, 'cli')), 'src/cli/ 与 src/server/ 并列（命令行入口 / HTTP 入口）')
/* 三个横向件：不参与竖向流水线，位置固定。gateway 封住外部系统（miao 引擎 + enka 数据源） */
for (const side of ['gateway', 'common']) {
  ok(fs.existsSync(path.join(SRC, side)), `src/${side}/ 是横向件目录之一`)
}
/* 三层按**领域**对照 —— 业务领域在 rest / service / repository 各有一个实现文件，后缀写明层。
   后缀标记「这是这一层的真正实现」：rest 的后缀 = 真正的 HTTP 控制器（meta 是系统领域，只在
   这一层有控制器，没有 service / repo 对应）；service 后缀 = 用例实现；repository 后缀 = 一张表一行。
   非领域件用固定名字、不加后缀：rest 的响应原语 reply.ts、service 的能力契约 context.ts；
   repository 一个都不许有（一行一表也得归到某个领域名下）。
   加新业务领域时三层一起加 —— 这条断言会逼你这么做，而不是只往一层丢个新文件。 */
const DOMAINS = ['account', 'character']
const LAYERS: Array<{ dir: string, suffix: string, domains: string[], plain: string[] }> = [
  { dir: 'rest', suffix: '.rest.ts', domains: [...DOMAINS, 'meta'], plain: ['reply.ts'] },
  { dir: 'service', suffix: '.service.ts', domains: DOMAINS, plain: ['context.ts', 'advice.ts', 'artifact.service.ts', 'simulator.service.ts'] },
  { dir: 'repository', suffix: '.repo.ts', domains: DOMAINS, plain: [] }
]
for (const { dir, suffix, domains, plain } of LAYERS) {
  const actual = fs.readdirSync(path.join(SRC, dir), { withFileTypes: true })
    .filter(e => e.isFile() && e.name.endsWith('.ts')).map(e => e.name).sort()
  const expected = [...domains.map(d => d + suffix), ...plain].sort()
  ok(actual.join(' ') === expected.join(' '),
    `${dir}/ = 实现文件（${domains.map(d => d + suffix).join(' / ')}）+ 固定非领域件（现存的：${actual.join(' / ')}）`)
}

/* 老位置别再复活：adapter / i18n / shared / view 已经各有归宿。
   ⚠️ 这里查的是 **src/i18n 目录**；门面文件 `src/common/i18n.ts` 是另一回事，它在、而且是故意的。 */
const legacy = ['adapter', 'i18n', 'shared', 'view'].filter(d => fs.existsSync(path.join(SRC, d)))
ok(legacy.length === 0, `旧的横向目录不会再长回来（现存的：${legacy.join(' / ') || '无'}）`)

const repoFiles = [
  ...tsFiles(path.join(SRC, 'repository')),
  ...tsFiles(path.join(SRC, 'config'))
]
const serviceFiles = tsFiles(path.join(SRC, 'service'))
const gatewayFiles = tsFiles(path.join(SRC, 'gateway'))
const REST = path.join(SRC, 'rest')
const restFiles = tsFiles(REST)
/* 控制器 = rest 顶层那几个文件（一个资源一个）；reply 是共用件，按名字排除 */
const SHARED_IN_REST = new Set(['reply.ts'])
const ctlFiles = fs.readdirSync(REST, { withFileTypes: true })
  .filter(e => e.isFile() && e.name.endsWith('.ts') && !SHARED_IN_REST.has(e.name))
  .map(e => path.join(REST, e.name))

/* rest 顶层就是控制器：一个资源一个文件，不再套 controllers/ 一层 */
ok(!fs.existsSync(path.join(REST, 'controllers')), 'rest 顶层就是控制器（不再套 controllers/ 一层）')

const repoUp = [
  ...importsInto(repoFiles, 'server'),
  ...importsInto(repoFiles, 'rest'),
  ...importsInto(repoFiles, 'service'),
  ...importsInto(repoFiles, 'gateway')
]
ok(repoUp.length === 0, 'repository / config 只往下（不引 server / rest / service / gateway）')
for (const o of repoUp.slice(0, 20)) console.log('        ' + o)

const sideUp = (files: string[]): string[] => [
  ...importsInto(files, 'server'),
  ...importsInto(files, 'rest'),
  ...importsInto(files, 'service'),
  // repository 里只有 dbo/（数据库对象）是 gateway 可以认识的底层叶子；.repo.ts（行读写）不行
  ...importsInto(files, 'repository', [path.join(SRC, 'repository', 'dbo') + path.sep]),
  // config/constants.ts 是全局默认值（SOURCES / 超时 / UA 都从这拿），叶子层可以引；schema / db / store 不行
  ...importsInto(files, 'config', [path.join(SRC, 'config', 'constants.ts')])
]

const gwUp = sideUp(gatewayFiles)
ok(gwUp.length === 0, 'gateway 是叶子适配层（不引 server / rest / service / repository 行读写 / config 存储；dbo 与 constants 除外）')
for (const o of gwUp.slice(0, 20)) console.log('        ' + o)

const svcUp = [...importsInto(serviceFiles, 'server'), ...importsInto(serviceFiles, 'rest')]
ok(svcUp.length === 0, 'service 不引 server / rest（业务层不懂 HTTP）')
for (const o of svcUp.slice(0, 20)) console.log('        ' + o)

const restUp = importsInto(restFiles, 'server')
ok(restUp.length === 0, 'rest 不引 server（控制器不看装配层，也不自己起服务）')
for (const o of restUp.slice(0, 20)) console.log('        ' + o)

const restServes = restFiles.filter(f => specifiersOf(f)
  .some(([s]) => s === '@hono/node-server' || s.startsWith('@hono/node-server/')))
ok(restServes.length === 0, 'rest 不引 @hono/node-server（托管静态 / 起监听是 server 的活）')
for (const o of restServes.slice(0, 20)) console.log('        ' + path.relative(ROOT, o).replace(/\\/g, '/'))

/* 唯一的合法例外是 service/context.ts 那份契约（控制器必须知道「能力集长什么样」，
   但它只是类型；实现照样藏在 service 里）。除它以外的 service 导入一律不许。 */
const CONTRACT = path.join(SRC, 'service', 'context.ts')
const ctlDown = [
  ...importsInto(ctlFiles, 'repository'),
  ...importsInto(ctlFiles, 'service', [CONTRACT]),
  ...importsInto(ctlFiles, 'server'),
  ...importsInto(ctlFiles, 'config')
]
ok(ctlDown.length === 0, 'rest 控制器只认能力契约（context.ts），不直接引 repository / service 实现 / server / config')
for (const o of ctlDown.slice(0, 20)) console.log('        ' + o)

const ctlSql = ctlFiles.filter(f => specifiersOf(f).some(([s]) => s.startsWith('drizzle-orm')))
ok(ctlSql.length === 0, 'rest 控制器不引 drizzle（写 SQL 是 repository 的活）')
for (const o of ctlSql.slice(0, 20)) console.log('        ' + path.relative(ROOT, o).replace(/\\/g, '/'))

/* repository 顶层（一张表一个文件）只该认识 config 的 schema / db 与 drizzle；引回存储门面 = 环 */
const REPO_STORE = path.join(SRC, 'config', 'store.ts')
const repoBack = []
for (const f of tsFiles(path.join(SRC, 'repository'))) {
  for (const [spec, line] of specifiersOf(f)) {
    if (!spec.startsWith('.')) continue
    const abs = path.resolve(path.dirname(f), spec)
    if (abs === REPO_STORE || abs + '.ts' === REPO_STORE) {
      repoBack.push(`${path.relative(ROOT, f).replace(/\\/g, '/')}:${line} → ${spec}`)
    }
  }
}
ok(repoBack.length === 0, 'repository 不反向引 config 存储门面（否则成环）')
for (const o of repoBack.slice(0, 20)) console.log('        ' + o)

console.log(`\n结果：通过 ${passed} 项，失败 ${failed} 项`)
process.exit(failed > 0 ? 1 : 0)

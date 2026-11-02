/*
 * 命令行测试 —— 把 CLI 当成黑盒跑子进程，断言它「没崩、也没少打印」。
 *
 * 为什么非要单开一套：七套测试原来一套都不跑 CLI，而 `src/cli/score.ts` 真崩过一次 ——
 * 汇总段用了未定义的 `r`，被外层 try/catch 吞掉后**直接 return**，后面的输出一起不执行。
 * 进程退出码还是 0、`npm test` 全绿，只有人肉跑一遍才看得见。
 * 所以这里的断言不能只看退出码，必须看**输出里该有的段落在不在**。
 *
 * 数据用 `test/data/enka-real.json`（一份带真实数值的 enka 响应）+ 临时库，全程不联网。
 */
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { i18n } from '../src/index.ts'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const CLI = path.join(HERE, '..', 'src', 'cli', 'score.ts')
const FIXTURE = path.join(HERE, 'data', 'enka-real.json')
const UID = 900000001
const CHARS = ['迪卢克', '迪奥娜', '砂糖']

let failed = 0
let passed = 0
/* cond 收 unknown：调用点常传 `表值 && 判断` 这种「真值即可」的表达式 */
function ok (cond: unknown, label: string, extra = ''): void {
  console.log(`${cond ? '[PASS]' : '[FAIL]'} ${label}` + (cond || !extra ? '' : `\n        ${extra}`))
  cond ? passed++ : failed++
}

/* 临时库：跑完连 -wal / -shm 一起删干净 */
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'suikyou-cli-'))
const DB = path.join(dir, 'cli.db')
const EMPTY_DB = path.join(dir, 'empty.db')
const rmDb = (f: string): void => { for (const s of ['', '-wal', '-shm']) fs.rmSync(f + s, { force: true }) }

/* 跑一次 CLI。不给 shell —— 参数里的中文/引号原样传过去，免得被 shell 再解释一道。
   stdin 必须 ignore：写 { encoding } 时三个流默认全是 pipe，而这台机器上
   **spawnSync + 管道 stdin 会让子进程根本起不来**（r.status=null、r.error.code='EBUSY'、
   stderr 全空），于是整套 cli 测试齐刷刷报 `code=null` —— 与被测代码无关，
   看着却像 CLI 全崩了。CLI 从不读 stdin，ignore 掉既修好这里也不改变被测行为。
   （同一个坑也踩在 tools/shot.ts 上，那边写得更细。） */
function cli (...args: string[]): { code: number | null; out: string; err: string } {
  const r = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', CLI, ...args],
    { encoding: 'utf8', env: { ...process.env }, stdio: ['ignore', 'pipe', 'pipe'] })
  return { code: r.status, out: r.stdout || '', err: r.stderr || '' }
}

/* 从输出里把「汇总」那几行抽出来：形如 `   184.7  SS   迪卢克        迪卢克-通用`
   只取到收尾那条横线为止 —— 后面可能还跟着 --json 那一整块，别一起吃进来。 */
function summaryLines (out: string): string[] | null {
  const start = out.indexOf('汇总（按总分降序')
  if (start < 0) return null
  const rows: string[] = []
  for (const l of out.slice(start).split('\n').slice(1)) {
    if (l.startsWith('─')) break
    if (l.trim()) rows.push(l)
  }
  return rows
}

function body (out: string): string {
  // npm 会往前插两行 "> ..."，直接跑子进程没有；这里只是防御
  return out.replace(/^> .*$/gm, '')
}

try {
  console.log('=== 1. --help ===')
  {
    const r = cli('--help')
    ok(r.code === 0, '--help 退出码 0', `code=${r.code}`)
    ok(r.out.includes('--uid') && r.out.includes('--offline') && r.out.includes('--json'), '--help 列出了主要参数')
    ok(!r.out.includes('[出错]'), '--help 没有抛错')
  }

  console.log('\n=== 2. 从本地响应入库并打分（--file）===')
  let first = null
  {
    const r = cli('--file', FIXTURE, '--db', DB)
    first = r
    ok(r.code === 0, '退出码 0', `code=${r.code} err=${r.err.trim()}`)
    /* 这两条防的是「崩了会吞掉后面的输出、退出码却还是 0」 */
    ok(!r.out.includes('[出错]'), '输出里没有 [出错]')
    ok(r.out.includes('汇总（按总分降序'), '打印了汇总段（崩在这儿的话这行不会出现）')
    for (const n of CHARS) ok(r.out.includes(n), `输出里有「${n}」`)
    ok(/★\d Lv\.\d+ 命之座\d/.test(r.out), '角色行带着星级/等级/命座')
    ok(r.out.includes('主词条') && r.out.includes('副'), '圣遗物行有主词条与副词条')
    ok(r.out.includes('面板属性'), '打印了面板属性')
    /* ×N 是内核数出来的「同一词条出了几次」，外面聚合去重就没了 —— 顺带守一眼 */
    ok(/×\d/.test(r.out), '副词条带 ×N（词条重复次数没被吃掉）')
  }

  console.log('\n=== 3. 离库重跑（--offline）分数必须一样 ===')
  {
    const r = cli('--offline', '--uid', String(UID), '--db', DB, '--locale', 'chs')
    ok(r.code === 0, '退出码 0', `code=${r.code} err=${r.err.trim()}`)
    const a = summaryLines(body(first.out))
    const b = summaryLines(body(r.out))
    ok(!!a && a.length === CHARS.length, '首次有 3 行汇总', JSON.stringify(a))
    ok(JSON.stringify(a) === JSON.stringify(b), '走一遍库，汇总逐字不变',
      `\n        --file  ${JSON.stringify(a)}\n        --offline ${JSON.stringify(b)}`)
  }

  console.log('\n=== 4. --json 与打印出来的分数一致 ===')
  {
    const r = cli('--json', '--offline', '--uid', String(UID), '--db', DB)
    ok(r.code === 0, '退出码 0', `code=${r.code} err=${r.err.trim()}`)
    let json: Array<Record<string, any>> | null = null
    try {
      /* 前面几段是给人看的文本，JSON 是最后那一整块 —— 从第一个 `[{` 起截 */
      const i = r.out.indexOf('[\n')
      json = JSON.parse(r.out.slice(i))
    } catch (e) {
      ok(false, '--json 输出可解析', e instanceof Error ? e.message : String(e))
    }
    if (json) {
      const list = json
      ok(Array.isArray(list) && list.length === CHARS.length, `--json 出了 ${CHARS.length} 个角色`)
      const one = list[0]
      for (const k of ['avatarId', 'name', 'star', 'level', 'weapon', 'artifacts', 'score', 'attrTable', 'charWeight']) {
        ok(k in one, `形状里有 ${k}`)
      }
      ok(typeof one.score?.markValue === 'number', 'score.markValue 是数字')
      ok(one.charWeight && Object.keys(one.charWeight).length > 0, 'charWeight（权重表）带出来了')
      /* 打印的汇总与 json 的分数对得上（按名字配对）。
         打印那边 mark 是保留一位小数的，json 那边是原始 double —— 比之前先四舍五入。 */
      const printed = summaryLines(body(r.out)) || []
      const bad = list.filter(j => !printed.some(l =>
        l.includes(String(j.nameZh)) && l.includes(j.score.markValue.toFixed(1))))
      ok(bad.length === 0, '汇总里的名字/分数与 --json 一致',
        JSON.stringify(bad.map(j => [j.nameZh, j.score.markValue])))
    }
  }

  console.log('\n=== 5. --list / --keys ===')
  {
    const r = cli('--db', DB, '--list')
    ok(r.code === 0, '--list 退出码 0')
    ok(r.out.includes(String(UID)), `--list 列出了 uid ${UID}`)
    ok(/角色 3 个/.test(r.out), '--list 报了角色数')
  }
  {
    const r = cli('--db', DB, '--keys')
    ok(r.code === 0, '--keys 退出码 0')
    ok(r.out.includes('10000016'), '--keys 列出了角色 id（enka 不给角色名 hash，得另配映射）')
  }

  console.log('\n=== 6. --locale 真的透传到输出 ===')
  {
    /* 期望值直接问 i18n 表，别在测试里手写译名 —— 表更新了测试不用跟着改。
       注意：`classTitle`（规则名，如「迪卢克-通用」）是 miao 自己的中文串，靠
       `src/common/rubric-names.ts` 意译；表没覆盖到的仍会退回中文，这是已知项、不是回归。 */
    const dilucEn = i18n.avatarName(10000016, 'en')
    const en = cli('--offline', '--uid', String(UID), '--db', DB, '--locale', 'en')
    ok(en.code === 0, 'en 退出码 0')
    ok(dilucEn && en.out.includes(`${dilucEn} ★5`), `en 下角色行是「${dilucEn} ★5」（表里没英文就跳过）`)
    ok(!en.out.includes('迪卢克 ★5'), 'en 下角色行没有退回中文名')
    ok(/Total|Scored|Fetched/i.test(en.out), 'en 下界面文字是英文')
    /* 别名也要认（jp → ja） */
    const dilucJa = i18n.avatarName(10000016, 'ja')
    const jp = cli('--offline', '--uid', String(UID), '--db', DB, '--locale', 'jp')
    ok(jp.code === 0 && dilucJa && jp.out.includes(`${dilucJa} ★5`), `别名 jp → ja 生效（${dilucJa}）`)
  }

  console.log('\n=== 7. 出错时退出码不能是 0 ===')
  {
    const r = cli('--offline', '--uid', String(UID), '--db', DB, '--char', '不存在的角色')
    ok(r.code !== 0, '找不到角色时退出码非 0', `code=${r.code}`)
    ok(r.err.includes('没找到角色'), 'stderr 说明了原因')
  }
  {
    /* 给了 --uid 就过了「没有可打分的 uid」那一关，走的是「库里查不到这个人」这条 */
    const r = cli('--offline', '--uid', String(UID), '--db', EMPTY_DB)
    ok(r.code !== 0, '空库离库打分退出码非 0', `code=${r.code}`)
    ok(r.out.includes(`库里没有 uid ${UID}`), '提示了库里没有这个 uid')
  }
  {
    const r = cli('--file', path.join(dir, '压根没有这个文件.json'), '--db', DB)
    ok(r.code === 1, '文件不存在时退出码 1', `code=${r.code}`)
    ok(r.err.includes('[出错]'), '异常走 [出错] 分支（能被捕获）')
  }
} finally {
  rmDb(DB)
  rmDb(EMPTY_DB)
  fs.rmSync(dir, { recursive: true, force: true })
}

console.log(failed > 0
  ? `\n结果：通过 ${passed} 项，失败 ${failed} 项`
  : `\n结果：通过 ${passed} 项，失败 0 项`)
process.exit(failed > 0 ? 1 : 0)

/*
 * 命令行参数解析（src/shared/util.ts 的 parseArgs / argValue）—— cli 和 server 两个入口共用它
 *
 * 为什么单独给它一个测试文件：参数写错了**不会报错**。
 * 真实例子：`--cors-origin=https://x.github.io` 这种等号写法，早先的 parseArgs 不认，
 * 于是把它当成一个名叫 "cors-origin=https://x.github.io" 的开关（值 true），
 * 服务照常起来、日志还打印「跨域 关闭」——人以为配了，其实一点没生效。
 * 这类「静默失效」比直接崩难查得多，所以在这儿钉死。
 */
import { parseArgs, argValue } from '../src/shared/util.ts'

let failed = 0
let passed = 0
function ok (cond: unknown, label: string, extra = ''): void {
  console.log(`${cond ? '[PASS]' : '[FAIL]'} ${label}` + (cond || !extra ? '' : `\n        ${extra}`))
  cond ? passed++ : failed++
}
function eq (a: unknown, b: unknown, label: string): void {
  const same = JSON.stringify(a) === JSON.stringify(b)
  ok(same, label, same ? '' : `期望 ${JSON.stringify(b)} 实际 ${JSON.stringify(a)}`)
}

/* ---------------- 1. 空格写法（`--key value` / `--flag`）---------------- */

console.log('=== 1. 空格写法 ===')
{
  const a = parseArgs(['--port', '8787', '--host', '0.0.0.0', '--trust-proxy'])
  eq(a.port, '8787', '--port 8787 → 值')
  eq(a.host, '0.0.0.0', '--host 0.0.0.0 → 值')
  eq(a['trust-proxy'], true, '后面没跟值的 --trust-proxy → 开关 true')
  eq(a.nope, undefined, '没给的参数 → undefined')
}

/* ---------------- 2. 等号写法（`--key=value`）---------------- */
/* 这条是被踩出来的坑：不认等号时参数静默失效，服务该开跨域却没开。 */

console.log('\n=== 2. 等号写法 ===')
{
  const a = parseArgs(['--port=8787', '--cors-origin=https://x.github.io', '--trust-proxy'])
  eq(a.port, '8787', '--port=8787 → 值（不是开关）')
  /* 值里带 :// 和多个 / 都不能被切开 */
  eq(a['cors-origin'], 'https://x.github.io', '--cors-origin=https://… 整段收成值')
  eq(a['trust-proxy'], true, '等号写法不影响它后面的纯开关')
  eq(Object.keys(a).sort(), ['cors-origin', 'port', 'trust-proxy'], '键名里不带等号')
}

/* ---------------- 3. argValue：只收「有值的」---------------- */

console.log('\n=== 3. argValue ===')
{
  eq(argValue(parseArgs(['--uid', '123']).uid), '123', '有值 → 原样字符串')
  eq(argValue(parseArgs(['--uid']).uid), null, '纯开关 → null（不能变成字符串 "true"）')
  eq(argValue(parseArgs([]).uid), null, '没给 → null（调用点好接默认值）')
}

console.log(`\n结果：通过 ${passed} 项，失败 ${failed} 项`)
process.exit(failed > 0 ? 1 : 0)

/*
 * util —— 跨层通用小工具（纯 TS、零依赖，谁都能引、它谁也不引）
 *
 * 只收「不属于任何一层」的东西：把外部进来的原始形状解析成程序能用的值 ——
 * 上游 JSON 的字符串数字、命令行的 argv，都是「外部形状」。
 */

/*
 * 脏值 → number|null —— 全项目数字归一的唯一点。只该用在两处：
 *   ① 模型的 constructor（对象诞生时把 enka JSON / DB 列归一，每个实例只转这一次）；
 *   ② **出口**解析内核给的字符串数字（Format 出的 "4,778.6"）—— 那是另一条来源，不算重复。
 * ⚠️ 不能用 Number() 顶替：`Number(null)` 和 `Number('')` 都是 0，会把「没这个值」读成「值是 0」。
 * ⚠️ 转不出来给 **null**，不拿 0 充数：等级 0 和「没这个字段」是两回事。
 */
export const num = (v: unknown): number | null => {
  const n = v === '' || v == null ? NaN : Number(v)
  return Number.isFinite(n) ? n : null
}

/* 脏值 → string|null —— 与 num 配对。字符串列同样在 constructor 归一，调用点就不必到处断言类型。 */
export const str = (v: unknown): string | null => (typeof v === 'string' ? v : null)

/*
 * argv → 选项对象：`--key value` 收成 `key: 'value'`，`--flag`（后面没跟值）收成 `true`。
 * 也认 `--key=value`（等号写法）—— 不认的话 `--port=8787` 会被当成一个名叫 "port=8787" 的开关，
 * 参数静默失效。非 `--` 开头的直接忽略 —— 两个调用方（cli / server）都不认位置参数。
 */
export interface ParsedArgs { [key: string]: string | true }

export function parseArgs (argv: readonly string[]): ParsedArgs {
  const out: ParsedArgs = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (!a.startsWith('--')) continue
    const eq = a.indexOf('=')
    if (eq > 2) { out[a.slice(2, eq)] = a.slice(eq + 1); continue }
    const key = a.slice(2)
    const next = argv[i + 1]
    if (next === undefined || next.startsWith('--')) out[key] = true
    else { out[key] = next; i++ }
  }
  return out
}

/* 取「带值的参数」：`string | true` → `string | null`。有值的才算，`--flag` 这种纯开关给 null ——
   免得每个调用点都写一遍 `typeof x === 'string' ? x : null`（再 `|| 默认值`）。 */
export const argValue = (v: string | true | undefined): string | null =>
  typeof v === 'string' ? v : null

/* catch 到的一律是 unknown（TS 4.4 起）—— 取人话消息统一走这里。
   service（记失败流水）与 rest（回 500 / 502 响应）都要用，放共用件免得一层去引另一层。 */
export const errMessage = (e: unknown): string => (e instanceof Error ? e.message : String(e))

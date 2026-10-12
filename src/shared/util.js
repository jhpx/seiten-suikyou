/*
 * util —— 项目通用的小工具（纯 JS、零依赖）
 *
 * 三条规矩，决定了这个文件为什么长这样：
 *
 * ① **谁都能引，它谁也不引**：不 import 任何 src 模块，也不 import `node:` 内置模块。
 *    领域层（src/domain）也引它，而领域层必须与运行环境无关 —— 这正是
 *    `payload_hash` 的算法（要 crypto）留在适配层、不进 domain 的原因。
 * ② **只收「不属于任何一层」的东西**：哪个工具只服务一层，就该搬到那一层去
 *    （比如 `decRound` / `pctText` 只有展示层用 → 留在 view/shape.js）。
 * ③ 于是留在这儿的天然是同一类活：**把外部进来的原始形状解析成程序能用的值**。
 *    上游 JSON 的字符串数字、库里那两列 JSON 文本、命令行的 argv，都是「外部形状」。
 */

/*
 * 脏值 → 数字 / null —— **全项目类型归一的唯一点**。
 *
 * 只有两类地方该用它，别的地方一律**信任「模型字段已经是 number|null」**：
 *   ① 对象**诞生**时：模型的 constructor 把外部原始值（enka 的 JSON、DB 列、被手工改过的库）
 *      归一成 number|null。每个实例只转这一次，转完这个字段的类型就固定了 ——
 *      于是 `ofEnka` / `fromRow` 退化成纯「字段名映射」，谁都不用在调用点各自 num。
 *   ② **出口**解析内核给的字符串数字（`Format` 出的 "4,778.6"）—— 那是另一条来源，
 *      和 ① 的外部数据不是一回事，所以那儿的 num 不算重复。
 *
 * ⚠️ 别拿 `Number(v)` 代替它：`Number(null) === 0`、`Number('') === 0` ——「没有这个值」
 *    会被读成「值是 0」。实测撞过：老库（<v3）的 main_stat_value 是 NULL，被当成 enka 的
 *    0，主词条显示成「生命值 0」。凡是要分清 NULL / 0 的地方都必须走它。
 * ⚠️ 转不出来给 **null**，不拿 0 充数：等级 0 和「没这个字段」是两回事。
 */
export const num = (v) => {
  if (v === undefined || v === null || v === '') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

/* 库里的 JSON 文本列 → 值；空文本 / 坏文本 → null（别让手工改过的库把整包读挂） */
export const parseJson = (text) => {
  if (!text) return null
  try { return JSON.parse(text) } catch { return null }
}

/* 值 → 库里的 JSON 文本列，与 parseJson 配对（null 存成文本 "null"，读回来还是 null） */
export const encodeJson = (v) => JSON.stringify(v ?? null)

/*
 * argv → 选项对象：`--key value` 收成 `key: 'value'`，`--flag`（后面没跟值）收成 `true`。
 *
 * 原先 `src/cli/score.js` 与 `src/server/index.js` 各抄了一份、逐字一样，收到这儿。
 * 非 `--` 开头的参数直接忽略：两个调用方都不认位置参数（uid 也得写成 `--uid 123`）。
 */
export function parseArgs (argv) {
  const out = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (!a.startsWith('--')) continue
    const key = a.slice(2)
    const next = argv[i + 1]
    if (next === undefined || next.startsWith('--')) out[key] = true
    else { out[key] = next; i++ }
  }
  return out
}

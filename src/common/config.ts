/*
 * 全局可调项 —— 换机器、换部署、调运维要动的值集中在这儿，别在业务代码里散写。
 *
 * 判断标准只有一条：**改它算「调运维」还是算「改业务」？**
 *   调运维（端口、库路径、上游地址、超时、限流阈值）→ 进这里；
 *   改业务（属性映射、权重、文案表、上游错误码语义）→ 留在原处，别搬。
 * 另一条是结构：跟着数据/结构走的常量（`SCHEMA_VERSION`、vendor 资源路径）不跟部署走，也不进这里。
 *
 * 这里的值一律只是**默认值**：命令行参数与环境变量优先，覆盖逻辑分别在
 * `server/index.ts`、`upstream/enka.ts`、`server/rate-limit.ts` 里。
 */
import path from 'node:path'

/* ---------------- 语言 ---------------- */

/** 默认语言：简体中文。与 miao 自带的中文名口径一致，也是 names.json 里的主列。 */
export const DEFAULT_LOCALE = 'chs'

/* ---------------- 存储 ---------------- */

/** 没传 `--db` 时用哪个库文件。相对当前工作目录；父目录不存在时 `openDb` 会自己建。 */
export const DEFAULT_DB_FILE = path.join('data', 'gs.db')

/* ---------------- HTTP 服务 ---------------- */

/** 没传 `--port` / `PORT` 时的监听端口。 */
export const DEFAULT_PORT = 8787

/** 命令行入口的默认监听地址：**对外**（局域网可访问）。本服务没有登录鉴权，
 *  只在可信网络里这么开；要只给本机用就 `--host 127.0.0.1`（即下面的 LOCAL_HOST）。 */
export const DEFAULT_HOST = '0.0.0.0'

/** `startServer()` 的默认监听地址：**回环**。调用方有两类 —— 已经想清楚要暴露到哪的
 *  （文件末尾的 CLI 入口，显式传 DEFAULT_HOST），和测试/脚本；后者不传 host 时
 *  不该在不知情的情况下开一个局域网端口。 */
export const LOCAL_HOST = '127.0.0.1'

/* ---------------- 上游数据源 ---------------- */

/** 抓取源。并行打，谁先成功用谁（不串行 —— 慢的那个没人等）。
 *  microgg：国内镜像，热缓存最快，但会回源、会限流；
 *  enka：官方源，稳定 2~4.5s，并行里的保底一票。 */
export const SOURCES: Array<{ name: string; base: string }> = [
  { name: 'microgg', base: 'https://profile.microgg.cn/api/uid/' },
  { name: 'enka', base: 'https://enka.network/api/uid/' }
]

/** 抓取超时（毫秒）。并行下这是「最坏等多久」，不是加分项 —— 谁先回来用谁，慢的没人等。
 *  8s 的依据：microgg 冷回源 6s、enka 抖动上限 4.5s，两边都得留出赢的机会。 */
export const DEFAULT_TIMEOUT_MS = 8000

/** 请求上游时带的 UA：纯标识，别伪装浏览器。发版改版本号时顺手改。 */
export const DEFAULT_UA = 'seiten-suikyou/0.1 (artifact score viewer)'

/* ---------------- 限流 ---------------- */

/** 三档默认额度（每分钟）。可用 `RATE_FETCH` / `RATE_FETCH_ALL` / `RATE_READ` 覆盖，
 *  `--no-rate-limit` 整个关掉。档位为什么这么分见 `server/rate-limit.ts` 的注释。
 *  read 比 fetch 宽十倍：read 只读本地库、代价低，但仍要挡住脚本把 uid 扫一遍；
 *  fetch 会联网打上游，打爆了就是全站 502。 */
export const RATE_DEFAULTS = {
  fetch: { limit: 20, windowMs: 60_000 },
  fetchAll: { limit: 30, windowMs: 60_000 },
  read: { limit: 300, windowMs: 60_000 }
}

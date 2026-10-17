/*
 * 跨域（CORS）—— 只有「前端单独托管 + 后端另放一台机器」时才用得上。
 *
 * 默认什么都不做：开了 CORS 就是允许**任意站点的脚本**读走这里的数据，所以白名单为空时
 * 一个头都不加，等于这层不存在。本地运行时页面和接口是同一个进程，压根不触发跨域。
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Headers } from './http.ts'

/* 许可头：配了白名单 且 来访 Origin 一字不差对上 才给；通配符 * 例外，直接放。 */
function corsHeaders (req: IncomingMessage, allowed: string[]): Headers {
  if (!allowed.length) return {}
  if (allowed.includes('*')) return { 'Access-Control-Allow-Origin': '*' }
  const origin = req.headers.origin
  if (!origin || !allowed.includes(origin)) return {}
  /* 按具体域名回时必须带 Vary: Origin —— 不然中间缓存会把「发给 A 站的许可」
     （Allow-Origin 写着 A）原样回给 B 站，B 站照样被浏览器拦下。 */
  return { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' }
}

/**
 * 处理跨域。返回 true = 这是一发预检（OPTIONS），已经回完了，调用方直接 return；
 * 返回 false = 许可头已挂到 res 上（没配白名单时什么都没挂），继续走业务。
 *
 * 预检必须**先于限流**调用：浏览器在跨域请求带自定义头时会先探一发 OPTIONS，
 * 这里不回 204 它就拦掉，真正的请求根本发不出去。
 * 预检也不该计入限流 —— 它不是业务请求，刷它没有意义，算了反而让「刷新」连点几下就误伤。
 */
export function applyCors (req: IncomingMessage, res: ServerResponse, allowed: string[]): boolean {
  const headers = corsHeaders(req, allowed)
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      ...headers,
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Max-Age': '86400',   /* 预检结果缓存一天，省掉后续往返 */
      'Content-Length': '0'
    })
    res.end()
    return true
  }
  for (const [k, v] of Object.entries(headers)) res.setHeader(k, v)
  return false
}

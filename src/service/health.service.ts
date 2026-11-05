/*
 * 数据源状态快照 —— 周期拉 status.enka.network，解析结果缓存在内存，供 /api/health 读。
 *
 * 为什么是「拉状态页」而不是「自己探活」：官方状态页已算好各区分服（含 MicroGG 镜像），
 * 主页只要「一眼看见」的常驻标识，5 分钟同步一次足够，也不在点刷新时查。
 *
 * 启停：createApp 只建实例（测试里不起定时器，免得挂住进程退出），startServer 才 start()；
 * 定时器用 unref()，即便忘了 stop 也不阻止进程退出。
 */
import { HEALTH_CHECK_INTERVAL_MS } from '../config/constants.ts'
import { fetchEnkaStatus, type RegionStatus } from '../gateway/enka/enka.status.ts'

/** 缓存的形状就是状态页解析结果，/api/health 直接把它发出去。 */
export interface HealthSnapshot {
  regions: RegionStatus[]
  microggServers: RegionStatus[]
}

export interface HealthService {
  get: () => HealthSnapshot
  start: () => void
  stop: () => void
}

export function createHealthService ({ intervalMs = HEALTH_CHECK_INTERVAL_MS }: { intervalMs?: number } = {}): HealthService {
  let snap: HealthSnapshot = { regions: [], microggServers: [] }
  let timer: ReturnType<typeof setInterval> | null = null

  /* 拉失败也不抛：fetchEnkaStatus 自己兜底成 unknown，快照只会被替换、不会变成报错 */
  async function checkAll () {
    snap = await fetchEnkaStatus()
  }

  return {
    get: () => snap,
    start () {
      if (timer) return
      void checkAll()                                   // 启动即拉一次，不等首个周期
      timer = setInterval(() => void checkAll(), intervalMs)
      /* unref：定时器不应阻止进程退出（测试里 server.close() 后若还挂着它会卡死退出）。
         真服务有监听套接字撑着事件循环，定时器照常触发。 */
      timer.unref?.()
    },
    stop () {
      if (timer) { clearInterval(timer); timer = null }
    }
  }
}

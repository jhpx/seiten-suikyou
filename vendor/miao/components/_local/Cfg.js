/*
 * Cfg —— 本项目的最小替代（非上游内容，由 tools/sync_miao.py 生成）
 *
 * 【为什么不用上游 components/Cfg.js】
 * 上游 Cfg 的依赖链是：
 *   components/Cfg.js → components/cfg/CfgData.js → config/system/cfg_system.js（217 行 schema）
 * 整条链是为「云崽用户在聊天里改插件配置」服务的，网页版没有这个交互层。
 * 而评分链路只用到 Cfg.get() 的两个布尔开关：
 *   models/Character.js:59   Cfg.get('notReleasedData')  未实装角色是否返回数据
 *   models/Character.js:313  Cfg.get('qFace')            卡片是否用 q 版头像（只影响渲染）
 * 所以这里复刻「上游读不到配置文件」的行为：cfg 恒为空对象。
 * get 的逻辑逐字照抄上游（含上游那个 lodash.isUndefined(cfg) 的判断），
 * 保证返回值与上游一致 —— 上游此处返回的是 undefined，不是 def。
 */
import lodash from 'lodash'

const cfg = {}
const miaoCfg = {}
const Version = { isMiao: false }

const Cfg = {
  get (rote, def = '') {
    if (Version.isMiao && miaoCfg[rote]) {
      return true
    }
    let ret = lodash.get(cfg, rote)
    return lodash.isUndefined(cfg) ? def : ret
  },
  set (rote, val) {
    cfg[rote] = val
  },
  del (rote) {
    lodash.set(cfg, rote, undefined)
  },
  getCfg () {
    return cfg
  },
  getCfgSchema () {
    return {}
  },
  getCfgSchemaMap () {
    return {}
  },
  /* 上游返回 `style=transform:scale(...)`，本项目不渲染，返回空串 */
  scale () {
    return ''
  }
}

export default Cfg

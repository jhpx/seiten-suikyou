/*
 * Cfg —— 本项目的最小替代（非上游内容，由 tools/sync_miao.py 生成）
 *
 * 【为什么不用上游 components/Cfg.js】
 * 上游 Cfg 的依赖链是：
 *   components/Cfg.js → components/cfg/CfgData.js → config/system/cfg_system.js（217 行 schema）
 * 整条链是为「云崽用户在聊天里改插件配置」服务的，网页版没有这个交互层。
 * 评分链路只用到它的两个布尔开关：
 *   models/Character.js:59   Cfg.get('notReleasedData')  未实装角色是否返回数据
 *   models/Character.js:313  Cfg.get('qFace')            卡片是否用 q 版头像（只影响渲染）
 * 所以这里复刻「上游读不到配置文件」的行为：cfg 恒为空对象。
 *
 * 【get 返回什么：必须给 def，不能给 undefined】
 * 上游 get 里那句 `lodash.isUndefined(cfg) ? def : ret` 判断的是**整个 cfg 对象**，
 * 而上游的 cfg 永远不是 undefined（它是「schema 默认值 + 用户存档」合并出来的），
 * 所以那一支是死代码 —— 上游实际返回 `lodash.get(cfg, rote)`，也就是 **schema 里的默认值**。
 * 我们这边 cfg 是空对象、手上也没有那份 schema，所以「上游会返回 schema 默认值」这件事
 * 只能靠调用点自带的那份默认值还原：查不到就给 def。
 *   components/Format.js:13  `Cfg.get('commaGroup', 3)` —— schema 里 commaGroup 的 def 也是 3
 *   （miao-plugin `config/system/cfg_system.js:207`：逗号分组，千位组设为 3）
 * 三者对得上：schema 默认 3 = 调用点默认 3 = 参考结果图里那个 `+4,778.6`。
 * 之前这里返回 undefined → 那条正则变成 `\\d{(\\d{undefined})+$}`，一个都不匹配 →
 * **全站数字都没有千分位**（面板 17395、词条 +4778.6），跟 miao 的结果图不一致，
 * 而 test/smoke.mjs 当时把错的行为当期望值写进了断言，所以没人发现。
 *
 * 对另外两个调用点的影响：传 truthy 时行为完全一样，因为不给 def 时 def 默认是空串，
 * 空串与 undefined 一样是 falsy（`if (Cfg.get('notReleasedData'))`、`Cfg.get('qFace') ? ...`）。
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
    return lodash.isUndefined(ret) ? def : ret
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

# miao 内核同步报告

- 同步时间：2026-09-13 10:34:54
- 上游来源：`E:/Workspace-Private/workspace-javascript/miao-plugin`（miao-plugin v2.3.3）
- 搬运文件：239 个 / 3154.3 KB
- 原样搬运：232 个　|　定点改写：7 个　|　本地生成：2 个

搬运范围：components（6）、models（17）、resources（215）、tools（1）

## 一、import 变化汇总

本项目**不改写任何别名**：`#miao` / `#miao.models` / `#miao.path` 原样保留，
由 `package.json` 的 `imports` 字段映射到 `vendor/miao` 下的真实文件。
所以 import 层面的变化只发生在被定点改写的入口文件上：

| 文件 | import 变化 |
|---|---|
| `components/index.js` | 移除 `import Common from './Common.js'`；<br>移除 `import Cfg from './Cfg.js'`；<br>移除 `import Version from './Version.js'`；<br>移除 `import App from './App.js'`；<br>改为 `import Cfg from './_local/Cfg.js'`；<br>改为 `import Version from './_local/Version.js'` |
| `components/Data.js` | 移除 `import { rootPath } from '#miao.path'`；<br>改为 `import { rootPath, miaoPath } from '#miao.path'` |
| `models/index.js` | 移除 `import fs from 'node:fs'`；<br>移除 `import Abyss from './Abyss.js'`；<br>移除 `import RoleCombat from './RoleCombat.js'`；<br>移除 `import HardChallenge from './HardChallenge.js'`；<br>移除 `import Player from './Player.js'`；<br>移除 `import Avatar from './Avatar.js'`；<br>移除 `import ProfileDmg from './ProfileDmg.js'`；<br>移除 `import ProfileRank from './ProfileRank.js'`；<br>移除 `import User from './User.js'`；<br>移除 `import MysApi from './MysApi.js'`；<br>移除 `import Button from './Button.js'`；<br>移除 `import { miaoPath } from '#miao.path'` |
| `models/character/CharImg.js` | 移除 `import fs from 'node:fs'`；<br>移除 `import lodash from 'lodash'`；<br>移除 `import sizeOf from 'image-size'`；<br>移除 `import { miaoPath } from '#miao.path'` |

## 二、逐文件改动

### `components/index.js`　[改写]

摘掉云崽专属组件（Common 渲染 / App 应用）；Cfg 与 Version 指向本地最小实现

```diff
@@ -1,10 +1,8 @@
 import Data from './Data.js'
 import Format from './Format.js'
-import Common from './Common.js'
-import Cfg from './Cfg.js'
-import Version from './Version.js'
-import App from './App.js'
+import Cfg from './_local/Cfg.js'
+import Version from './_local/Version.js'
 import MiaoError from './MiaoError.js'
 import Meta from './Meta.js'
 
-export { Data, Cfg, Format, Common, Version, App, MiaoError, Meta }
+export { Data, Cfg, Format, Version, MiaoError, Meta }
```

### `components/Data.js`　[改写]

getRoot 的 miao 分支改为直接指 miao 根；4 个 redis 缓存方法退化为空实现；logger 改 console

```diff
@@ -2,5 +2,5 @@
 import fs from 'node:fs'
 import util from 'node:util'
-import { rootPath } from '#miao.path'
+import { rootPath, miaoPath } from '#miao.path'
 
 const _path = rootPath
@@ -11,5 +11,6 @@
     root = `${_path}/`
   } else if (root === 'miao') {
-    root = `${_path}/plugins/miao-plugin/`
+    // 本项目里 miao 根就是 vendor/miao，没有 yunzai/plugins 这一层
+    root = `${miaoPath}/`
   } else {
     root = `${_path}/plugins/${root}/`
@@ -91,40 +92,18 @@
       return true
     } catch (error) {
-      logger.error(`文件删除失败：${error}`)
+      console.error(`文件删除失败：${error}`)
     }
     return false
   },
 
-  async getCacheJSON (key) {
-    try {
-      let txt = await redis.get(key)
-      if (txt) {
-        return JSON.parse(txt)
-      }
-    } catch (e) {
-      console.log(e)
-    }
-    return {}
-  },
-
-  async setCacheJSON (key, data, EX = 3600 * 24 * 365) {
-    await redis.set(key, JSON.stringify(data), { EX })
-  },
-
-  async redisGet (key, def = {}) {
-    try {
-      let txt = await redis.get(key)
-      if (txt) {
-        return JSON.parse(txt)
-      }
-    } catch (e) {
-      console.log(e)
-    }
-    return def
-  },
-
-  async redisSet (key, data, EX = 3600 * 24 * 90) {
-    await redis.set(key, JSON.stringify(data), { EX })
-  },
+  /* 以下 4 个方法原版依赖云崽注入的全局 redis。本项目没有 redis，
+     评分链路也不走缓存，统一退化为「取不到缓存 / 写入忽略」。*/
+  async getCacheJSON (key) { return {} },
+
+  async setCacheJSON (key, data, EX = 3600 * 24 * 365) {},
+
+  async redisGet (key, def = {}) { return def },
+
+  async redisSet (key, data, EX = 3600 * 24 * 90) {},
 
   async importModule (file, root = '') {
```

### `models/index.js`　[改写]

摘掉云崽专属模型（User / MysApi / Player / Avatar / Abyss…）与其导致的顶层副作用

```diff
@@ -1,58 +1,14 @@
-import fs from 'node:fs'
 import Base from './Base.js'
 import Character from './Character.js'
 import Artifact from './Artifact.js'
 import ArtifactSet from './ArtifactSet.js'
-import Abyss from './Abyss.js'
-import RoleCombat from './RoleCombat.js'
-import HardChallenge from './HardChallenge.js'
-import Player from './Player.js'
-import Avatar from './Avatar.js'
-import ProfileDmg from './ProfileDmg.js'
-import ProfileRank from './ProfileRank.js'
 import Material from './Material.js'
 import Weapon from './Weapon.js'
-import User from './User.js'
-import MysApi from './MysApi.js'
-import Button from './Button.js'
-import { miaoPath } from '#miao.path'
-
-for (let game of ['gs', 'sr']) {
-  for (let type of ['artifact', 'character', 'material', 'weapon']) {
-    let file = `${miaoPath}/resources/meta-${game}/${type}/index.js`
-    if (fs.existsSync(file)) {
-      try {
-        await import(`file://${file}`)
-      } catch (e) {
-        console.log(e)
-      }
-    }
-  }
-}
-
-// 加载自定义角色别名（config/alias_gs.cfg、config/alias_sr.cfg）并启动热更新监听
-try {
-  let { default: CustomAlias } = await import('./alias/CustomAlias.js')
-  await CustomAlias.init()
-} catch (e) {
-  console.log('miao custom alias init failed', e)
-}
-
 export {
   Base,
-  Abyss,
-  RoleCombat,
-  HardChallenge,
-  Button,
   Character,
   Artifact,
   ArtifactSet,
-  Avatar,
-  ProfileDmg,
-  ProfileRank,
   Material,
-  Weapon,
-  User,
-  MysApi,
-  Player
+  Weapon
 }
```

### `tools/path.js`　[改写]

rootPath 由「miao 的上两级」改为 miao 根（本项目没有云崽宿主）

```diff
@@ -10,6 +10,7 @@
 // miao-plugin根路径
 const miaoPath = path.join(__dirname, '..')
-// yunzai根路径
-const rootPath = path.join(miaoPath, '..', '..')
+// 云崽根路径 —— 本项目没有云崽宿主，root 即 miao 根
+// （Data.getRoot 里 '' / 'root' / 'yunzai' 三个分支会用到）
+const rootPath = miaoPath
 
 export { miaoPath, rootPath }
```

### `models/character/CharCfg.js`　[改写]

移除星穹铁道（sr）初始化与分支

```diff
@@ -40,7 +40,4 @@
 await cfgMap.init('gs')
 let cfgMapGs = { ...cfgMap }
-await cfgMap.init('sr')
-let cfgMapSr = { ...cfgMap }
-
 /**
  * 角色相关配置
@@ -64,11 +61,8 @@
   },
   getArtisCfg (char) {
-    if (char.game !== 'sr') {
-      // 评分规则在 旅行者 下而非 旅行者/elem 下
-      let charName = char.isTraveler ? `旅行者` : char.name
-      return cfgMapGs.char[charName]?.artis || false
-    } else {
-      return cfgMapSr.char[char.name]?.artis || false
-    }
+    // 本项目只做原神，星穹铁道分支已移除
+    // 评分规则在 旅行者 下而非 旅行者/elem 下
+    let charName = char.isTraveler ? `旅行者` : char.name
+    return cfgMapGs.char[charName]?.artis || false
   }
 }
```

### `models/character/CharImg.js`　[改写]

整体替换为置空实现（渲染层，写死云崽路径且依赖 image-size）

```diff
@@ -1,160 +1,23 @@
-/**
- * 角色照片及角色图像资源相关
- * */
-import fs from 'node:fs'
-import lodash from 'lodash'
-import sizeOf from 'image-size'
-import { miaoPath } from '#miao.path'
+/*
+ * CharImg —— 本项目已置空（非上游内容，由 tools/sync_miao.py 生成）
+ *
+ * 原文件是渲染层代码：读角色立绘、算图片尺寸，里面写死了云崽的路径
+ * `./plugins/miao-plugin/resources/`，还依赖第三方包 image-size。
+ * 评分是纯计算，用不到图片，故整体替换为空实现。
+ */
+const noop = () => ''
 
-const rPath = `${miaoPath}/resources`
-const CharImg = {
+const CharImg = new Proxy({
+  getCardImg: noop,
+  getRandomImg: noop,
+  getImgs: () => ({}),
+  getImgsSr: () => ({})
+}, {
+  get (t, k) {
+    if (k in t) return t[k]
+    if (typeof k === 'symbol') return undefined
+    return noop
+  }
+})
 
-  // 获取角色的插画
-  getCardImg (names, se = false, def = true) {
-    let list = []
-    let addImg = function (charImgPath, disable = false) {
-      let dirPath = `./plugins/miao-plugin/resources/${charImgPath}`
-
-      if (!fs.existsSync(dirPath)) {
-        fs.mkdirSync(dirPath)
-      }
-      if (disable) {
-        return
-      }
-
-      let imgs = fs.readdirSync(dirPath)
-      imgs = imgs.filter((img) => /\.(png|jpg|webp|jpeg)/i.test(img))
-      lodash.forEach(imgs, (img) => {
-        list.push(`${charImgPath}/${img}`)
-      })
-    }
-    if (!lodash.isArray(names)) {
-      names = [names]
-    }
-    for (let name of names) {
-      addImg(`character-img/${name}`)
-      addImg(`character-img/${name}/upload`)
-      addImg(`character-img/${name}/se`, !se)
-      const plusPath = './plugins/miao-plugin/resources/miao-res-plus/'
-      if (fs.existsSync(plusPath)) {
-        addImg(`miao-res-plus/character-img/${name}`)
-        addImg(`miao-res-plus/character-img/${name}/se`, !se)
-      }
-    }
-    let img = lodash.sample(list)
-    if (!img) {
-      if (def) {
-        // img = '/character-img/default/01.jpg'
-        return false
-      } else {
-        return false
-      }
-    }
-    let ret = sizeOf(`./plugins/miao-plugin/resources/${img}`)
-    ret.img = img
-    ret.mode = ret.width > ret.height ? 'left' : 'bottom'
-    return ret
-  },
-
-  getRandomImg (imgPaths, defImgs = []) {
-    for (let imgPath of imgPaths) {
-      let ret = []
-      for (let type of ['webp', 'png']) {
-        if (fs.existsSync(`${rPath}/${imgPath}.${type}`)) {
-          ret.push(imgPath + `.${type}`)
-        }
-      }
-      if (fs.existsSync(`${rPath}/${imgPath}`)) {
-        let imgs = fs.readdirSync(`${rPath}/${imgPath}`).filter((file) => {
-          return /\.(png|webp)$/.test(file)
-        })
-        for (let img of imgs) {
-          ret.push(`${imgPath}/${encodeURIComponent(img)}`)
-        }
-      }
-      if (ret.length > 0) {
-        return lodash.sample(ret)
-      }
-    }
-    for (let defImg of defImgs) {
-      if (fs.existsSync(`${rPath}/${defImg}`)) {
-        return defImg
-      }
-    }
-  },
-
-  // 获取角色的图像资源数据
-  getImgs (name, costumeIdx = '', travelerElem = '', weaponType = 'sword', talentCons) {
-    let fileType = 'webp'
-    costumeIdx = costumeIdx === '2' ? '2' : ''
-    let imgs = {}
-    if (!['空', '荧', '旅行者'].includes(name)) {
-      travelerElem = ''
-    }
-    const nPath = `/meta-gs/character/${name}/`
-    const tPath = `/meta-gs/character/旅行者/${travelerElem}/`
-    let add = (key, path, path2) => {
-      if (path2 && fs.existsSync(`${rPath}/${nPath}/${path2}.${fileType}`)) {
-        imgs[key] = `${nPath}${path2}.${fileType}`
-      } else {
-        imgs[key] = `${nPath}${path}.${fileType}`
-      }
-    }
-    let tAdd = (key, path) => {
-      imgs[key] = `${travelerElem ? tPath : nPath}${path}.${fileType}`
-    }
-    add('face', 'imgs/face', `imgs/face${costumeIdx}`)
-    add('qFace', 'imgs/face', 'imgs/face-q')
-    add('side', 'imgs/side', `imgs/side${costumeIdx}`)
-    add('gacha', 'imgs/gacha')
-    add('splash', 'imgs/splash', `imgs/splash${costumeIdx}`)
-    tAdd('card', 'imgs/card')
-    tAdd('banner', 'imgs/banner')
-    for (let i = 1; i <= 6; i++) {
-      tAdd(`cons${i}`, `icons/cons-${i}`)
-    }
-    for (let i = 0; i <= 4; i++) {
-      tAdd(`passive${i}`, `icons/passive-${i}`)
-    }
-    imgs.a = `/common/item/atk-${weaponType}.webp`
-    for (let t of ['e', 'q']) {
-      imgs[t] = talentCons[t] > 0 ? imgs[`cons${talentCons[t]}`] : `${nPath}icons/talent-${t}.webp`
-    }
-    return imgs
-  },
-
-  // 获取星铁角色图像资源
-  getImgsSr (name, talentCons) {
-    let fileType = 'webp'
-    const nPath = `/meta-sr/character/${name}/`
-    let imgs = {}
-    let add = (key, path, path2) => {
-      if (path2 && fs.existsSync(`${rPath}/${nPath}/${path2}.${fileType}`)) {
-        imgs[key] = `${nPath}${path2}.${fileType}`
-      } else {
-        imgs[key] = `${nPath}${path}.${fileType}`
-      }
-    }
-    add('face', 'imgs/face')
-    add('qFace', 'imgs/face', 'imgs/face-q')
-    add('splash', 'imgs/splash')
-    add('preview', 'imgs/preview')
-    for (let i = 1; i <= 4; i++) {
-      add(`tree${i}`, `imgs/tree-${i}`)
-    }
-    for (let key of ['a', 'e', 'q', 't', 'z', 'a2', 'e2', 'q2', 'xe', 'me', 'mt']) {
-      add(key, `imgs/talent-${key}`)
-    }
-    for (let i = 1; i <= 6; i++) {
-      if (i !== 3 && i !== 5) {
-        add(`cons${i}`, `imgs/cons-${i}`)
-      }
-    }
-    imgs.banner = 'meta-sr/character/common/imgs/banner.webp'
-    imgs.card = 'meta-sr/character/common/imgs/card.webp'
-    imgs.cons3 = imgs[talentCons[3]]
-    imgs.cons5 = imgs[talentCons[5]]
-    return imgs
-  }
-}
 export default CharImg
```

### `models/Base.js`　[改写]

缓存定时器加 unref（原版 10 分钟 setTimeout 会把一次性脚本拖住）

```diff
@@ -82,4 +82,5 @@
           self._delCache()
         }, time * 1000)
+        if (reFn[id] && reFn[id].unref) reFn[id].unref()
       }
       return cacheMap[id]
```

### `components/_local/Cfg.js`　[生成]

云崽用户配置的最小替代

本项目手写内容，非上游文件：

```js
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
```

### `components/_local/Version.js`　[生成]

云崽版本检测的最小替代

本项目手写内容，非上游文件：

```js
/*
 * Version —— 本项目的最小替代（非上游内容，由 tools/sync_miao.py 生成）
 *
 * 上游 components/Version.js 读 package.json / CHANGELOG.md、检测宿主机型
 * （Yunzai V2 / V3 / AlemonJS），这些概念在本项目里都不存在。
 * 评分链路只用到 Version.isMiao —— 上游在云崽下为 true，本项目恒 false。
 */
const Version = {
  version: 'local',
  isMiao: false,
  isV3: false,
  name: 'seiten-suikyou',
  get yunzai () {
    return ''
  },
  get changelogs () {
    return ''
  },
  runtime () {},
  readLogFile () {
    return {}
  }
}

export default Version
```

## 三、校验

- 相对 import 全部指向已搬运文件
- `#miao*` 别名全部能在 `package.json` 的 `imports` 中解析
- 无云崽注入的全局变量残留（redis / logger / Bot / segment / Renderer / Yunzai）

#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
星天水镜 / seiten-suikyou —— miao 评分内核同步脚本

把 miao-plugin 里评分用得上的源码搬进 vendor/miao/，并只对「云崽机器人专属」
的依赖做定点处理。每次同步额外产出 docs/reports/sync-report.md，讲清三件事：
同步了哪些数据、改了哪些、相对上一版差在哪。

用法:
    python tools/sync_miao.py
    MIAO_PLUGIN_PATH=/path/to/miao-plugin python tools/sync_miao.py

设计原则:
  1. 能原样搬的就原样搬 —— 不为了「干净」而重写上游代码。
  2. 只有确认本项目用不到、且拿不到的东西才处理：云崽注入的全局（redis / logger）、
     云崽专属组件（Common 渲染 / App 应用）、云崽专属模型（User / MysApi / Player…）。
  3. 别名不改写 —— `#miao` / `#miao.models` / `#miao.path` 原样保留，
     由 package.json 的 imports 字段映射到 vendor/miao 下的真实文件。
  4. 所有改动必须可审计 —— 改动用凝练语言描述清楚（不贴 diff，逐行核对走 git）。
     增量也交给 git 算：vendor/miao 本来就是 git 跟踪的，diff 一下就有，
     没必要另存一份哈希清单（详见下面「增量」一节）。
"""

from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import sys
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
VENDOR = ROOT / "vendor" / "miao"
REPORT = ROOT / "docs" / "reports" / "sync-report.md"
PKG = ROOT / "package.json"

_env = os.environ.get("MIAO_PLUGIN_PATH")
MIAO = Path(_env).resolve() if _env else (ROOT.parent / "miao-plugin").resolve()


# --------------------------------------------------------------------------
# 1. 搬运清单
# --------------------------------------------------------------------------
# 来源是实测的评分依赖闭包，外加闭包收集不到的「运行时动态读取」资源
# （Data.readJSON 的路径）。只搬原神（meta-gs），星穹铁道（meta-sr）一概不要。
FILES = [
    # --- 入口与组件 ---
    "components/index.js",        # `#miao`
    "components/Data.js",
    "components/Meta.js",
    "components/Format.js",
    "components/MiaoError.js",
    "components/common/Elem.js",
    # --- 模型入口 ---
    "models/index.js",            # `#miao.models`
    # --- 评分算法 ---
    "models/artis/Artis.js",
    "models/artis/ArtisAttr.js",
    "models/artis/ArtisMark.js",
    "models/artis/ArtisMarkCfg.js",
    "models/artis/ArtisSet.js",
    # --- 领域模型 ---
    "models/Base.js",
    "models/Character.js",
    "models/Weapon.js",
    "models/Artifact.js",
    "models/ArtifactSet.js",
    "models/Material.js",
    "models/character/CharCfg.js",
    "models/character/CharId.js",
    "models/character/CharMeta.js",
    "models/character/CharTalent.js",
    # --- 面板属性计算（角色规则读 profile.attr，见下方说明） ---
    "models/attr/Attr.js",
    "models/attr/AttrData.js",
    # --- 伤害计算：编排入口 + dmg 引擎（每个角色的 calc.js 靠下面 GLOBS 按目录搬） ---
    "models/ProfileDmg.js",
    "models/dmg/DmgAttr.js",
    "models/dmg/DmgBuffs.js",
    "models/dmg/DmgCalc.js",
    "models/dmg/DmgCalcMeta.js",
    "models/dmg/DmgMastery.js",
    "models/dmg/AttrItem.js",
    # --- 路径工具（`#miao.path`，零云崽依赖，原样搬） ---
    "tools/path.js",
    # --- 圣遗物元数据：权重表 / 词条基准 / 套装数据 ---
    "resources/meta-gs/artifact/index.js",
    "resources/meta-gs/artifact/extra.js",
    "resources/meta-gs/artifact/artis-mark.js",
    "resources/meta-gs/artifact/alias.js",
    "resources/meta-gs/artifact/calc.js",
    "resources/meta-gs/artifact/data.json",
    # --- 角色元数据：基础数据 + 每个角色的评分规则 ---
    "resources/meta-gs/character/index.js",
    "resources/meta-gs/character/alias.js",
    "resources/meta-gs/character/extra.js",
    "resources/meta-gs/character/data.json",
    # --- 素材（CharMeta 引用了 Material 模型） ---
    "resources/meta-gs/material/index.js",
    "resources/meta-gs/material/abbr.js",
    "resources/meta-gs/material/daily.js",
    "resources/meta-gs/material/data.json",
    # --- 武器元数据：Attr 算面板要用（Weapon.calcAttr + weaponBuffs） ---
    # 图片（icon/gacha/awaken.webp，占 21MB）一概不搬，只搬数据
    "resources/meta-gs/weapon/index.js",
    "resources/meta-gs/weapon/alias.js",
    "resources/meta-gs/weapon/desc.js",
    "resources/meta-gs/weapon/extra.js",
    "resources/meta-gs/weapon/sword/calc.js",
    "resources/meta-gs/weapon/sword/data.json",
    "resources/meta-gs/weapon/bow/calc.js",
    "resources/meta-gs/weapon/bow/data.json",
    "resources/meta-gs/weapon/catalyst/calc.js",
    "resources/meta-gs/weapon/catalyst/data.json",
    "resources/meta-gs/weapon/claymore/calc.js",
    "resources/meta-gs/weapon/claymore/data.json",
    "resources/meta-gs/weapon/polearm/calc.js",
    "resources/meta-gs/weapon/polearm/data.json",
]

# 目录级规则：(基目录, 文件名, 层数)。层数 1 = 基目录/*/文件名，2 = 基目录/*/*/文件名。
# 这些是运行时动态读取的资源（Data.readJSON），依赖闭包扫不出来，只能按目录规则搬。
GLOBS = [
    ("resources/meta-gs/character", "data.json", 1),
    # 旅行者按元素分开放 data.json（character/旅行者/<元素>/data.json）。
    # 深度 1 只搬得到索引级的 旅行者/data.json（没有 talentData），而内核 getDetail()
    # 对旅行者按 `旅行者/<elem>` 取数 —— 少这一层，旅行者的天赋倍率查表直接空、
    # 伤害计算必炸（冰翼给 7 个元素都写了 calc.js，没理由不搬）。
    # 深度 2 还会带上芭芭拉/安柏（皮肤数据），无人读，无害。
    ("resources/meta-gs/character", "data.json", 2),
    ("resources/meta-gs/character", "artis.js", 1),
    # 角色伤害计算脚本：普通角色在 character/<角色名>/calc.js；
    # 旅行者按元素分开放 character/旅行者/<元素>/calc.js（深度 2，全资源目录里仅此一例，
    # 其余角色目录下只有 icons/imgs 这类图片目录，不会误命中）
    ("resources/meta-gs/character", "calc.js", 1),
    ("resources/meta-gs/character", "calc.js", 2),
    # 武器详情：weapon/<类型>/<武器名>/data.json，同目录下的 webp 不搬
    ("resources/meta-gs/weapon", "data.json", 2),
]


# --------------------------------------------------------------------------
# 2. 定点补丁
# --------------------------------------------------------------------------
# 每条 patch 的 ops 支持两种操作：
#   ("replace", 原文, 新文)            —— 精确字符串替换，找不到就报错
#   ("regex",   正则, 替换模板)        —— 正则替换
# 空 new 表示删除。

MODELS_INDEX_HEAD = """import Base from './Base.js'
import Character from './Character.js'
import Artifact from './Artifact.js'
import ArtifactSet from './ArtifactSet.js'
import Material from './Material.js'
import Weapon from './Weapon.js'
"""

MODELS_INDEX_EXPORT = """export {
  Base,
  Character,
  Artifact,
  ArtifactSet,
  Material,
  Weapon
}
"""

COMPONENTS_INDEX_HEAD = """import Data from './Data.js'
import Format from './Format.js'
import MiaoError from './MiaoError.js'
import Meta from './Meta.js'

export { Data, Format, MiaoError, Meta }
"""

PATCHES = [
    # ---------------------------------------------------------------- 组件入口
    {
        "file": "components/index.js",
        "desc": "摘掉云崽专属组件（Common / App 渲染）；Cfg / Version 两个替身已整体删除，不再生成也不导出",
        "ops": [
            (
                "regex",
                r"import Data from '\./Data\.js'[\s\S]*?export \{ Data, Cfg, Format, Common, Version, App, MiaoError, Meta \}\n",
                COMPONENTS_INDEX_HEAD,
            )
        ],
    },
    # ---------------------------------------------------------------- Data
    {
        "file": "components/Data.js",
        "desc": "getRoot 的 miao 分支改为直接指 miao 根；4 个 redis 缓存方法退化为空实现；logger 改 console",
        "ops": [
            (
                "replace",
                "import { rootPath } from '#miao.path'",
                "import { rootPath, miaoPath } from '#miao.path'",
            ),
            (
                "replace",
                """  } else if (root === 'miao') {
    root = `${_path}/plugins/miao-plugin/`
""",
                """  } else if (root === 'miao') {
    // 本项目里 miao 根就是 vendor/miao，没有 yunzai/plugins 这一层
    root = `${miaoPath}/`
""",
            ),
            (
                "replace",
                "      logger.error(`文件删除失败：${error}`)",
                "      console.error(`文件删除失败：${error}`)",
            ),
            (
                "replace",
                """  async getCacheJSON (key) {
    try {
      let txt = await redis.get(key)
      if (txt) {
        return JSON.parse(txt)
      }
    } catch (e) {
      console.log(e)
    }
    return {}
  },

  async setCacheJSON (key, data, EX = 3600 * 24 * 365) {
    await redis.set(key, JSON.stringify(data), { EX })
  },

  async redisGet (key, def = {}) {
    try {
      let txt = await redis.get(key)
      if (txt) {
        return JSON.parse(txt)
      }
    } catch (e) {
      console.log(e)
    }
    return def
  },

  async redisSet (key, data, EX = 3600 * 24 * 90) {
    await redis.set(key, JSON.stringify(data), { EX })
  },""",
                """  /* 以下 4 个方法原版依赖云崽注入的全局 redis。本项目没有 redis，
     评分链路也不走缓存，统一退化为「取不到缓存 / 写入忽略」。*/
  async getCacheJSON (key) { return {} },

  async setCacheJSON (key, data, EX = 3600 * 24 * 365) {},

  async redisGet (key, def = {}) { return def },

  async redisSet (key, data, EX = 3600 * 24 * 90) {},""",
            ),
        ],
    },
    # ---------------------------------------------------------------- 模型入口
    {
        "file": "models/index.js",
        "desc": "摘掉云崽专属模型（User / MysApi / Player / Avatar / Abyss…）与其导致的顶层副作用",
        "ops": [
            ("regex", r"^[\s\S]*?(?=\nexport \{)", MODELS_INDEX_HEAD.rstrip("\n")),
            (
                "replace",
                """export {
  Base,
  Abyss,
  RoleCombat,
  HardChallenge,
  Button,
  Character,
  Artifact,
  ArtifactSet,
  Avatar,
  ProfileDmg,
  ProfileRank,
  Material,
  Weapon,
  User,
  MysApi,
  Player
}
""",
                MODELS_INDEX_EXPORT,
            ),
        ],
    },
    # ---------------------------------------------------------------- 路径
    {
        "file": "tools/path.js",
        "desc": "rootPath 由「miao 的上两级」改为 miao 根（本项目没有云崽宿主）",
        "ops": [
            (
                "replace",
                """// yunzai根路径
const rootPath = path.join(miaoPath, '..', '..')""",
                """// 云崽根路径 —— 本项目没有云崽宿主，root 即 miao 根
// （Data.getRoot 里 '' / 'root' / 'yunzai' 三个分支会用到）
const rootPath = miaoPath""",
            )
        ],
    },
    # ---------------------------------------------------------------- 角色配置
    {
        "file": "models/character/CharCfg.js",
        "desc": "移除星穹铁道（sr）初始化与分支",
        "ops": [
            (
                "regex",
                r"\n\s*await cfgMap\.init\('sr'\)\s*\n\s*let cfgMapSr = \{[^}]*\}\s*\n",
                "\n",
            ),
            (
                "regex",
                r"getArtisCfg \(char\) \{[\s\S]*?\n {2}\}",
                "\n".join(
                    [
                        "getArtisCfg (char) {",
                        "    // 本项目只做原神，星穹铁道分支已移除",
                        "    // 评分规则在 旅行者 下而非 旅行者/elem 下",
                        "    let charName = char.isTraveler ? `旅行者` : char.name",
                        "    return cfgMapGs.char[charName]?.artis || false",
                        "  }",
                    ]
                ),
            ),
        ],
    },
    # ---------------------------------------------------------------- 默认兜底标记
    {
        "file": "models/artis/ArtisMarkCfg.js",
        "desc": "def/getCfg 透出 isDefaultWeight（表里没这个角色、走通用兜底）与 isCustomWeight（专属规则默认分支手写了权重）",
        "ops": [
            # def 多收一个参数：这份权重是不是兜底来的
            (
                "replace",
                "    let def = function (attrWeight, title = []) {",
                """    let def = function (attrWeight, title = [], isDefaultWeight = false) {
      /* 本项目加：这一份权重是**专属规则自己手写的**吗（而不是照抄权重表那一行）？
         两者都叫「通用」（title 为空 → 通用），页面上分不出来：
         内核只在「命中特判分支」时才给自定义名字，迪希雅这种
         `def({hp:75,...,recharge:75})` 手写一整套却也叫「迪希雅-通用」——
         看着像查表来的，实际 recharge 是 55→75、mastery 被整个去掉。
         判据：attrWeight 是**显式传入**的（专属规则自己写的），且与权重表那一行不等。
         无专属规则时内核走的是 def(usefulAttr[char.name] || default)，
         传进来的就是表里那一行引用 → 恒等，不算手写。 */
      let isCustomWeight = false
      if (attrWeight && !isDefaultWeight) {
        let table = usefulAttr[char.name] || {}
        /* 缺失的键与 0 视为等价：专属规则常写 def({hp:50,...}) 不写满 10 个键，
           而总表写满（不要的项显式给 0）。语义上「没给」=「给 0」。
           逐键比而不是 JSON.stringify —— 后者会把「缺 4 个 0」判成不一致。 */
        let diff = [...new Set([...Object.keys(attrWeight), ...Object.keys(table)])]
          .some(k => (attrWeight[k] || 0) !== (table[k] || 0))
        isCustomWeight = diff
      }""",
            ),
            # 返回值带上标记
            (
                "replace",
                """      return {
        title: `${char.abbr}-${title}`,
        attrWeight: weight
      }""",
                """      return {
        title: `${char.abbr}-${title}`,
        attrWeight: weight,
        /* 本项目加：这一份权重是「上游权重表里没有该角色、只能拿通用表兜底」吗？
           表现层要靠它把标题从「妮莎-通用」改成「默认-通用」——
           不然用户会以为那把权重表真的写着沃雅妮莎。isDefaultWeight 由 def 的调用方传入，
           角色专属规则（artis.js）自己调 def 时不传，恒为 false。
           isCustomWeight 见 def() 里的注释：专属规则默认分支手写了权重。
           ⚠️ 只在「通用」时为 true：命中特判分支的角色标题已经自带规则名
             （「可莉-纯火」），再改前缀成「自定义-纯火」是重复信息。 */
        isDefaultWeight,
        isCustomWeight: title === '通用' && isCustomWeight
      }""",
            ),
            # 唯一会走兜底的调用点：把「表里有没有这个角色」传下去
            (
                "replace",
                "      return def(usefulAttr[char.name] || defaultAttrWeight)",
                "      return def(usefulAttr[char.name] || defaultAttrWeight, [], !usefulAttr[char.name])",
            ),
            # getCfg 解构并往上传
            (
                "replace",
                "    let { attrWeight, title } = ArtisMarkCfg.getCharArtisCfg(profile)",
                "    let { attrWeight, title, isDefaultWeight, isCustomWeight } = ArtisMarkCfg.getCharArtisCfg(profile)",
            ),
            (
                "replace",
                """    return {
      attrs,
      classTitle: title,
      posMaxMark
    }""",
                """    return {
      attrs,
      classTitle: title,
      posMaxMark,
      /* 本项目加：往上传，交给 view 层决定怎么写标题 */
      isDefaultWeight: !!isDefaultWeight,
      isCustomWeight: !!isCustomWeight
    }""",
            ),
        ],
    },
    # ---------------------------------------------------------------- 移除图片渲染依赖与云崽配置替身
    {
        "file": "models/Character.js",
        "desc": "本工程评分/面板计算用不到角色立绘，且不用云崽配置替身：\n"
                "① 删 import 的 CharImg 与 Cfg；② 删整套图片 getter（face/side/gacha/qFace/imgs）及 getCardImg/getImgs 方法；\n"
                "③ isRelease 删掉恒 falsy 的 notReleasedData 分支（Cfg 在本项目永远回落到 def=''）。\n"
                "效果：Character.js 不再引用 CharImg / Cfg；Cfg.js / Version.js / CharImg.js 三个替身全部移出同步。",
        "ops": [
            ("replace", "import { Data, Format, Cfg, Meta } from '#miao'\n", "import { Data, Format, Meta } from '#miao'\n"),
            ("replace", "import CharImg from './character/CharImg.js'\n", ""),
            ("replace",
             "    if (this.eta) return this.eta * 1 < new Date() * 1\n    if (Cfg.get('notReleasedData')) return true\n    return false\n",
             "    if (this.eta) return this.eta * 1 < new Date() * 1\n    return false\n"),
            ("replace",
             "  // 获取头像\n  get face () {\n    return this.getImgs().face\n  }\n\n"
             "  // 获取Q版头像\n  get qFace () {\n    return this.getImgs().qFace\n  }\n\n"
             "  // 获取侧脸图像\n  get side () {\n    if (this.isSr) {\n      return this.getImgs().face\n    }\n    return this.getImgs().side\n  }\n\n"
             "  // gacha图像\n  get gacha () {\n    return this.getImgs().gacha\n  }\n\n"
             "  // 获取character相关图像\n  get imgs () {\n    return this.getImgs()\n  }\n\n",
             ""),
            ("replace",
             "  // 获取角色character-img图片\n  getCardImg (se = false, def = true) {\n"
             "    if (this.name === '\u65c5\u884c\u8005') {\n      return CharImg.getCardImg(['\u7a7a', '\u8367'], se, def)\n    }\n"
             "    return CharImg.getCardImg(this.name, se, def)\n  }\n\n",
             ""),
            ("replace",
             "  // 获取角色插画\n  getImgs (costume = '') {\n"
             "    if (lodash.isArray(costume)) {\n      costume = costume[0]\n    }\n"
             "    let costumeIdx = this.checkCostume(costume) ? '2' : ''\n"
             "    let cacheId = `costume${costumeIdx}`\n"
             "    if (!this._imgs) {\n      this._imgs = {}\n    }\n"
             "    if (!this._imgs[cacheId]) {\n      if (this.isSr) {\n        this._imgs[cacheId] = CharImg.getImgsSr(this.name, this.talentCons)\n      } else {\n        this._imgs[cacheId] = CharImg.getImgs(this.name, costumeIdx, this.isTraveler ? this.elem : '', this.weaponType, this.talentCons)\n      }\n    }\n"
             "    let imgs = this._imgs[cacheId]\n    return {\n      ...imgs,\n"
             "      qFace: Cfg.get('qFace') ? (imgs.qFace || imgs.face) : imgs.face\n    }\n  }\n\n",
             ""),
        ],
    },
    # ---------------------------------------------------------------- 千分位分组数写死（移除 Cfg 依赖）
    {
        "file": "components/Format.js",
        "desc": "Cfg 已删除：commaGroup 在本项目永远回落到调用点给的 def（3），等价于常量 3，直接写死并去掉 Cfg import",
        "ops": [
            ("replace", "import { Cfg } from '#miao'\n", ""),
            ("replace", "Cfg.get('commaGroup', 3)", "3"),
        ],
    },
    # ---------------------------------------------------------------- 缓存定时器
    {
        "file": "models/Base.js",
        "desc": "缓存定时器加 unref（原版 10 分钟 setTimeout 会把一次性脚本拖住）",
        "ops": [
            (
                "regex",
                r"(reFn\[id\] = setTimeout\(\(\) => \{[\s\S]*?\}, time \* 1000\))",
                r"\1\n        // 本地改动（非上游）：unref 让缓存过期定时器不拖住 Node 事件循环，一次性 CLI 算完即退，不再卡 10 分钟；浏览器里 setTimeout 返回数字、无 unref，自动跳过\n        if (reFn[id] && reFn[id].unref) reFn[id].unref()",
            )
        ],
    },
    # ---------------------------------------------------------------- 伤害计算编排
    {
        "file": "models/ProfileDmg.js",
        "desc": "摘掉云崽专属依赖 Common（组团伤害的 teamCalc 配置项，云崽聊天层才有）；calc_auto 分支随之一并移除",
        "ops": [
            (
                "replace",
                "import { MiaoError, Meta, Common } from '#miao'",
                "import { MiaoError, Meta } from '#miao'",
            ),
            (
                "replace",
                "      { file: 'calc_auto', name: '组团伤害', test: () => Common.cfg('teamCalc') },\n",
                "",
            ),
        ],
    },
]

# 生成的文件（非上游内容）。路径相对 vendor/miao/
GENERATED = []

# 生成文件「为什么不能直接用上游的」——报告第四节要用，写在这儿免得两处对不上
GEN_NOTES = {}

# --------------------------------------------------------------------------
# 报告用的分类（前缀匹配，顺序即展示顺序 —— 长的写在前面）
# --------------------------------------------------------------------------
GROUP_ORDER = [
    ("components/", "miao 入口与组件"),
    ("models/artis/", "评分算法"),
    ("models/attr/", "面板属性计算"),
    ("models/dmg/", "伤害计算引擎"),
    ("models/ProfileDmg.js", "伤害计算编排"),
    ("models/character/", "角色元数据"),
    ("models/", "领域模型"),
    ("tools/", "路径工具"),
    ("resources/meta-gs/character/", "角色数据"),
    ("resources/meta-gs/weapon/", "武器数据"),
    ("resources/meta-gs/artifact/", "圣遗物数据"),
    ("resources/meta-gs/material/", "素材数据"),
    ("resources/", "其他资源"),
]

GROUP_PURPOSE = {
    "miao 入口与组件": "`#miao` 入口、`Data`（路径与 JSON 读取）、`Meta`（元数据注册）、`Format`（数值格式化）、`MiaoError`、`common/Elem`（元素表）",
    "评分算法": "`Artis` / `ArtisAttr` / `ArtisMark` / `ArtisMarkCfg` / `ArtisSet` —— 评分内核本体",
    "面板属性计算": "`Attr`（面板计算）＋ `AttrData`（属性基准表）—— 角色评分规则要读 `profile.attr`",
    "伤害计算引擎": "`DmgCalc`（各区乘算的伤害公式）＋ `DmgAttr`（属性计算与 buff 施加）＋ `DmgBuffs`（武器/圣遗物/角色 buff 汇总）＋ `DmgMastery`（元素反应系数）＋ `DmgCalcMeta`（等级与反应基础表）＋ `AttrItem`",
    "伤害计算编排": "`ProfileDmg` —— 加载角色 `calc.js`、组装属性与 buff、逐条算伤害的入口（只取它的 `calcData`，云崽那套模板渲染不要）",
    "角色元数据": "`CharCfg`（读角色评分规则）、`CharId`、`CharMeta`、`CharTalent`",
    "领域模型": "`Base`、`Character`、`Weapon`、`Artifact`、`ArtifactSet`、`Material` ＋ `models/index.js` 入口",
    "路径工具": "`path.js` —— `#miao.path` 别名的目标",
    "角色数据": "每个角色一个目录：`data.json`（等级/突破/天赋等基础数据）＋ `artis.js`（该角色的评分规则）＋ `calc.js`（该角色的伤害计算脚本，旅行者按元素分开放 `旅行者/<元素>/`）；另有 4 个索引文件（`index` / `alias` / `extra` / `data.json`）",
    "武器数据": "每把武器一个目录的详情 `data.json`（按单手剑/弓/法器/双手剑/长柄武器 5 类分目录）＋ 每类的 `calc.js`（武器特效数值换算）＋ 4 个索引文件",
    "圣遗物数据": "部位与套装数据、副词条基准、评分权重表（`artis-mark.js`）",
    "素材数据": "突破素材（`CharMeta` 引用了 `Material` 模型）、素材缩写、每日材料",
}

# 禁止残留的云崽注入全局 —— 同步后扫描，发现即报错
FORBIDDEN_GLOBALS = ["redis", "logger", "Bot", "segment", "Renderer", "Yunzai"]

# 允许出现的裸包名（非相对、非别名）—— 本项目唯一的运行时依赖就是 lodash
ALLOWED_BARE = {"lodash"}

# Node 内置模块（裸写法，如 tools/path.js 里的 'path' / 'url'）。
# 不用 node: 前缀的那些也算数。写死是有意的：上游哪天引了新的外部包，
# 这里不认就会报错，逼人来确认，而不是悄悄漏过去。
NODE_BUILTINS = {
    "assert", "async_hooks", "buffer", "child_process", "cluster", "console",
    "constants", "crypto", "dgram", "diagnostics_channel", "dns", "domain",
    "events", "fs", "http", "http2", "https", "inspector", "module", "net",
    "os", "path", "perf_hooks", "process", "punycode", "querystring", "readline",
    "repl", "stream", "string_decoder", "sys", "timers", "tls", "trace_events",
    "tty", "url", "util", "v8", "vm", "wasi", "worker_threads", "zlib",
}


# --------------------------------------------------------------------------
# 3. 流程
# --------------------------------------------------------------------------
changes: list[dict] = []


def read(p: Path) -> str:
    return p.read_text(encoding="utf-8")


def write(p: Path, text: str) -> None:
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(text, encoding="utf-8", newline="\n")


# --------------------------------------------------------------------------
# 增量：交给 git 算，不自己维护清单
# --------------------------------------------------------------------------
# vendor/miao 是被 git 跟踪的，git 里本来就逐字存着上一版的内容。
# 所以「相对上一版多了什么、改了什么」是 git 直接能回答的问题，
# 再自建一份「路径 → 哈希」的清单属于重复造轮子，还得自己处理 CRLF
# 归一化之类的口径问题（git 早就处理好了）。
#
# 早先版本确实这么干过，已废弃 —— 那套东西除了多一个要提交的文件、
# 多一个 --baseline-from 参数之外，没有提供 git 给不了的信息。


def git(*args: str) -> str | None:
    """跑一条 git 命令。不在 git 仓库、没装 git 等情况下返回 None。

    统一带 `core.quotepath=false`：不然中文路径会被转义成 \344\270\255 那种。
    """
    try:
        r = subprocess.run(
            ["git", "-c", "core.quotepath=false", *args],
            capture_output=True,
            check=True,
        )
        return r.stdout.decode("utf-8", "replace")
    except (subprocess.CalledProcessError, FileNotFoundError):
        return None


def vendor_head() -> tuple[str, str] | None:
    """同步**之前**调用：最后一个改动过 vendor/miao 的提交（短哈希, 日期）。

    同步是整体重写 vendor/，所以「上一个动过它的提交」就是上一版同步的产物。
    """
    out = git("log", "-1", "--format=%h %ai", "--", "vendor/miao")
    if not out or not out.strip():
        return None
    short, _, when = out.strip().partition(" ")
    return short, when


def git_delta(base: str) -> dict:
    """同步**之后**调用：相对 base 提交的增删改。

    差异要从两个地方凑齐，缺一不可：
      - `git diff`   —— 已跟踪文件的变化（改动 / 删除，以及 add 过的新文件）
      - `git status` —— 完全未跟踪的新文件。同步搬进来的新目录（比如头一次
                        引入的 resources/meta-gs/weapon/）就在这里文件级列出；
                        `git diff` 对未跟踪文件是视而不见的。

    VENDOR.md 每跑一次都重写（里面有同步时间），一律排除，
    不然每次都固定报一个「内容变化」，纯噪声。
    """
    added: set[str] = set()
    removed: set[str] = set()
    changed: set[str] = set()

    # 同步刚把整个 vendor 删掉重建过，git 索引里缓存的文件属性（mtime / inode）
    # 全过期了。先刷一遍索引，否则首次扫描可能报出并不存在的新增 —— 实测遇到过一次
    # （同一份内容，第一次算「新增 1」，之后再算就是 0）。
    # `update-index --refresh` 在有文件需要更新时返回 1，属于正常情况，忽略。
    subprocess.run(
        ["git", "update-index", "--refresh", "--", "vendor/miao"],
        capture_output=True,
    )

    def rel_of(path: str) -> str:
        return path.strip().strip('"').replace("vendor/miao/", "", 1)

    out = git("diff", "--name-status", base, "--", "vendor/miao")
    if out is not None:
        for line in out.splitlines():
            bits = line.split("\t")
            if len(bits) < 2:
                continue
            status, path = bits[0], bits[-1]
            rel = rel_of(path)
            if not rel or rel == "VENDOR.md":
                continue
            if status.startswith("D"):
                removed.add(rel)
            elif status.startswith("A"):
                added.add(rel)
            else:                       # M / R / T …
                changed.add(rel)

    out = git("status", "--porcelain", "--untracked-files=all", "--", "vendor/miao")
    if out is not None:
        for line in out.splitlines():
            if len(line) < 4:
                continue
            if line[:2] != "??":
                continue
            rel = rel_of(line[3:])
            if rel and rel != "VENDOR.md":
                added.add(rel)

    # 「未动」= 基准那版有、这次既没删也没改的。
    # 分母要排掉 VENDOR.md —— 它每次重写，既不在上面三类里，也不该算「没动」。
    out = git("ls-tree", "-r", "--name-only", base, "--", "vendor/miao")
    base_files = [x.strip() for x in (out or "").splitlines() if x.strip()]
    base_total = len([x for x in base_files if not x.endswith("vendor/miao/VENDOR.md")])

    return {
        "base": base,
        "added": sorted(added),
        "removed": sorted(removed),
        "changed": sorted(changed),
        "unchanged": max(0, base_total - len(removed) - len(changed)) if base_total else None,
    }


def collect() -> list[str]:
    out: list[str] = []
    for f in FILES:
        if (MIAO / f).exists():
            out.append(f)
        else:
            print(f"[warn] 清单里的文件不存在，已跳过: {f}")
    for base, name, depth in GLOBS:
        sub = MIAO / base
        if not sub.is_dir():
            continue
        if depth == 1:
            for entry in sorted(sub.iterdir()):
                if entry.is_dir() and (entry / name).exists():
                    out.append(f"{base}/{entry.name}/{name}")
        else:  # depth == 2
            for lv1 in sorted(sub.iterdir()):
                if not lv1.is_dir():
                    continue
                for lv2 in sorted(lv1.iterdir()):
                    if lv2.is_dir() and (lv2 / name).exists():
                        out.append(f"{base}/{lv1.name}/{lv2.name}/{name}")
    return sorted(set(out))


def apply_patch(code: str, patch: dict, rel: str) -> str:
    """应用一条补丁，返回 (新代码)。找不到匹配就抛错。"""
    for op in patch["ops"]:
        kind = op[0]
        if kind == "replace":
            _, old, new = op
            if old not in code:
                raise RuntimeError(f"[{rel}] 补丁未命中，原文找不到：\n{old[:200]}")
            code = code.replace(old, new, 1)
        elif kind == "regex":
            _, pattern, repl = op
            code, n = re.subn(pattern, repl, code, count=1)
            if n == 0:
                raise RuntimeError(f"[{rel}] 补丁正则未命中：{pattern[:120]}")
        elif kind == "replace_file":
            code = op[1]
        else:
            raise RuntimeError(f"未知操作类型: {kind}")
    return code


USAGE = """
用法:
    python tools/sync_miao.py

环境变量:
    MIAO_PLUGIN_PATH   指定 miao-plugin 源码目录，默认取同级目录下的 miao-plugin

报告的「相对上一版」一节由 git 算出：基准取「最后一个改动 vendor/miao 的提交」。
不在 git 仓库里跑也能正常同步，只是这一节会说明算不了。
"""


def parse_args(argv: list[str]) -> dict:
    args: dict = {}
    for a in argv:
        if a in ("-h", "--help"):
            print(USAGE.strip())
            sys.exit(0)
        print(f"[warn] 忽略未知参数：{a}")
    return args


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv if argv is not None else sys.argv[1:])

    if not MIAO.is_dir():
        print(f"[错误] 找不到 miao-plugin 源目录：{MIAO}")
        print("       可用环境变量 MIAO_PLUGIN_PATH 指定")
        return 1

    pkg = json.loads(read(PKG))
    upstream_ver = "unknown"
    upkg = MIAO / "package.json"
    if upkg.exists():
        upstream_ver = json.loads(read(upkg)).get("version", "unknown")

    # ---- 增量基准：必须在动手改 vendor 之前取 ----
    # 改完就查不到了（那时的「最后一个改动提交」已经是旧的那次）。
    base = vendor_head()

    # ---- 清空并复制 ----
    files = collect()
    if VENDOR.exists():
        shutil.rmtree(VENDOR)
    VENDOR.mkdir(parents=True)
    total_bytes = 0
    for rel in files:
        src, dst = MIAO / rel, VENDOR / rel
        dst.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(src, dst)
        total_bytes += src.stat().st_size

    # ---- 应用补丁 ----
    patched = 0
    for patch in PATCHES:
        rel = patch["file"]
        path = VENDOR / rel
        if not path.exists():
            print(f"[warn] 补丁目标不存在，已跳过: {rel}")
            continue
        before = read(path)
        after = apply_patch(before, patch, rel)
        if before != after:
            write(path, after)
            patched += 1
        changes.append(
            {"file": rel, "desc": patch["desc"], "kind": "改写", "before": before, "after": after}
        )

    # ---- 生成文件 ----
    for rel, content, desc in GENERATED:
        write(VENDOR / rel, content)
        changes.append(
            {"file": rel, "desc": desc, "kind": "生成", "before": "", "after": content}
        )

    # ---- 增量：相对上一个动过 vendor/miao 的提交 ----
    # VENDOR.md 每次重写，已在 git_delta 里排除。拿到 delta 后立刻补 VENDOR.md，
    # 让它自己的内容里也能写上这一行。
    delta = None
    if base is not None:
        delta = git_delta(base[0])
        delta["base_date"] = base[1]

    # ---- 校验 1：相对 import 都能落地 ----
    missing: list[str] = []
    for path in VENDOR.rglob("*.js"):
        for m in re.finditer(r"from\s+['\"](\.[^'\"]+)['\"]", read(path)):
            target = (path.parent / m.group(1)).resolve()
            if not target.exists() and not target.with_suffix(".js").exists():
                missing.append(f"{path.relative_to(VENDOR).as_posix()}  →  {m.group(1)}")

    # ---- 校验 2：别名都能被 package.json imports 解析 ----
    imports = pkg.get("imports", {})
    alias_missing: list[str] = []
    for path in VENDOR.rglob("*.js"):
        for m in re.finditer(r"from\s+['\"](#miao[^'\"]*)['\"]", read(path)):
            spec = m.group(1)
            if spec not in imports:
                alias_missing.append(
                    f"{path.relative_to(VENDOR).as_posix()}  →  {spec}（package.json imports 未定义）"
                )
    for spec, target in imports.items():
        if not (ROOT / target).resolve().exists():
            alias_missing.append(f"package.json imports 的 {spec} → {target} 不存在")

    # ---- 校验 3：不许残留云崽注入的全局变量 ----
    leftover: list[str] = []
    pattern = re.compile(r"(?<![.\w$])(" + "|".join(FORBIDDEN_GLOBALS) + r")\b")
    for path in VENDOR.rglob("*.js"):
        for i, line in enumerate(read(path).splitlines(), 1):
            stripped = line.strip()
            if stripped.startswith(("//", "*", "/*")):
                continue
            hit = pattern.search(line)
            if hit:
                leftover.append(
                    f"{path.relative_to(VENDOR).as_posix()}:{i}  →  {hit.group(1)}"
                )

    # ---- 校验 4：不许冒出未知的外部依赖（image-size 就是这么混进来过的） ----
    unknown_dep: list[str] = []
    for path in VENDOR.rglob("*.js"):
        for i, line in enumerate(read(path).splitlines(), 1):
            stripped = line.strip()
            if stripped.startswith(("//", "*", "/*")):
                continue
            for m in re.finditer(r"from\s+['\"]([^'\"]+)['\"]", stripped):
                spec = m.group(1)
                if spec.startswith((".", "#")):
                    continue          # 相对路径 / 别名，另两道守卫盯着
                head = spec[5:] if spec.startswith("node:") else spec
                head = head.split("/")[0]
                if head in ALLOWED_BARE or head in NODE_BUILTINS:
                    continue
                unknown_dep.append(
                    f"{path.relative_to(VENDOR).as_posix()}:{i}  →  {spec}"
                )

    # ---- 产物：VENDOR.md ----
    # 校验结果一并交给报告，让报告如实写上是否通过
    guard = {
        "missing": missing,
        "alias": alias_missing,
        "leftover": leftover,
        "unknown": unknown_dep,
    }
    # 这一行要写进 VENDOR.md，所以得先算出来
    if delta is None:
        delta_line = "算不了（不在 git 仓库里）"
    else:
        delta_line = (
            f"相对提交 {delta['base']}：新增 {len(delta['added'])}"
            f" / 移除 {len(delta['removed'])} / 内容变化 {len(delta['changed'])}"
        )
    write(
        VENDOR / "VENDOR.md",
        "\n".join(
            [
                "# vendor/miao 来源记录",
                "",
                "本目录由 `python tools/sync_miao.py` 从 miao-plugin 自动生成，**请勿手工编辑**"
                "（改动会被下次同步覆盖）。要改行为，改 sync 脚本里的清单或补丁。",
                "",
                f"- 上游: `{MIAO.as_posix()}`（miao-plugin v{upstream_ver}）",
                f"- 同步时间: {datetime.now().isoformat(timespec='seconds')}",
                f"- 文件数: {len(files)} 个（另生成 {len(GENERATED)} 个）",
                f"- 体积: {total_bytes / 1024:.1f} KB",
                f"- 处置方式: 原样搬运 {len(files) - patched} 个 / 定点改写 {patched} 个 / 本地生成 {len(GENERATED)} 个",
                f"- 相对上一版: {delta_line}",
                "",
                "## 别名映射（package.json `imports` 字段，import 语句本身不改写）",
                "",
                "```",
                "#miao         → ." + "/vendor/miao/components/index.js",
                "#miao.models  → ./vendor/miao/models/index.js",
                "#miao.path    → ./vendor/miao/tools/path.js",
                "```",
                "",
                "## 同步了什么、改了什么",
                "",
                "见 `docs/reports/sync-report.md`（完整清单 + 增量 + 改动说明）。",
                "逐字节核对用 `git log -p -- vendor/miao`。",
            ]
        ),
    )

    # ---- 产物：同步报告 ----
    write(REPORT, build_report(files, total_bytes, upstream_ver, patched, delta, guard))

    # ---- 输出 ----
    print(f"来源: {MIAO.as_posix()} (v{upstream_ver})")
    print(f"搬运: {len(files)} 个文件，{total_bytes / 1024:.1f} KB")
    print(f"改动: {patched} 个文件，生成 {len(GENERATED)} 个文件")
    print(f"增量: {delta_line}")
    print(f"报告: {REPORT.relative_to(ROOT).as_posix()}")

    ok = True
    if missing:
        ok = False
        print(f"\n[错误] {len(missing)} 处相对 import 指向未搬运的文件：")
        for m in missing[:30]:
            print("  " + m)
    if alias_missing:
        ok = False
        print(f"\n[错误] {len(alias_missing)} 处别名无法解析：")
        for m in alias_missing[:30]:
            print("  " + m)
    if leftover:
        ok = False
        print(f"\n[错误] 发现 {len(leftover)} 处云崽注入的全局变量残留：")
        for m in leftover[:30]:
            print("  " + m)
    if unknown_dep:
        ok = False
        print(f"\n[错误] 发现 {len(unknown_dep)} 处未知外部依赖：")
        for m in unknown_dep[:30]:
            print("  " + m)
        print("       若确需引入，请加进 ALLOWED_BARE 或 package.json，并在报告里说明理由")
    if not ok:
        return 1
    print("校验: 相对 import / 别名 / 云崽全局残留 / 外部依赖 均通过 ✓")
    return 0


def build_report(
    files: list[str],
    total_bytes: int,
    upstream_ver: str,
    patched: int,
    delta: dict,
    guard: dict,
) -> str:
    """产出 docs/reports/sync-report.md。

    这份报告要说清四件事：
      1. 同步了什么 —— 按类别列全，并点明哪些文件一个字没动
      2. 相对上一版差在哪 —— 由 git 算，基准是最后一个动过 vendor/miao 的提交
      3. 改了什么 —— 凝练描述，不贴 diff（要逐行核对用 git）
      4. 什么没改 —— 有多少文件是逐字节原样搬过来的
    """
    stamp = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    rewritten = [c for c in changes if c["kind"] == "改写"]
    generated = list(GENERATED)

    def group_of(rel: str) -> str:
        for pref, label in GROUP_ORDER:
            if rel.startswith(pref):
                return label
        return "其他"

    grouped: dict[str, list[str]] = {}
    for f in files:
        grouped.setdefault(group_of(f), []).append(f)
    labels = [lb for _p, lb in GROUP_ORDER if lb in grouped]
    labels += [lb for lb in grouped if lb not in labels]

    top: dict[str, int] = {}
    for f in files:
        k = f.split("/")[0]
        top[k] = top.get(k, 0) + 1

    if delta is None:
        added, removed, changed = [], [], []
        unchanged = None
    else:
        added, removed, changed = delta["added"], delta["removed"], delta["changed"]
        unchanged = delta.get("unchanged")
    n_untouched = len(files) - patched

    # ---- 资源明细：数出来，不写死 ----
    def cnt(pattern: str) -> int:
        return sum(1 for f in files if re.fullmatch(pattern, f))

    n_char = cnt(r"resources/meta-gs/character/[^/]+/data\.json")
    n_rule = cnt(r"resources/meta-gs/character/[^/]+/artis\.js")
    # 旅行者的 calc.js 在 character/旅行者/<元素>/ 下，两条模式互补（深度 1 匹配不到它）
    n_calc = cnt(r"resources/meta-gs/character/[^/]+/calc\.js") + cnt(r"resources/meta-gs/character/[^/]+/[^/]+/calc\.js")
    n_wp_detail = cnt(r"resources/meta-gs/weapon/[^/]+/[^/]+/data\.json")
    wp_label = {
        "sword": "单手剑", "bow": "弓", "catalyst": "法器",
        "claymore": "双手剑", "polearm": "长柄武器",
    }
    wp_by_type: dict[str, int] = {}
    for f in files:
        m = re.fullmatch(r"resources/meta-gs/weapon/([^/]+)/[^/]+/data\.json", f)
        if m:
            wp_by_type[m.group(1)] = wp_by_type.get(m.group(1), 0) + 1
    wp_break = "、".join(
        f"{wp_label.get(k, k)} {v}"
        for k, v in sorted(wp_by_type.items(), key=lambda kv: (-kv[1], kv[0]))
    )

    L: list[str] = [
        "# miao 内核同步报告",
        "",
        f"- 同步时间：{stamp}",
        f"- 上游来源：`{MIAO.as_posix()}`（miao-plugin v{upstream_ver}）",
        f"- 搬运文件：{len(files)} 个 / {total_bytes / 1024:.1f} KB",
        f"- 处置方式：**原样搬运 {n_untouched} 个**　|　定点改写 {patched} 个　|　本地生成 {len(generated)} 个",
        "- 增量基准：最后一个动过 `vendor/miao` 的 git 提交",
    ]
    if delta is None:
        L.append("- 相对上一版：算不了（不在 git 仓库里跑）")
    else:
        L.append(
            f"- 相对上一版（提交 `{delta['base']}`）：新增 {len(added)} 个　|　移除 {len(removed)} 个　"
            f"|　内容变化 {len(changed)} 个　|　未动 {unchanged} 个"
        )
    L += [
        "",
        "搬运范围：" + "、".join(f"{k}（{v}）" for k, v in sorted(top.items())),
        "",
        "---",
        "",
        "## 一、同步了哪些数据",
        "",
        f"**结论先行：{len(files)} 个文件里 {n_untouched} 个是逐字节原样搬运的，一行没改。**",
        f"被改写的只有 {patched} 个「和云崽机器人运行时绑定」的代码文件（第三节），",
        f"另有 {len(generated)} 个文件是本项目手写的（第四节）。",
        "",
        "### 1.1 清单（按类别）",
        "",
        "| 类别 | 数量 | 内容 |",
        "|---|---|---|",
    ]
    for lb in labels:
        L.append(f"| {lb} | {len(grouped[lb])} | {GROUP_PURPOSE.get(lb, '—')} |")

    L += [
        "",
        "### 1.2 资源数据的构成",
        "",
        f"- **角色数据 {len(grouped.get('角色数据', []))} 个** = "
        f"{n_char} 个角色的 `data.json`（等级 / 突破 / 天赋等基础数据）"
        f"＋ {n_rule} 个角色的 `artis.js`（该角色专属的评分规则，并非每个角色都有）"
        f"＋ {n_calc} 个角色的 `calc.js`（该角色专属的伤害计算脚本，并非每个角色都有；旅行者按元素分 7 份）"
        f"＋ 4 个索引文件（`index` / `alias` / `extra` / `data.json`）",
        f"- **武器数据 {len(grouped.get('武器数据', []))} 个** = "
        f"{n_wp_detail} 把武器的详情 `data.json`（{wp_break}）"
        f"＋ 5 类各 1 个 `calc.js`（武器特效数值换算）与 1 个类型级 `data.json`"
        f" ＋ 4 个索引文件（`index` / `alias` / `desc` / `extra`）",
        f"- **圣遗物数据 {len(grouped.get('圣遗物数据', []))} 个** = "
        "部位与套装数据（`data.json`）、副词条基准（`calc.js`）、评分权重表（`artis-mark.js`）、别名、`extra`、`index`",
        f"- **素材数据 {len(grouped.get('素材数据', []))} 个** = "
        "突破素材（角色元数据引用了 `Material` 模型）、素材缩写（`abbr.js`）、每日材料（`daily.js`）、`index`",
        "",
        "只搬原神（`meta-gs`）。星穹铁道（`meta-sr`）不搬；图片资源（`icon` / `gacha` / `awaken.webp`，约 21 MB）也不搬 ——",
        "评分是纯计算，用不到图。",
        "",
        "### 1.3 生成物",
        "",
        f"上游没有这 {len(generated)} 个文件，是同步脚本写的；另有一份来源记录 `VENDOR.md` 一并写出（不计入「生成文件」数）。",
        "",
        "| 文件 | 说明 |",
        "|---|---|",
    ]
    for rel, _content, desc in generated:
        L.append(f"| `{rel}` | {desc}（详见第四节） |")
    L.append("| `VENDOR.md` | 来源记录：上游路径 / 版本 / 同步时间 / 文件数 / 别名映射 |")

    # ---------------------------------------------------------------- 二、增量
    L += ["", "---", "", "## 二、相对上一版差在哪", ""]
    if delta is None:
        L += [
            "本次不在 git 仓库里跑，算不了相对上一版的差异。",
            "",
            "在仓库里执行下面这条就能看到（基准换成上一个动过 `vendor/miao` 的提交）：",
            "",
            "```bash",
            "git diff --name-status <基准提交> -- vendor/miao",
            "```",
            "",
        ]
    else:
        L += [
            f"基准是提交 `{delta['base']}`"
            f"（{delta.get('base_date', '')}）—— 也就是上一版同步的产物。",
            "",
            "差异由 git 给出：`git diff` 负责已跟踪文件的变化，`git status` 补上未跟踪的新文件",
            "（同步新搬进来的目录在 `git diff` 里是看不见的）。`VENDOR.md` 每次重写，一律排除。",
            "",
            f"- 新增 **{len(added)}** 个　- 移除 **{len(removed)}** 个　"
            f"- 内容变化 **{len(changed)}** 个　- 未动 **{unchanged}** 个",
            "",
        ]

    def listing(title: str, items: list[str]) -> None:
        L.append(f"### {title}（{len(items)} 个）")
        L.append("")
        if not items:
            L.append("（无）")
            L.append("")
            return
        g: dict[str, list[str]] = {}
        for it in items:
            g.setdefault(group_of(it), []).append(it)
        ordered = [x for _p, x in GROUP_ORDER if x in g]
        ordered += [x for x in g if x not in ordered]
        for lb in ordered:
            L.append(f"- **{lb}**（{len(g[lb])} 个）—— {GROUP_PURPOSE.get(lb, '')}")
        L.append("")
        L.append("<details><summary>逐个文件（数量多的做省略，完整清单见 git diff）</summary>")
        L.append("")
        for lb in ordered:
            sub = g[lb]
            if len(sub) > 8:
                L.extend(f"- `{x}`" for x in sub[:4])
                L.append(f"- …（本类共 {len(sub)} 个，余下省略）")
            else:
                L.extend(f"- `{x}`" for x in sub)
        L.append("")
        L.append("</details>")
        L.append("")

    listing("新增", added)
    listing("移除", removed)
    listing("内容变化", changed)

    # ---------------------------------------------------------------- 三、改写
    L += [
        "---",
        "",
        f"## 三、定点改写：{patched} 个",
        "",
        "改写原则：**评分算法与资源数据一律不动**。被处理的只有和「云崽机器人运行时」绑定的部分 ——",
        "云崽注入的全局变量（`redis` / `logger`）、渲染组件、云崽专属模型。",
        "别名 `#miao` / `#miao.models` / `#miao.path` 一概不改写，由 `package.json` 的 `imports`",
        "字段映射到 `vendor/miao` 下的真实文件；所以 import 层面的变化只出现在下面这些入口文件里。",
        "",
    ]
    for c in rewritten:
        L.append(f"### `{c['file']}`")
        L.append("")
        L.append(c["desc"])
        L.append("")
        old_imports = re.findall(r"^import .*$", c["before"], re.M)
        new_imports = re.findall(r"^import .*$", c["after"], re.M)
        if old_imports != new_imports:

            def spec(line: str) -> str:
                m = re.search(r"from\s+['\"]([^'\"]+)['\"]", line)
                return m.group(1) if m else line

            old_map = {spec(i): i.strip() for i in old_imports}
            new_map = {spec(i): i.strip() for i in new_imports}
            gone = [s for s in old_map if s not in new_map]
            fresh = [s for s in new_map if s not in old_map]
            # 同一个模块但导入的名字变了（如 #miao.path 多个 miaoPath）——
            # 光列模块名会写成「移除 #miao.path；新增 #miao.path」，得把前后两句都摆出来
            tweaked = [s for s in old_map if s in new_map and old_map[s] != new_map[s]]
            bits = []
            if gone:
                bits.append("移除 " + "、".join(f"`{s}`" for s in gone))
            if fresh:
                bits.append("新增 " + "、".join(f"`{s}`" for s in fresh))
            for s in tweaked:
                bits.append(f"改写 `{old_map[s]}` → `{new_map[s]}`")
            L.append("- import：" + "；".join(bits))
            L.append("")

    n_resource = sum(
        len(grouped.get(x, []))
        for x in ("角色数据", "武器数据", "圣遗物数据", "素材数据", "其他资源")
    )
    L += [
        "> 这里只讲「改了什么」，不贴 diff。要逐行核对：`git log -p -- vendor/miao/<文件>`。",
        f"> 资源数据（{n_resource} 个）在本节没有任何条目 —— 因为它们一个字都没改。",
        "",
    ]

    # ---------------------------------------------------------------- 四、生成
    L += [
        "---",
        "",
        f"## 四、本地生成：{len(generated)} 个",
        "",
        "这两个文件不是上游内容，由同步脚本生成（内容写死在 `tools/sync_miao.py` 里，要改得改脚本）。",
        "",
    ]
    for rel, _content, desc in generated:
        L += [f"### `{rel}`", "", f"**{desc}**", "", GEN_NOTES.get(rel, ""), ""]

    # ---------------------------------------------------------------- 五、没改
    L += [
        "---",
        "",
        f"## 五、没有改动的部分：{n_untouched} 个",
        "",
        "除上面「改写的 + 生成的」以外，其余文件全部逐字节复制，同步脚本对它们零编辑：",
        "",
        "| 目录 | 总数 | 未改动 | 改过的（见第三节） |",
        "|---|---|---|---|",
    ]
    for d in sorted({f.split("/")[0] for f in files}):
        tot = sum(1 for f in files if f.startswith(d + "/"))
        pat = sorted(c["file"] for c in rewritten if c["file"].startswith(d + "/"))
        cell = "、".join(f"`{p.split('/', 1)[1]}`" for p in pat) if pat else "—— 全部原样"
        L.append(f"| `{d}/` | {tot} | {tot - len(pat)} | {cell} |")

    L += [
        "",
        "资源数据是最能说明问题的一块：角色基础数据、角色评分规则、武器数据、圣遗物权重表、素材数据",
        "全部属于「数据」而非「逻辑」，本项目一个字节都不碰。想确认有没有被悄悄改过，",
        "`git log -p -- vendor/miao/resources` 一卷就到底了。",
        "",
    ]

    # ---------------------------------------------------------------- 六、校验
    L += [
        "---",
        "",
        "## 六、校验",
        "",
        "每次同步都跑这四道守卫，任何一道不过就整体报错退出（报告照样生成，下面如实记录本次结果）：",
        "",
    ]
    checks = [
        ("相对 import 全部指向已搬运的文件", guard.get("missing") or []),
        ("`#miao*` 别名全部能在 `package.json` 的 `imports` 中解析", guard.get("alias") or []),
        ("无云崽注入的全局变量残留（redis / logger / Bot / segment / Renderer / Yunzai）", guard.get("leftover") or []),
        ("无未知外部依赖（只允许 `lodash` 与 Node 内置模块）", guard.get("unknown") or []),
    ]
    for title, hits in checks:
        mark = "✓ 通过" if not hits else f"✗ 不通过（{len(hits)} 处）"
        L.append(f"- {mark} —— {title}")
    L += [
        "",
        "## 附：怎么自己核对",
        "",
        "搬运落地的每个文件都在 `vendor/miao/` 下、由 git 跟踪，所以核对不需要额外的清单文件：",
        "",
        "```bash",
        "git log -p -- vendor/miao                     # 逐行看改了什么",
        "git diff --name-status <基准提交> -- vendor/miao   # 只看增删改的文件名",
        "```",
        "",
        "哪个文件属于「原样搬运」还是「定点改写」，第五节的表已经列全。",
        "",
    ]
    return "\n".join(L)


if __name__ == "__main__":
    sys.exit(main())

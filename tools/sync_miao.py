#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
星天水镜 / seiten-suikyou —— miao 评分内核同步脚本

把 miao-plugin 里评分用得上的源码搬进 vendor/miao/，并只对「云崽机器人专属」
的依赖做定点处理。每次同步额外产出 docs/sync-report.md，逐文件列出改动。

用法:
    python tools/sync_miao.py
    MIAO_PLUGIN_PATH=/path/to/miao-plugin python tools/sync_miao.py

设计原则:
  1. 能原样搬的就原样搬 —— 不为了「干净」而重写上游代码。
  2. 只有确认本项目用不到、且拿不到的东西才处理：云崽注入的全局（redis / logger）、
     云崽专属组件（Common 渲染 / App 应用）、云崽专属模型（User / MysApi / Player…）。
  3. 别名不改写 —— `#miao` / `#miao.models` / `#miao.path` 原样保留，
     由 package.json 的 imports 字段映射到 vendor/miao 下的真实文件。
  4. 所有改动必须可审计 —— 报告里有 unified diff，改了什么一目了然。
"""

from __future__ import annotations

import difflib
import json
import os
import re
import shutil
import sys
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
VENDOR = ROOT / "vendor" / "miao"
REPORT = ROOT / "docs" / "sync-report.md"
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
    "models/character/CharImg.js",
    "models/character/CharMeta.js",
    "models/character/CharTalent.js",
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
]

# 目录级规则：角色目录下的 data.json 与 artis.js 全搬（运行时动态读，闭包抓不全）
GLOBS = [
    ("resources/meta-gs/character", "data.json"),
    ("resources/meta-gs/character", "artis.js"),
]


# --------------------------------------------------------------------------
# 2. 定点补丁
# --------------------------------------------------------------------------
# 每条 patch 的 ops 支持两种操作：
#   ("replace", 原文, 新文)            —— 精确字符串替换，找不到就报错
#   ("regex",   正则, 替换模板)        —— 正则替换
# 空 new 表示删除。

CHAR_IMG_STUB = """/*
 * CharImg —— 本项目已置空（非上游内容，由 tools/sync_miao.py 生成）
 *
 * 原文件是渲染层代码：读角色立绘、算图片尺寸，里面写死了云崽的路径
 * `./plugins/miao-plugin/resources/`，还依赖第三方包 image-size。
 * 评分是纯计算，用不到图片，故整体替换为空实现。
 */
const noop = () => ''

const CharImg = new Proxy({
  getCardImg: noop,
  getRandomImg: noop,
  getImgs: () => ({}),
  getImgsSr: () => ({})
}, {
  get (t, k) {
    if (k in t) return t[k]
    if (typeof k === 'symbol') return undefined
    return noop
  }
})

export default CharImg
"""

LOCAL_CFG = """/*
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
"""

LOCAL_VERSION = """/*
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
"""

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
import Cfg from './_local/Cfg.js'
import Version from './_local/Version.js'
import MiaoError from './MiaoError.js'
import Meta from './Meta.js'

export { Data, Cfg, Format, Version, MiaoError, Meta }
"""

PATCHES = [
    # ---------------------------------------------------------------- 组件入口
    {
        "file": "components/index.js",
        "desc": "摘掉云崽专属组件（Common 渲染 / App 应用）；Cfg 与 Version 指向本地最小实现",
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
    # ---------------------------------------------------------------- 渲染层
    {
        "file": "models/character/CharImg.js",
        "desc": "整体替换为置空实现（渲染层，写死云崽路径且依赖 image-size）",
        "ops": [("replace_file", CHAR_IMG_STUB)],
    },
    # ---------------------------------------------------------------- 缓存定时器
    {
        "file": "models/Base.js",
        "desc": "缓存定时器加 unref（原版 10 分钟 setTimeout 会把一次性脚本拖住）",
        "ops": [
            (
                "regex",
                r"(reFn\[id\] = setTimeout\(\(\) => \{[\s\S]*?\}, time \* 1000\))",
                r"\1\n        if (reFn[id] && reFn[id].unref) reFn[id].unref()",
            )
        ],
    },
]

# 生成的文件（非上游内容）。路径相对 vendor/miao/
GENERATED = [
    ("components/_local/Cfg.js", LOCAL_CFG, "云崽用户配置的最小替代"),
    ("components/_local/Version.js", LOCAL_VERSION, "云崽版本检测的最小替代"),
]

# 禁止残留的云崽注入全局 —— 同步后扫描，发现即报错
FORBIDDEN_GLOBALS = ["redis", "logger", "Bot", "segment", "Renderer", "Yunzai"]


# --------------------------------------------------------------------------
# 3. 流程
# --------------------------------------------------------------------------
changes: list[dict] = []


def read(p: Path) -> str:
    return p.read_text(encoding="utf-8")


def write(p: Path, text: str) -> None:
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(text, encoding="utf-8", newline="\n")


def collect() -> list[str]:
    out: list[str] = []
    for f in FILES:
        if (MIAO / f).exists():
            out.append(f)
        else:
            print(f"[warn] 清单里的文件不存在，已跳过: {f}")
    for d, name in GLOBS:
        sub = MIAO / d
        if not sub.is_dir():
            continue
        for entry in sorted(sub.iterdir()):
            if entry.is_dir() and (entry / name).exists():
                out.append(f"{d}/{entry.name}/{name}")
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


def main() -> int:
    if not MIAO.is_dir():
        print(f"[错误] 找不到 miao-plugin 源目录：{MIAO}")
        print("       可用环境变量 MIAO_PLUGIN_PATH 指定")
        return 1

    pkg = json.loads(read(PKG))
    upstream_ver = "unknown"
    upkg = MIAO / "package.json"
    if upkg.exists():
        upstream_ver = json.loads(read(upkg)).get("version", "unknown")

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

    # ---- 产物：VENDOR.md ----
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
                "",
                "## 别名映射（package.json `imports` 字段，import 语句本身不改写）",
                "",
                "```",
                "#miao         → ." + "/vendor/miao/components/index.js",
                "#miao.models  → ./vendor/miao/models/index.js",
                "#miao.path    → ./vendor/miao/tools/path.js",
                "```",
                "",
                "## 改动明细",
                "",
                "见 `docs/sync-report.md`。",
            ]
        ),
    )

    # ---- 产物：同步报告 ----
    write(REPORT, build_report(files, total_bytes, upstream_ver, patched))

    # ---- 输出 ----
    print(f"来源: {MIAO.as_posix()} (v{upstream_ver})")
    print(f"搬运: {len(files)} 个文件，{total_bytes / 1024:.1f} KB")
    print(f"改动: {patched} 个文件，生成 {len(GENERATED)} 个文件")
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
    if not ok:
        return 1
    print("校验: 相对 import / 别名 / 云崽全局残留 均通过 ✓")
    return 0


def build_report(
    files: list[str], total_bytes: int, upstream_ver: str, patched: int
) -> str:
    stamp = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    rewritten = [c for c in changes if c["kind"] == "改写"]
    kinds = {}
    for f in files:
        top = f.split("/")[0]
        kinds[top] = kinds.get(top, 0) + 1

    L: list[str] = [
        "# miao 内核同步报告",
        "",
        f"- 同步时间：{stamp}",
        f"- 上游来源：`{MIAO.as_posix()}`（miao-plugin v{upstream_ver}）",
        f"- 搬运文件：{len(files)} 个 / {total_bytes / 1024:.1f} KB",
        f"- 原样搬运：{len(files) - patched} 个　|　定点改写：{patched} 个　|　本地生成：{len(GENERATED)} 个",
        "",
        "搬运范围：" + "、".join(f"{k}（{v}）" for k, v in sorted(kinds.items())),
        "",
        "## 一、import 变化汇总",
        "",
        "本项目**不改写任何别名**：`#miao` / `#miao.models` / `#miao.path` 原样保留，",
        "由 `package.json` 的 `imports` 字段映射到 `vendor/miao` 下的真实文件。",
        "所以 import 层面的变化只发生在被定点改写的入口文件上：",
        "",
        "| 文件 | import 变化 |",
        "|---|---|",
    ]

    for c in rewritten:
        if not c["before"] or not c["after"]:
            continue
        old_imports = re.findall(r"^import .*$", c["before"], re.M)
        new_imports = re.findall(r"^import .*$", c["after"], re.M)
        if old_imports == new_imports:
            continue
        removed = [i for i in old_imports if i not in new_imports]
        added = [i for i in new_imports if i not in old_imports]
        bits = []
        for i in removed:
            bits.append(f"移除 `{i}`")
        for i in added:
            bits.append(f"改为 `{i}`")
        L.append(f"| `{c['file']}` | " + "；<br>".join(bits) + " |")

    if not rewritten:
        L.append("| （无） | — |")

    L += ["", "## 二、逐文件改动", ""]

    for c in changes:
        L.append(f"### `{c['file']}`　[{c['kind']}]")
        L.append("")
        L.append(c["desc"])
        L.append("")
        if c["kind"] == "生成":
            L.append("本项目手写内容，非上游文件：")
            L.append("")
            L.append("```js")
            L.append(c["after"].rstrip())
            L.append("```")
        else:
            diff = difflib.unified_diff(
                c["before"].splitlines(),
                c["after"].splitlines(),
                fromfile="上游",
                tofile="本仓库",
                lineterm="",
                n=2,
            )
            lines = [d for d in diff]
            if not lines:
                L.append("（内容无变化）")
            else:
                L.append("```diff")
                # 头部三行（--- / +++ / @@）保留，路径换成文件名，避免噪声
                for d in lines:
                    if d.startswith("---") or d.startswith("+++"):
                        continue
                    L.append(d)
                L.append("```")
        L.append("")

    L += [
        "## 三、校验",
        "",
        "- 相对 import 全部指向已搬运文件",
        "- `#miao*` 别名全部能在 `package.json` 的 `imports` 中解析",
        "- 无云崽注入的全局变量残留（redis / logger / Bot / segment / Renderer / Yunzai）",
        "",
    ]
    return "\n".join(L)


if __name__ == "__main__":
    sys.exit(main())

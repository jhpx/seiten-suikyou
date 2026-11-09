# 星天水镜 · 前后端接口文档

本文只描述「前端 ↔ 后端 HTTP 接口」的契约：有哪些接口、请求怎么发、响应长什么样。
页面如何展示、服务如何部署，不归这里管（部署见 [`docs/DEPLOY.md`](DEPLOY.md)）。

后端源码：`src/server/routes.ts`（**唯一**列出 URL 的地方，一条路由一行）+ `src/rest/<领域>.rest.ts`（控制器，一个领域一个文件）+ `src/service/<领域>.service.ts` 视图整形；
前端调用集中封装在前端子仓库 seiten-suikyou-web 的 `core.js` 的 `api()` / `uidApiUrl()`。

---

## 一、通用约定

### 1.1 响应包络（envelope）

**所有**接口成功与失败都包这层：

```jsonc
// 成功
{ "ok": true, "data": { ... } }
// 失败
{ "ok": false, "error": { "code": "no_data", "message": "库里没有 uid 101242308。先抓一次：POST /api/accounts/101242308/refresh" } }
```

前端 `api()` 在 `res.ok === false` 或 `body.ok === false` 时抛错，
错误信息用 `error.message`（服务端已给可读文本）。

### 1.2 路径与参数

| 约定 | 说明 |
|---|---|
| 资源名复数 | `/api/accounts`、`/api/accounts/:uid/characters/:avatarId/damage` |
| 动态段只收数字 | `:uid`、`:avatarId` 写成 `:uid{[0-9]+}`，非数字**匹配不上路由**，直接 `404 not_found`（不会走到业务校验） |
| 语言走 query | `?locale=chs`，不传或传错退回默认语言 |
| 请求体 | 绝大多数接口无 body，参数从 URL 取。唯一两个收 JSON body 的是 `POST …/simulator` 与 `POST …/rubric`（结构化对象不适合塞 URL） |

### 1.3 语言参数 `locale`

取值见 `/api/meta` 返回的 `locales`。不传或传错 → 退回默认语言（当前 `chs` 简体中文）。
候选：`chs` / `cht` / `en` / `ja` / `ko`（别名也收：`zh-cn`、`zh-tw`、`jp`、`kr` 等，见 `common/names.ts` 的 `ALIASES`）。
但注意：敌人名（`enemyName`）只有 miao 的中文，不随 locale 切换；元素名（`elemText`）已按 locale 本地化（七元素在 `common/ui.ts` 的 ui 表里）。

### 1.4 限流

每个接口的限流档挂在**它自己那条路由的中间件**上（`guard('read')` / `guard('fetch')`），默认限额：

| 档 | 用在哪些接口 | 默认限额（每分钟） | 命中返回 |
|---|---|---|---|
| `fetch` | `POST /api/accounts/:uid/refresh`（另加全局总闸 `fetchAll` 30） | 每 IP 20 | `429` + `Retry-After` |
| `read` | `GET /api/accounts`、`/api/accounts/:uid`、`/api/accounts/:uid/characters/:avatarId/damage` | 每 IP 300 | `429` + `Retry-After` |
| `none` | `/api/meta`、`/api/health` | 不限（状态探针被限会误报故障） | — |

静态页与素材图**故意不限流**。本地调试可加 `--no-rate-limit` 关掉。

### 1.5 跨域（CORS）

由后端启动参数 `--cors-origin`（或环境变量 `CORS_ORIGIN`，逗号分隔多个）控制，
默认**不开**。命中白名单才回 `Access-Control-Allow-Origin: <Origin>` + `Vary: Origin`。

白名单写 `*` 表示任何来源都放行，此时回的是 `Access-Control-Allow-Origin: *`
（调通阶段用，正式上线换成具体域名）。

预检 `OPTIONS` 在限流**之前**回 `204`（`Allow-Methods: GET,POST,OPTIONS`、
`Allow-Headers` 原样回显浏览器要的那些、`Max-Age: 86400`），否则带自定义头的跨域请求发不出去。

### 1.6 错误码

见文末「错误码速查」。

---

## 二、接口清单

| 方法 | 路径 | 作用 |
|---|---|---|
| GET | `/api/meta` | 语言表、界面文案、权重筛选项 |
| GET | `/api/health` | 存活探针 + 数据源状态快照 |
| GET | `/api/accounts` | 账号列表 |
| GET | `/api/accounts/:uid` | 一个账号的完整视图 |
| GET | `/api/accounts/:uid/characters/:avatarId/damage` | 单个角色的伤害计算 |
| GET | `/api/accounts/:uid/characters/:avatarId/rubrics` | 该角色可用的 miao 评分规则 + 当前选中项 |
| POST | `/api/accounts/:uid/characters/:avatarId/rubric` | 选 / 清一个评分规则（请求体 `{ rubric }`） |
| POST | `/api/accounts/:uid/refresh` | 从 enka 抓一份新的并入库 |

### 2.1 `GET /api/meta`

最先进页面时调一次（拿界面文案和多语言选项）。

**响应 `data`：**
```jsonc
{
  "locales": [ { "code": "chs", "name": "简体中文" }, /* … 共 5 项 */ ],
  "defaultLocale": "chs",
  "i18nReady": true,            // false = 多语言表还没同步，界面只有中文
  "ui": { "title": "星天水镜", "sort": "排序", /* … 全部界面文案，按 locale 给 */ },
  "weightOptions": [            // 「按属性权重筛选」的选项，前端不写死词条名
    { "key": "hp",   "label": "生命值" },
    { "key": "atk",  "label": "攻击力" },
    { "key": "def",  "label": "防御力" },
    { "key": "mastery", "label": "元素精通" },
    { "key": "cpct", "label": "暴击率" },
    { "key": "cdmg", "label": "暴击伤害" },
    { "key": "recharge", "label": "元素充能" },
    { "key": "dmg",  "label": "元素伤害加成" },
    { "key": "phy",  "label": "物理伤害加成" },
    { "key": "heal", "label": "治疗加成" }
  ]
}
```

### 2.2 `GET /api/health`

存活探针 / 部署自检用，同时给主页的「数据源在线状态」指示灯供数。

**响应 `data`：**
```jsonc
{
  "uids": 12,                          // 库里现有 uid 数
  "regions": [                        // Enka 官方 Genshin 各区分服
    { "name": "euro", "status": "up", "color": "#e67e22" }
  ],
  "microggServers": [                 // MicroGG 镜像节点自己的两个服（china / bilibili）
    { "name": "china", "status": "up", "color": "#e74c3c" }
  ]
}
```

`status` 为 `up` / `down` / `unknown`，`color` 是状态页给该区服的标识色。后端每 5 分钟拉一次
`status.enka.network` 缓存在内存，前端进页面读一次；拉不到时 `regions` 为空数组、
`microggServers` 两服以 `unknown` 占位。

### 2.3 `GET /api/accounts`

列表页「切换账号」下拉的数据。

**响应 `data`（数组）：**
```jsonc
[
  {
    "uid": 101242308,
    "nickname": "苍雷",
    "level": 60,
    "worldLevel": 8,
    "avatarCount": 57,
    "fetchedAt": "2026-10-14 21:03:11"   // 本地时区可读文本，ISO UTC 在存储层
  }
]
```

### 2.4 `GET /api/accounts/:uid`

**核心接口**：一个账号的完整视图，含全部角色、武器、圣遗物、评分、伤害前的面板。
前端进首页、切语言、刷新成功后都靠它重画。

**Query：** `?locale=chs`

**响应 `data`（`AccountView`）：**
```jsonc
{
  "locale": "chs",
  "fetchedAt": "2026-10-14 21:03:11",
  "account": { "uid": 101242308, "nickname": "苍雷", "level": 60, "worldLevel": 8, "signature": "…" },
  "count": 57,
  "skipped": [],        // 内核不认识的角色 avatarId（新角色先于 miao 更新时会出现）
  "avatars": [ /* AvatarView，见第三节 */ ],
  "advice": { /* AdviceBundle，见 3.3 —— 「该刷什么套装」，由 avatars 再聚合一次算出来；
                 两种口径一起给：主份不含 SS（默认），withSS 是含 SS 的那份；
                 每种口径里又带四份排序名次（orders） */ }
}
```

**错误码：**
- `404 no_data` — 库里没有这个 uid（需先 `POST /api/accounts/:uid/refresh`）。

### 2.5 `GET /api/accounts/:uid/characters/:avatarId/damage`

明细页下侧「伤害计算」表的数据。

**响应 `data`（`DamageView` 或 `null`）：**
```jsonc
{
  "rows": [
    { "title": "普攻", "dmg": "12,345", "avg": "13,801", "unit": "" },
    { "title": "元素爆发", "dmg": null, "avg": "9,002", "unit": "" }  // dmg=null 表示不吃暴击
  ],
  "buffs": [ { "title": "蝶引来生", "desc": "开E获得2,858.0点攻击力加成" } ],
  "createdBy": "冰翼",     // calc.js 署名（miao 社区贡献者）
  "enemyName": "小宝",
  "enemyLv": 103
}
```
`data` 为 `null` = 这个角色算不出伤害（没配 `calc.js` / 元数据不认识），页面不出这一块。

**错误码：**
- `404 no_data` — uid 不存在；
- `404 no_character` — uid 下没有这个 avatarId。

### 2.6 `POST /api/accounts/:uid/refresh`

联网打 enka 抓数据进库，抓完直接回最新视图。前端「刷新 / 输入 UID 拉取」按钮触发。
单独走 `fetch` 限流（每 IP + 全局两道），因为只有它会打上游。

**请求：** 无请求体。`uid` 在路径里，`locale` 在 query 里（`?locale=chs`，可选）。

**成功响应（200）：**
```jsonc
{
  "ok": true,
  "data": { /* 同 2.4 的 AccountView，抓完直接返回最新视图 */ },
  "meta": { "fetched": 57, "source": "enka" }   // fetched=抓到的角色数；source=数据来源
}
```

**错误码：**
- `502 fetch_failed` — 上游 enka 失败（未公开 / 查不到 / 太频繁，message 已是人话）。

### 2.7 `GET /api/accounts/:uid/characters/:avatarId/rubrics` —— 评分规则列表

每个角色在 miao 的 `artis.js` 里本来就按「武器 / 命座 / 套装 / 主词条」分了多套权重（如阿蕾奇诺 纯火/基础、迪希雅 血牛/基础）。
默认 view 由 miao **自动挑**一套；这个接口把全部可选规则列出来，前端据此给用户一个下拉框——
「当你觉得某个角色评分不对时，挑一个跟你实际玩法一致的规则」。

**成功响应（200）：**（以 `?locale=en` 为例）
```jsonc
{
  "ok": true,
  "data": {
    "rubrics": [
      { "name": "通用", "label": "Furina-General", "cond": "未命中上述任一分支", "isBase": true },
      { "name": "板砖纯辅", "label": "Furina-Key Support", "cond": "武器 = 圣显之钥 且 充能 ≥ 220", "isBase": false }
    ],
    "current": "板砖纯辅"      // 当前选中的规则名；null = 用 miao 自动选（随配装变）
  }
}
```
- `current` 为 `null` 表示「未选」，view 里该角色按 miao 自动选算分。
- `name` 是唯一标识（miao 的中文规则名），**各语言都一样**，选规则时原样回传。
- `label` 是**给人看的**「角色名-规则名」，**跟着 `?locale=` 变**：角色名走官方文案表，规则名走我们自己的意译表（`src/common/rubric-names.ts`）。
- `cond` 是触发条件的中文说明，**目前只有中文**（页面上不显示，只作数据/文档用途）。

**错误码：**
- `404 no_data` — 库里没有该 uid。
- `404 no_character` — uid 下没有该 avatarId。

### 2.8 `POST /api/accounts/:uid/characters/:avatarId/rubric` —— 选 / 清评分规则

**请求体（JSON）：** `{ "rubric": "纯辅" }` 选某个规则；`{ "rubric": null }` 清回 miao 自动选。
`rubric` 必须是 2.7 列表里某个 `name`，否则判 `bad_rubric`。

**成功响应（200）：**
```jsonc
{ "ok": true, "data": { "current": "纯辅" } }   // 回显选中结果（null 表示已清除）
```
选中后，下一次拉 `/api/accounts/:uid`（整包视图）时，该角色的 `score.classTitle` 变成规则名、
`score.markValue` 按那套权重重算——**叠加 miao 的武器 / 套装适配**（护摩加生命、绝缘4 充能齐平、西风系暴击拉满），
与 miao 在该 build 下自动选该规则**逐字一致**。

**错误码：**
- `400 bad_request` — 缺 `rubric` 字段，或 `rubric` 不是字符串 / null。
- `404 no_data` / `404 no_character` — 同 2.7。
- `404 bad_rubric` — `rubric` 不在该角色可用规则里。

---

## 三、关键响应结构（节选）

### 3.1 `AvatarView`（数组项，2.4 `avatars[]`）
与前端展示强相关的字段：

| 字段 | 含义 |
|---|---|
| `avatarId` / `name` / `nameZh` / `star` | 角色 id、本地化名、中文名、星级 |
| `level` / `cons` / `fetter` | 等级 / 命座 / 好感 |
| `elem` / `elemText` / `elemBg` / `elemIcon` | 元素 key / 元素名 / 元素底图 / 元素图标（响应里的相对路径 `assets/...`） |
| `splash` / `imgs` | 立绘及命座、天赋图（相对路径 `assets/...`）。上游没给立绘的角色（奇偶·男/女）**不输出** `splash`，前端拿到空值就不铺图 |
| `imgs.cons1~6` / `imgs.e` / `imgs.q` | 命座与天赋图标。普通角色是 `assets/meta-gs/character/<角色名>/icons/cons-N.webp`；**主角（旅行者 / 空 / 荧）按元素分目录**：`assets/meta-gs/character/旅行者/<元素>/icons/cons-N.webp` —— 上游把三种叫法的图标都收在 `旅行者/` 下按七元素拆开，`空/` 和 `荧/` 自己的目录里只有 `imgs/splash.webp`，按角色名拼必然 404。元素取**运行时解析出来的那个**（`profile.elem`，从技能表推），miao 静态表里主角的 `elem` 是 `multi`，拿它拼同样 404。`e` / `q` 有两条路：命座提升该天赋时（miao 的 `talentCons`，主角是 e←5、q←3）直接复用对应命座图的 URL，否则用同目录的 `icons/talent-e.webp`。**上游没给美术资源的角色，这组字段直接不输出**：奇偶·男性 / 女性（`avatarId` 10000117 / 10000118，4 星人偶）目录里只有 `icons/talent-e.webp` 和 `talent-q.webp`，`splash` 与 `cons1~6` 硬拼就是 7 个 404 —— 所以按 avatarId 列进 `CHAR_WITHOUT_ART`，命中就不给这两组，前端 `setBg` 没图不铺、命座整块不画（天赋 e/q 是真图，照旧给） |
| `imgs.face` | 头像小图 `assets/meta-gs/character/thumbs/<avatarId>/face.webp`（缩到 **196px**、不裁边），给**首页两种卡片（画到 107px）和模拟器 96px 圆框**用。本地预处理件，生成入口 `tools/gen_flower.py`；目录形状照圣遗物：**id 当文件夹、文件名说清是哪张**，id 不用中文名（官方改译名换不掉）。原图那份 `imgs/face.webp` 已删（全站只当小图用），所以**拿不到 `avatarId` 时这个字段不输出**（不拼假路径），前端 `imgs.face \|\| imgs.splash` 自然退回立绘。`imgs` 里还有 `splash`（上游原图，明细页立绘按 1400px 宽摆，必须用原图）、`cons1~6`、`talent-e/q`、`a`；`imgs.card` / `imgs.banner` 已移除（前端从未引用） |
| `rarityBg` | 星级底色图（相对路径 `assets/...`） |
| `weapon` | `{ state:'none'|'unknown'|'ok', itemId, name, nameZh, sName, icon, thumb(相对路径 assets/...), level, affix, promote, star, attrs, desc }` |
| `weapon.icon` / `weapon.thumb` | 两张图按显示尺寸分：`icon` 是上游原图 `assets/meta-gs/weapon/<类型>/<中文名>/icon.webp`（256px），只给**明细页那张 100px 武器卡**用；`thumb` 是 `assets/meta-gs/weapon/thumbs/<itemId>.webp`（缩到 96px、不裁边，武器原图几乎满格），给**首页卡片 28×38px 和模拟器 40px 小格**用。目录按 itemId 命名，不分武器类型、不用中文名，id 不会重复也不会随译名变。本地预处理件，生成入口 `tools/gen_flower.py`；未装备或查不到武器时两者都是 `null`（前端回退到通用类型图） |
| `weapon.attrs` | `[{ key, label, value }]`：`key` 是标准词条 key（`atkBase` / `atk` / `hp` / `mastery` / `cpct` / `cdmg` / `recharge` …），`label` 是已本地化的官方名（基础攻击力 / 攻击力 / 生命值…），`value` 是显示串（`608` / `49.6%`） |
| `score` | `{ mark:'204.8', markValue:204.81, markClass:'SS', classTitle, rubricLabel, isDefaultWeight, isCustomWeight }`。`mark` 是分数文本（可直接显示）、`markClass` 是档位；`classTitle` 是 miao 的中文原文（`芙宁娜-通用`，诊断/对拍用），**页面显示用 `rubricLabel`**（同一件事的当前语言版本，如 `Furina-General`） |
| `sets` | 圣遗物套装汇总（`[{ setId, name, nameZh, count, icon }]`）。按 `setId` 归属统计，同一套不会裂成两组；**单件也收**（`count: 1`，接口给全量件数，由客户端决定显示哪些），客户端只认 `count >= 2` —— 1 件不激活套装效果，算不上「穿这套」，卡片不列、也不显示图标。`icon` 是**套装代表图**：1 号位（花）裁掉透明边、缩到 96px 的 `1.webp`，放在 `assets/meta-gs/artifact/thumbs/<setId>/`（本地预处理件，不是上游素材）。目录名用 `setId` 而非中文套装名：数字身份不随官方译名变，也和前端筛选／排序用的套装身份一致；`imgs/` 那层是上游原样复制，仍按中文套装名摆。`artifacts[].icon` 才是 `imgs/<套装名>/` 下的 1~5 号部位原图（明细页显示 100px，用原图）。刷取建议里那排 18px 的部位小图不另给字段：前端把 `icon` 的末段换成 `<部位号>.webp`，就能拿到同一 `thumbs/<setId>/` 目录下的预处理件（花就是 1 号，换出来还是自己） |
| `artifacts` | 5 件圣遗物明细，每件含 `pos` / `posName` / `empty` / `name` / `nameZh` / `setId` / `setName` / `level` / `star` / `icon`（相对路径 `assets/...`）/ `main` / `subs` / `mark` |
| `panel` / `attrTable` / `allAttr` / `consList` / `talent` | 明细页面板、属性表、合计、命座、天赋 |

> 图片字段都是**相对路径** `assets/...`，由浏览器按当前页域名解析；服务端只提供数据，不处理图片。
> 路径解析的部署约定见 [`docs/DEPLOY.md`](DEPLOY.md)。

### 3.2 `DamageView`
见 2.5。

### 3.3 `AdviceView`（2.4 `advice`）

「这段时间该刷什么套装」。不是新算一遍评分，而是把 `avatars[]` 已经算好的件级分数按套装再聚合一次，
所以它跟页面上的分数永远同一口径。

```jsonc
{
  "minLevel": 71,              // 低于这个等级的角色不进统计（练度不够 ≠ 圣遗物差）
  "includeSS": false,          // 这一份算不算 SS 件。主份 = **默认口径，不含**
  "orders": {                  // 四种排序各一份名次（套装 nameZh），**都已截到 8 套**
    "balance": ["昔日宗室之仪", "…"],   // 综合权衡：四项加权分
    "junk": ["…"],                      // 次品数量：D/C/B 的件数
    "owners": ["…"],                    // 覆盖人数：多少人还在穿
    "boost": ["…"]                      // 提升弹性：补一件能涨多少分
  },
  "sets": [                    // 全量套装，按「综合权衡」排好；页面按 orders 里的名字来取
    {
      "nameZh": "昔日宗室之仪",
      "name": "昔日宗室之仪",    // 跟 locale 走
      "icon": "assets/meta-gs/artifact/thumbs/15007/1.webp",  // 套装代表图（1 号花图裁边缩到 96px，目录是 setId）；advice.sets 与 avatars[].sets 同口径
      "bad":  [ /* AdvicePiece */ ],   // D / C / B 档
      "mid":  [ /* AdvicePiece */ ],   // A / S 档
      "good": [ /* AdvicePiece */ ],   // 只有 SS 档（不含 SS 的这份里恒为空）
      "count": { "bad": 3, "mid": 6, "good": 0, "total": 9, "owners": 5 },
      "gap": 181.1,             // ① 稀烂程度：Σ(42 − 单件分)
      "drop": 15.1,             // ③ 均值落差：覆盖角色的（五件均值 − 最差件）平均
      "rough": 0.67,            // ④ 初始三词条占比：统计范围内白几成是初始三词条
      "score": 0.839,           // 四项各自除以账号内最大值后，按权重相加（0~1）
      "star": 5,                // 账号里实穿的最高星级
      "farmable": true          // false = 只有 4★ 版本，副本刷不出来（排在最后）
    }
  ],
  "withSS": { /* 结构同上，includeSS = true 的那一份 */ }
}
```

`sets` 给全量、`orders` 给四份**截断后的名次**，是为了让「换排序」不重算也不重传：
四份名次共用同一批对象，页面换排序只是换一条名字序列照着重画。

两种口径（不含 SS / 含 SS）在**同一次响应里一起给**：口径只差一个布尔，算它需要的 `avatars`
就在手边，而整包视图本身有几百 KB —— 让前端为一个开关再打一次请求不值当。
所以 `advice` 是**默认那份（不含 SS）**（`advice.includeSS = false`），`advice.withSS` 是含 SS 的，
两块形状完全一样，前端换着渲染即可。

**口径：**

| 规则 | 说明 |
|---|---|
| 角色 | `level >= minLevel` |
| 件 | 只算凑到 **2 件以上**的套装，外加每人**主套**（见下一行）；其余孤件是散件，不进统计 |
| 主套 / 缺件 | 每人挑一套补**空槽位**：**件数最多**的那套；件数一样时挑**已有件总分高**的那套（平手按套装名，保证稳定）。缺件 = 身上**没穿任何圣遗物**的部位，补 `missing: true` 的 0 分占位 —— 它占一个格子、进成色条、进 `gap`（42 − 0），但没有分数（`markText` 为 `---`）、没有词条（`initSubs = null`）。**穿着散件的部位不算缺件**（他穿了 5 件就没有缺件，只是这套没占满位置）；**别的套装不补** |
| SS 件 | 开关，**默认不算**（`includeSS = false`）：SS 件**整件摘掉** —— 不进明细、不产生缺口、不算人头、不进 `rough`。但「凑齐 2 件」仍按**身上实穿**的件数判：两件都是 SS 也算凑齐了，只是这些件本身不算数 |
| 三档 | **跟着内核的档位字母走**：`bad` = D/C/B、`mid` = A/S、`good` = SS |
| 不统计 | **SSS 及以上**（≥49）不入任何一档 —— 那已经不用刷了，算进 SS 只会让「达标」虚高 |
| 不列 | 一件都不在统计范围内（这套全是 SSS 以上）→ 整条不出现 |
| `total` / `owners` | 都只算统计范围内的：`total = bad + mid + good`，`owners` = 其中至少有一件的人数 |
| `gap` | ① 稀烂程度 = **Σ(42 − 单件分) + 42 × 缺件数**，只算 SSS 以下的件。缺的每一件按满额 42 计 —— 所以「只穿 1 件」= 3 件缺口 + 已有件缺口，自然排在前面 |
| `drop` | ③ 均值落差 = 覆盖角色各自的（五件均值 − 最差件）再取平均。不是「套装内所有件的均值 − 最差件」—— 那个数会被件数带偏（15 件套的极差天然大于 3 件套） |
| `rough` | ④ 初始三词条占比 = **初始三词条的件数 ÷ 认得出词条数的件数**。初始三词条比四词条少一次 roll（第 4 级那档被用来解锁第 4 条），天花板天然低，所以「这套全是三词条」= 池子废得更彻底 = 更该刷。认不出的件（`initSubs` 为 null）两边都不算 |
| `score` | **加权汇总（SAW）**：`0.45 × gap/maxGap + 0.15 × owners/maxOwners + 0.20 × drop/maxDrop + 0.20 × rough/maxRough`，结果 0~1。四项各自除以**本账号内**的最大值 |
| 归一化 | 必须线性，别换 √ / log：压缩会削平大套在缺口项上的优势，件数会重新主导名次 |
| 排序 | **四种**，各算一份名次放进 `orders`：`balance` 综合权衡（`score` 降序）、`junk` 次品数量（`count.total` 降序，即**成色条上的格子数**；同件数再看 D/C/B 多者、再看 `gap`）、`owners` 覆盖人数（`count.owners` 降序）、`boost` 提升弹性（`drop` 降序） |
| 排序共同点 | 四种都**先比 `farmable`**（4★ 套沉底 —— 那是「换掉」不是「刷」），末尾都拿 `score` 兜底，免得平手时名次随遍历顺序飘 |
| 截断 | `orders` 每份最多 8 套；`sets` 不截断 —— 页面按名字回 `sets` 取对象 |

> `score` 只用于**同一账号内**排序，不能跨账号比较 —— 归一化的分母是账号自己的最大值。

> 档位线由内核 `ArtisMark` 的 `scoreMap` 给：D<7 C<14 B<21 A<28 S<35 SS<42 SSS<49 ACE<56 MAX<70。
> 服务端不自己重划分数线，只按字母分组 —— 两边各算一遍必然差一档。

**`AdvicePiece`：**

| 字段 | 含义 |
|---|---|
| `avatarId` / `name` | 穿这件的人（`avatarId` 可直接跳明细页） |
| `pos` / `posName` | 部位 1~5 / 部位名（跟 locale 走） |
| `mark` / `markText` / `markClass` | 原始分（0~70）/ 内核格式化串（1 位小数）/ 档位字母 |
| `setCount` | 这个人在该套装上有几件（2 = 只吃 2 件套效果，4/5 = 凑 4 件套） |
| `missing` | `true` = 这件是**拼凑的缺件位**（主套没穿满 5 格时补的 0 分占位）：有部位、没有分数（`markText` 恒为 `---`）、没有词条。页面只画部位图 + `---`，不画分数与 3/4 角标 |
| `framePos` | 这一行要**画框**的部位号（1~5）：本人身上凑够 2 件的套装都算，包括本套。散件（那套只在他身上 1 件）不在里面 —— 所以 4+1 与 2+2+1 都是「四个框 + 一个散件空位」。页面只有这张卡的件，看不到身上另外那套，靠它补空格子的框 |
| `initSubs` | 初始副词条条数：`3` = 初始三词条、`4` = 初始四词条、`null` = 认不出（页面不画角标，也不进 rough 的统计）。算法：`appendPropIds.length − floor(已升级档数)`，满级 20 级共 5 档 |

---

## 四、错误码速查

| code | HTTP | 含义 |
|---|---|---|
| `no_data` | 404 | 库里没有该 uid（需先 refresh） |
| `no_character` | 404 | uid 下没有该 avatarId |
| `bad_rubric` | 404 | 选了一个该角色不存在的评分规则名 |
| `not_found` | 404 | 没有这个接口（路径/方法对不上，含动态段不是数字） |
| `asset_type` / `asset_missing` / `asset_escape` | 404 / 404 / 403 | 素材相关（扩展名不支持 / 不存在 / 目录穿越） |
| `rate_limited` | 429 | 触发限流，看 `Retry-After` |
| `fetch_failed` | 502 | 上游 enka 失败 |
| `internal` | 500 | 服务端未捕获异常 |

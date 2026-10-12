/*
 * Artifact —— 一件圣遗物的领域模型
 *
 * 存在的意义：**让「内存里的形状」不再由数据库的列名决定**。
 * 之前 ingest 直接吐「和 DB 列名一模一样」的扁对象、repo 再拿一份列名常量反着取值，
 * 于是改一列要动三个文件；现在进出都走这个类：
 *
 *   enka 的一件装备 ──Artifact.ofEnka──▶ Artifact ──toValues──▶ 一行
 *                                          ▲
 *                                       fromRow
 *                                           │
 *                                        一行
 *
 * 三条不变量（都跟评分有关，改错了分就变）：
 *   · `appendPropIds` **保序、保重复** —— 内核靠「同一个 id 出现几次」算词条数，
 *     去重或聚合会把这信息抹掉；`subStats` 是 enka **合过**的那一份，**只能用于显示**。
 *   · `mainPropId` 是**数字** id（14001），喂内核用；字符串 prop 只出现在 `subStats` 里。
 *   · 库里只存 id 与数值，**不存任何名字**（名字是多语言的，见 docs/DESIGN-DATA-MODEL.md）。
 */
import { Stat } from './stat.js'
import { num } from './num.js'

/* 装备槽位名 → 圣遗物位置（与上游 EnkaData.js 的 artisIdxMap 一致） */
const POS_BY_EQUIP_TYPE = {
  EQUIP_BRACER: 1,   // 生之花
  EQUIP_NECKLACE: 2, // 死之羽
  EQUIP_SHOES: 3,    // 时之沙
  EQUIP_RING: 4,     // 空之杯
  EQUIP_DRESS: 5     // 理之冠
}

/* 兜底：部件 item id 的第 4 位数字编了槽位，是 miao `Artifact.get()` 里
   那个 [4,2,5,1,3][name[3]-1] 的逆映射。 */
const POS_BY_ID_DIGIT = { 4: 1, 2: 2, 5: 3, 1: 4, 3: 5 }

/* 库里那两列 JSON 是文本：解坏了当空，别让手工改过的库把整包读挂 */
const parse = (text) => {
  if (!text) return null
  try { return JSON.parse(text) } catch { return null }
}

export class Artifact {
  constructor ({ pos, itemId, levelRaw, star, mainPropId, appendPropIds,
    mainStatValue, subStats, nameHash, setHash }) {
    this.pos = pos                               // 1 花 2 羽 3 沙 4 杯 5 头
    this.itemId = itemId                         // 部件 id（miao Artifact.get 拿它查套装/名字/图标）
    this.levelRaw = levelRaw                     // enka 的原始等级（1 基，5★ 满级 21；内核口径 0 基，差 1）
    this.star = star
    this.mainPropId = mainPropId                 // 主词条数字 id → 喂内核
    this.appendPropIds = appendPropIds || []     // 副词条逐次 roll 的 id → 喂内核（保序保重复）
    this.mainStatValue = mainStatValue ?? null   // enka 原始主词条数值 → 显示
    this.subStats = subStats || []               // Stat[]，enka 合并后的副词条 → 显示
    this.nameHash = nameHash ?? null             // 本件名字的官方文案 key
    this.setHash = setHash ?? null               // 套装名的官方文案 key（同套 5 件共用一个）
  }

  /*
   * 落库的列。**顺序与 toValues 严格一致**（改一个必须动另一个，所以紧挨着放）。
   * 列名与序列化都由模型自己出 —— repo 不再需要一份「哪列是 JSON」的全局清单。
   */
  static COLS = ['uid', 'avatar_id', 'pos', 'item_id', 'level_raw', 'star',
    'main_prop_id', 'append_prop_ids', 'main_stat_value', 'sub_stats', 'name_hash', 'set_hash']

  /** 按 COLS 顺序的各列值（INSERT 用）。JSON 列在这儿编码。 */
  toValues (uid, avatarId) {
    return [
      uid, avatarId, this.pos, this.itemId, this.levelRaw, this.star,
      this.mainPropId, JSON.stringify(this.appendPropIds),
      this.mainStatValue,
      JSON.stringify(this.subStats.map(s => ({ prop: s.prop, value: s.value }))),
      this.nameHash, this.setHash
    ]
  }

  /** 库里的一行 → Artifact（两列 JSON 在这儿解开） */
  static fromRow (row) {
    return new Artifact({
      pos: row.pos,
      itemId: row.item_id,
      levelRaw: row.level_raw,
      star: row.star,
      mainPropId: row.main_prop_id,
      appendPropIds: parse(row.append_prop_ids) || [],
      mainStatValue: row.main_stat_value,
      subStats: (parse(row.sub_stats) || []).map(s => new Stat(s.prop, s.value)),
      nameHash: row.name_hash,
      setHash: row.set_hash
    })
  }

  /** enka 的一件装备 → Artifact；不是圣遗物（比如武器）、或位置认不出 → null */
  static ofEnka (equip) {
    if (!equip?.reliquary) return null
    const pos = POS_BY_EQUIP_TYPE[equip.flat?.equipType] ||
      POS_BY_ID_DIGIT[String(equip.itemId)[3]] || null
    if (!pos) return null
    const re = equip.reliquary
    return new Artifact({
      pos,
      itemId: num(equip.itemId),
      levelRaw: num(re.level) ?? 0,
      star: num(equip.flat?.rankLevel) ?? 5,
      mainPropId: num(re.mainPropId),
      appendPropIds: (re.appendPropIdList || []).map(Number),
      /* enka 的 `flat` 里带着官方算好的 statValue：显示层直接用它 ——
         内核自己那份基准表有 float 误差（满级花主词条算成 4,778.6，真值 4,780）。 */
      mainStatValue: num(equip.flat?.reliquaryMainstat?.statValue),
      /* ⚠️ `flat.reliquarySubstats` 是**合并后**的（同一词条多条 roll 合成一条），
         与 `reliquary.appendPropIdList`（逐次 roll、保序保重复）不是一回事 —— 两份都要留。 */
      subStats: (equip.flat?.reliquarySubstats || [])
        .filter(s => s && s.appendPropId)
        .map(s => new Stat(s.appendPropId, num(s.statValue))),
      nameHash: num(equip.flat?.nameTextMapHash),
      setHash: num(equip.flat?.setNameTextMapHash)
    })
  }

  /** 某个 miao key 的副词条数值（显示用）；没有这一条 → undefined */
  subStatValue (key) {
    for (const s of this.subStats) if (s.key === key) return s.value
    return undefined
  }

  /*
   * 初始副词条条数 —— 5★ 圣遗物下就是「初始三词条(3) / 初始四词条(4)」。
   *
   * 道理：每 4 级升一档，一档要么新增一条词条、要么强化已有的一条，所以
   *   「现在 roll 的总数 − 升级档数 = 初始条数」。
   * 满级 5★ 是 5 档：8 条 roll → 3（三词条胚子）、9 条 roll → 4（四词条胚子）。
   *
   * ⚠️ 减数必须用**减过 1 的等级**（enka 是 1 基、内核要 0 基，见下面 quality()）：直接拿 level_raw 算，
   *    会在 4 的倍数边界上错 —— 归一后 3 级（升过 0 档）的原始值是 4，`4 // 4` 会被当成升过 1 档。
   * ⚠️ 夹具里的圣遗物是「为算分造的」，roll 条数与等级并不自洽（满级却只有 4 条），
   *    对它调 quality() 会得到负数 —— 那不是这个函数的错，是夹具不模拟真实档位。
   *
   * 用途（暂未开发）：圣遗物刷取建议。词条分相当时，初始三词条的更该被换掉。
   */
  quality () {
    /* 跟 materialize 组装 profile 时是同一件事：enka 是 1 基、内核口径是 0 基，先减 1。 */
    const level = Math.max(0, (Number(this.levelRaw) || 1) - 1)
    return this.appendPropIds.length - Math.floor(level / 4)
  }

  /*
   * 一批圣遗物的副词条按 key 累加（页面「有效词条汇总」用）。
   * ⚠️ **只给显示**：内核靠 `appendPropIds` 的重复次数算词条数，喂它这份汇总会把词条数抹掉。
   */
  static subStatTotals (artifacts) {
    const out = new Map()
    for (const a of artifacts || []) {
      for (const s of a.subStats || []) {
        /* 用 num() 不用 Number()：`Number(null) === 0` 会把「没这个数」加成一个 0（见 num.js） */
        const v = s.key ? num(s.value) : null
        if (v !== null) out.set(s.key, (out.get(s.key) || 0) + v)
      }
    }
    return out
  }
}

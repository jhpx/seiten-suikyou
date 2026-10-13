/*
 * Artifact —— 一件圣遗物的领域模型
 *
 * 进出都走这个类，内存形状就不再由 DB 列名决定：
 *   enka 装备 ──ofEnka──▶ Artifact ──toValues──▶ 一行 ──fromRow──▶ Artifact
 *
 * 三条不变量（改错了分就变）：`appendPropIds` **保序、保重复** —— 内核靠「同一 id 出现几次」算词条数，
 * 而 `subStats` 是 enka **合过**的那一份、只能用于显示；`mainPropId` 是数字 id（14001）；
 * 库里只存 id 与原始值，**不存名字**（名字是多语言的，见 docs/DESIGN-DATA-MODEL.md）。
 */
import { Stat } from './stat.ts'
import type { EnkaEquip } from './enka.ts'
import { colsOf, rowArgsOf, rowValuesOf } from './fields.ts'
import type { Field } from './fields.ts'
import { num } from '../shared/util.ts'

/* 装备槽位名 → 位置（与上游 EnkaData.js 的 artisIdxMap 一致） */
const POS_BY_EQUIP_TYPE: Record<string, number> = {
  EQUIP_BRACER: 1,   // 生之花
  EQUIP_NECKLACE: 2, // 死之羽
  EQUIP_SHOES: 3,    // 时之沙
  EQUIP_RING: 4,     // 空之杯
  EQUIP_DRESS: 5     // 理之冠
}

/* 兜底：部件 id 的第 4 位编了槽位，是 miao `Artifact.get()` 里 [4,2,5,1,3][name[3]-1] 的逆映射 */
const POS_BY_ID_DIGIT: Record<string, number> = { 4: 1, 2: 2, 5: 3, 1: 4, 3: 5 }

export class Artifact {
  /* 字段必须显式声明（TS 不从 constructor 赋值反推）—— 这几行就是「标量一律 number|null」的出处 */
  pos: number | null
  itemId: number | null
  levelRaw: number | null
  star: number | null
  mainPropId: number | null
  appendPropIds: number[]
  mainStatValue: number | null
  subStats: Stat[]
  nameHash: number | null
  setHash: number | null

  constructor ({
    pos, itemId, levelRaw, star, mainPropId, appendPropIds,
    mainStatValue, subStats, nameHash, setHash
  }: {
    /* 外部原始值一律 unknown（enka JSON、库行、被手工改过的库什么都可能给）；num() 在这儿归一到
       number|null，**唯一的一次**。两个数组字段（enka 给 Stat 实例、库行给普通对象）因此收两种形状。 */
    pos?: unknown; itemId?: unknown; levelRaw?: unknown; star?: unknown; mainPropId?: unknown
    appendPropIds?: number[]; mainStatValue?: unknown
    subStats?: Array<Stat | { prop: string; value: unknown }>
    nameHash?: unknown; setHash?: unknown
  }) {
    this.pos = num(pos)                          // 1 花 2 羽 3 沙 4 杯 5 头
    this.itemId = num(itemId)                    // 部件 id（miao Artifact.get 拿它查套装/名字/图标）
    this.levelRaw = num(levelRaw)                // enka 原始等级（1 基，5★ 满级 21；内核口径 0 基，差 1）
    this.star = num(star)
    this.mainPropId = num(mainPropId)            // 主词条数字 id → 喂内核
    this.appendPropIds = appendPropIds || []     // 副词条逐次 roll 的 id → 喂内核（保序保重复）
    this.mainStatValue = num(mainStatValue)      // enka 原始主词条数值 → 显示
    /* 副词条 → 显示，不喂内核。库行读回来的是普通对象、enka 给的是 Stat —— 一律换成 Stat */
    this.subStats = (subStats || []).map(s => (s instanceof Stat ? s : new Stat(s.prop, s.value)))
    this.nameHash = num(nameHash)                // 本件名字的官方文案 key
    this.setHash = num(setHash)                  // 套装名文案 key（同套 5 件共用一个）
  }

  /* artifact 表的列 ↔ 领域字段（顺序 = 建表顺序）。列名与序列化都由模型自己出，
     repo 不需要一份「哪列是 JSON」的清单 —— FIELDS 里标了。 */
  static FIELDS: Field[] = [
    ['pos', 'pos'], ['item_id', 'itemId'], ['level_raw', 'levelRaw'], ['star', 'star'],
    ['main_prop_id', 'mainPropId'], ['append_prop_ids', 'appendPropIds', 'json'],
    ['main_stat_value', 'mainStatValue'], ['sub_stats', 'subStats', 'json'],
    ['name_hash', 'nameHash'], ['set_hash', 'setHash']
  ]

  /* uid / avatar_id 是「哪一行」的键、取自父对象，不是本件圣遗物的字段，所以不在 FIELDS 里，拼在前面 */
  static COLS: string[] = ['uid', 'avatar_id', ...colsOf(Artifact.FIELDS)]

  /** 按 COLS 顺序的各列值（INSERT 用）；uid / avatarId 由父对象给 */
  toValues (uid: number | null, avatarId: number | null): unknown[] {
    return [uid, avatarId, ...rowValuesOf(this, Artifact.FIELDS)]
  }

  /** 库里的一行 → Artifact；列名 → 字段、两列 JSON 的解码都在 FIELDS 里 */
  static fromRow (row: Record<string, unknown>): Artifact {
    return new Artifact(rowArgsOf(row, Artifact.FIELDS))
  }

  /** enka 的一件装备 → Artifact；不是圣遗物（比如武器）、或位置认不出 → null */
  static ofEnka (equip: EnkaEquip | null | undefined): Artifact | null {
    if (!equip?.reliquary) return null
    const relq = equip.reliquary
    const pos = POS_BY_EQUIP_TYPE[equip.flat?.equipType ?? ''] ||
      POS_BY_ID_DIGIT[String(equip.itemId)[3]] || null
    if (!pos) return null
    return new Artifact({
      pos,
      itemId: equip.itemId,
      levelRaw: relq.level ?? 0,
      star: equip.flat?.rankLevel ?? 5,
      mainPropId: relq.mainPropId,
      appendPropIds: (relq.appendPropIdList || []).map(Number),  // 保序保重复，不能去重/过滤
      /* enka 的 flat 里带着官方算好的 statValue：显示层直接用它 —— 内核那份基准表有 float 误差
         （满级花主词条算成 4,778.6，真值 4,780）。 */
      mainStatValue: equip.flat?.reliquaryMainstat?.statValue,
      /* ⚠️ flat.reliquarySubstats 是**合并后**的（同一词条多条 roll 合成一条），
         与 reliquary.appendPropIdList（逐次 roll、保序保重复）不是一回事 —— 两份都要留。 */
      subStats: (equip.flat?.reliquarySubstats || [])
        .filter(s => s && s.appendPropId)
        .map(s => new Stat(s.appendPropId as string, s.statValue)),
      nameHash: equip.flat?.nameTextMapHash,
      setHash: equip.flat?.setNameTextMapHash
    })
  }

  /** 某个 miao key 的副词条数值（显示用）；没有这一条 → undefined */
  subStatValue (key: string): number | null | undefined {
    for (const s of this.subStats) if (s.key === key) return s.value
    return undefined
  }

  /*
   * 初始副词条条数 —— 5★ 下就是「初始三词条(3) / 初始四词条(4)」。
   * 每 4 级升一档，一档要么新增一条、要么强化已有的，所以「现在 roll 的总数 − 升级档数 = 初始条数」。
   *
   * ⚠️ 减数必须用**减过 1 的等级**（enka 1 基、内核 0 基）：直接拿 levelRaw 算会在 4 的倍数边界上错 ——
   *    归一后 3 级（升过 0 档）的原始值是 4，`4 // 4` 会被当成升过 1 档。
   * ⚠️ 夹具里的圣遗物是为算分造的、roll 条数与等级并不自洽（满级却只有 4 条），对它调本函数会得负数。
   */
  quality (): number {
    const level = Math.max(0, (Number(this.levelRaw) || 1) - 1)
    return this.appendPropIds.length - Math.floor(level / 4)
  }

  /* 一批圣遗物的副词条按 key 累加（页面「有效词条汇总」用）。
     ⚠️ **只给显示**：内核靠 appendPropIds 的重复次数算词条数，喂它这份汇总会把词条数抹掉。 */
  static subStatTotals (artifacts: Artifact[] | null | undefined): Map<string, number> {
    const out = new Map<string, number>()
    for (const a of artifacts || []) {
      for (const s of a.subStats || []) {
        /* Stat.value 已归一到 number|null，判 null 就够（别用 Number()：它把 null 读成 0） */
        if (s.key && s.value !== null) out.set(s.key, (out.get(s.key) || 0) + s.value)
      }
    }
    return out
  }
}

/*
 * ArtifactDbo —— 一件圣遗物的数据库对象（DBO）
 *
 * 进出都走这个类，内存形状就不再由 DB 列名决定：
 *   enka 装备 ──ofEnka──▶ ArtifactDbo ──仓储映射──▶ 一行 ──仓储映射──▶ ArtifactDbo
 *
 * 三条不变量：`appendPropIds` **保序、保重复** —— 内核靠「同一 id 出现几次」算词条数，
 * 而 `subStats` 是 enka **合过**的那一份、只能用于显示；`mainPropId` 是数字 id（14001）；
 * 库里只存 id 与原始值，**不存名字**（名字是多语言的）。
 */
import { StatDbo } from './stat.ts'
import { num } from '../../common/util.ts'

export class ArtifactDbo {
  /* 字段必须显式声明（TS 不从 constructor 赋值反推）*/
  pos: number | null
  itemId: number | null
  levelRaw: number | null
  star: number | null
  mainPropId: number | null
  appendPropIds: number[]
  mainStatValue: number | null
  subStats: StatDbo[]
  nameHash: number | null
  setHash: number | null

  constructor ({
    pos, itemId, levelRaw, star, mainPropId, appendPropIds,
    mainStatValue, subStats, nameHash, setHash
  }: {
    /* 外部原始值一律 unknown；num() 在这儿归一到 number|null，唯一的一次。
       两个数组字段（enka 给 StatDbo 实例、库行给普通对象）因此收两种形状。 */
    pos?: unknown; itemId?: unknown; levelRaw?: unknown; star?: unknown; mainPropId?: unknown
    appendPropIds?: number[]; mainStatValue?: unknown
    subStats?: Array<StatDbo | { prop: string; value: unknown }>
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
    this.subStats = (subStats || []).map(s => (s instanceof StatDbo ? s : new StatDbo(s.prop, s.value)))
    this.nameHash = num(nameHash)                // 本件名字的官方文案 key
    this.setHash = num(setHash)                  // 套装名文案 key（同套 5 件共用一个）
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
   * ⚠️ 减数必须用**减过 1 的等级**（enka 1 基、内核 0 基）：直接拿 levelRaw 算会在 4 的倍数边界上错。
   * ⚠️ 测试夹具里的圣遗物 roll 条数与等级并不自洽（满级却只有 4 条），对它调本函数会得负数。
   */
  quality (): number {
    const level = Math.max(0, (Number(this.levelRaw) || 1) - 1)
    return this.appendPropIds.length - Math.floor(level / 4)
  }

  /* 一批圣遗物的副词条按 key 累加（页面「有效词条汇总」用）。
     ⚠️ **只给显示**：内核靠 appendPropIds 的重复次数算词条数，喂它这份汇总会把词条数抹掉。 */
  static subStatTotals (artifacts: ArtifactDbo[] | null | undefined): Map<string, number> {
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

/*
 * 套装 → 最高星级。
 *
 * ⚠️ 上游 miao 的 `resources/meta-gs/artifact/data.json` 里**没有星级字段**（只有 id / name / idxs / skills），
 *   所以这张表只能手写。只列「不是五星」的那批，其余一律按 5★，新套装不用维护。
 *   数值来自游戏内图鉴：游医/冒险家/幸运儿 最高 3★，其余 14 套最高 4★（都没有五星版本）。
 * 用途：改圣遗物弹窗的套装下拉标「5★/4★/3★」，并决定等级上限（4★ 满级 +16、3★ +12）。
 */
const SET_MAX_STAR: Record<string, number> = {
  游医: 3, 冒险家: 3, 幸运儿: 3,
  行者之心: 4, 勇士之心: 4, 守护之心: 4, 奇迹: 4,
  战狂: 4, 武人: 4, 教官: 4, 赌徒: 4, 流放者: 4, 学士: 4,
  祭火之人: 4, 祭水之人: 4, 祭雷之人: 4, 祭冰之人: 4
}

/** 这套圣遗物最高几星（查不到就是 5★ —— 绝大多数套装都有五星版本） */
export function setMaxStar (setNameZh: string): number {
  return SET_MAX_STAR[setNameZh] || 5
}

/*
 * enka 响应的**形状**（类型契约）—— 只声明「我方读哪些字段」，抓取逻辑在 src/upstream/enka.ts，两码事。
 *
 * 住在领域层：模型自己带着 `ofEnka` 工厂、直接读这些字段，类型只能跟模型放在一起。
 *
 * ⚠️ 字段**全是可选的**：enka 是外部数据，什么都可能缺、数字也可能是字符串。这里的类型只承诺
 *    「我们读的名字对不对」，值域一律交给 num() / str() 在 constructor 里归一 ——
 *    哪天 enka 改了字段名，在这里报的编译错误就是提醒。
 */

/** equipList 里的一项（武器或圣遗物各读各的） */
export interface EnkaEquip {
  itemId?: number | string
  flat?: {
    itemType?: string
    equipType?: string
    rankLevel?: number
    nameTextMapHash?: number | string
    setNameTextMapHash?: number | string
    /** 圣遗物：官方算好的主词条数值（显示层直接用它，不信内核重算的） */
    reliquaryMainstat?: { statValue?: number | string }
    /** 圣遗物：**合并后**的副词条（与 reliquary.appendPropIdList 的逐次 roll 不是一回事） */
    reliquarySubstats?: Array<{ appendPropId?: string; statValue?: number | string }>
  }
  reliquary?: {
    level?: number
    mainPropId?: number
    /** 逐次 roll 的副词条 id：保序、保重复（内核靠重复次数算词条数） */
    appendPropIdList?: number[]
  }
  weapon?: {
    level?: number
    promoteLevel?: number
    /** 「额外精炼次数」：精1 = 0 或不存，读时 +1 才是 1~5 */
    affixMap?: Record<string, number | string>
  }
}

/** avatarInfoList 里的一项 */
export interface EnkaAvatarInfo {
  /** enka 官方字段名，角色 id（如 10000039）—— 官方数据里角色就叫 **Avatar**，不是我们的命名 */
  avatarId?: number
  /** 等级在 '4001'、突破在 '1002'（enka 的数字字符串键） */
  propMap?: Record<string, { val?: number | string }>
  talentIdList?: unknown[]
  fetterInfo?: { expLevel?: number }
  costumeId?: number
  skillLevelMap?: Record<string, number>
  equipList?: EnkaEquip[]
  /** 游戏客户端自己算好的最终面板（键是协议写死的 prop id）—— 面板对拍的标准答案 */
  fightPropMap?: Record<string, number | string>
}

/** playerInfo */
export interface EnkaPlayerInfo {
  uid?: number | string
  nickname?: string
  level?: number
  worldLevel?: number
  signature?: string
  profilePicture?: { avatarID?: number }
  nameCardId?: number
}

/** 整包响应（enka /api/uid/{uid}） */
export interface EnkaPayload {
  uid?: number | string
  ttl?: number
  playerInfo?: EnkaPlayerInfo
  avatarInfoList?: EnkaAvatarInfo[]
}

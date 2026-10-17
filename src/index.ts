/*
 * 评分内核出口 —— 星天水镜
 *
 * 职责只有两件：
 *   1. 注册 miao 的元数据（词条基准、权重表、角色规则）
 *   2. 原样导出 miao 的评分模块
 *
 * 所有 miao 源码都在 ../vendor/miao/ 下，由 python tools/sync_miao.py 从 miao-plugin 搬运。
 * 别名 #miao / #miao.models / #miao.path 由 package.json 的 imports 字段解析，
 * 不需要改写 import，也不需要 loader hook。
 * 本仓库自包含，不依赖外部 miao-plugin 目录。
 */
/*
 * 注册 miao 的元数据。没 import 就等于没注册 —— Meta 是「谁 import 谁登记」的，
 * 漏一个就会出现「Weapon.get() 返回 false」这种莫名其妙的失败。
 */
import '../vendor/miao/resources/meta-gs/artifact/index.js'
import '../vendor/miao/resources/meta-gs/character/index.js'
import '../vendor/miao/resources/meta-gs/weapon/index.js'
import '../vendor/miao/resources/meta-gs/material/index.js'

export { default as ArtisMark } from '../vendor/miao/models/artis/ArtisMark.js'
export { default as ArtisMarkCfg } from '../vendor/miao/models/artis/ArtisMarkCfg.js'
export { default as Artis } from '../vendor/miao/models/artis/Artis.js'
export { default as ArtisAttr } from '../vendor/miao/models/artis/ArtisAttr.js'
export { default as ArtisSet } from '../vendor/miao/models/artis/ArtisSet.js'

export { default as Artifact } from '../vendor/miao/models/Artifact.js'
export { default as ArtifactSet } from '../vendor/miao/models/ArtifactSet.js'
export { default as Character } from '../vendor/miao/models/Character.js'
export { default as Weapon } from '../vendor/miao/models/Weapon.js'
export { default as Material } from '../vendor/miao/models/Material.js'

/* 面板属性计算 —— 角色评分规则要读 profile.attr（76 个规则里 56 个读它），
   而 attr 不是数据源给的，是 miao 自己算的（models/Avatar.js:320 那句 attr.calc()）。 */
export { default as Attr } from '../vendor/miao/models/attr/Attr.js'

/* 伤害计算 —— `ProfileDmg` 是编排入口（内部串起 DmgAttr / DmgBuffs / DmgCalc），
   每个角色的伤害脚本 calc.js 由它在运行时按角色名动态加载（旅行者按元素分目录）。
   引擎四件套一并导出，供测试与将来源码层直接取用。 */
export { default as ProfileDmg } from '../vendor/miao/models/ProfileDmg.js'
export { default as DmgCalc } from '../vendor/miao/models/dmg/DmgCalc.js'
export { default as DmgAttr } from '../vendor/miao/models/dmg/DmgAttr.js'
export { default as DmgBuffs } from '../vendor/miao/models/dmg/DmgBuffs.js'

export { Meta, Format, Data } from '../vendor/miao/components/index.js'

/* 多语言出口。miao 零 i18n 能力（resources/ 全是中文、连键都是中文名），
   所以显示层必须自带两张表 —— 官方文案在 src/common/names.ts，界面文字在 src/common/ui.ts，
   统一从 src/common/i18n.ts 出去。
   表的主键是数字 hash / 部位序号 / FIGHT_PROP_*，与展示语言无关。 */
export * as i18n from './common/i18n.ts'


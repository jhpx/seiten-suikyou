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
import '../vendor/miao/resources/meta-gs/artifact/index.js'
import '../vendor/miao/resources/meta-gs/character/index.js'

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

export { Meta, Format, Data } from '../vendor/miao/components/index.js'

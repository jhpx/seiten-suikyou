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

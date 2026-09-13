/*
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

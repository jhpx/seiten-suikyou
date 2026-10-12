/*
 * 上游 JSON 里到处是「字符串数字」（"90" / "213"），还有 undefined、空串、NaN。
 *
 * 统一在这儿收口：能转成有限数的给数字，否则给 **null**（不拿 0 充数 ——
 * 等级 0 和「没这个字段」是两回事）。领域层的四个模型都引它，别各写一份。
 */
export const num = (v) => {
  if (v === undefined || v === null || v === '') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

/*
 * miao 评分规则名的多语言表。
 *
 * 为什么单独一张表：规则名是 miao 自己的中文简称（「板砖纯辅」「星超导」「讨龙」），
 * **没有官方译名可查** —— vendor/i18n/ 里只有角色 / 武器 / 圣遗物 / 词条的官方文案。
 * 所以这一张是我们自己意译的，不是官方词；要改措辞只动这个文件。
 *
 * 为什么按「词元」存而不是整名：miao 会把多条分支拼成一个名字，用 `|` 连（「高命|精通|若水」），
 * 同一分支的两种叫法用 `/` 连（「治疗/纯水输出」）。逐条整名翻译会组合爆炸，
 * 所以拆成词元、再把原分隔符原样拼回去（见 rubricName）。
 *
 * 语言码跟 common/ui.ts、vendor/i18n 一致：chs / cht / en / ja / ko（跟 names.ts 的 locales() 一致，韩文是 ko 不是 kr）。
 * chs 不需要翻译（原文就是中文），表里不写。
 */
type Row = { cht: string; en: string; ja: string; ko: string }

const RULE_TOKENS: Record<string, Row> = {
  /* ── 角色定位 / 打法 ── */
  通用: { cht: '通用', en: 'General', ja: '汎用', ko: '범용' },
  输出: { cht: '輸出', en: 'DPS', ja: 'アタッカー', ko: '딜러' },
  辅助: { cht: '輔助', en: 'Support', ja: 'サポート', ko: '서포터' },
  纯辅: { cht: '純輔', en: 'Pure Support', ja: '純サポート', ko: '순수 서포터' },
  治疗: { cht: '治療', en: 'Healer', ja: 'ヒーラー', ko: '힐러' },
  战斗: { cht: '戰鬥', en: 'Combat', ja: '戦闘', ko: '전투' },
  直伤: { cht: '直傷', en: 'Direct DMG', ja: '直接ダメージ', ko: '직접 피해' },
  暴力: { cht: '爆擊', en: 'Crit', ja: '会心', ko: '치명' },
  血牛: { cht: '血牛', en: 'HP Tank', ja: 'HPタンク', ko: 'HP 탱커' },
  武神: { cht: '武神', en: 'War God', ja: '武神', ko: '무신' },

  /* ── 元素 / 反应流派 ── */
  纯火: { cht: '純火', en: 'Pyro only', ja: '炎のみ', ko: '불 전용' },
  蒸发: { cht: '蒸發', en: 'Vaporize', ja: '蒸発', ko: '증발' },
  超载: { cht: '超載', en: 'Overload', ja: '過負荷', ko: '과부하' },
  永冻: { cht: '永凍', en: 'Permafreeze', ja: '永久凍結', ko: '영구 빙결' },
  '(月)绽放': { cht: '(月)綻放', en: '(Lunar) Bloom', ja: '(月)開花', ko: '(월) 개화' },
  纯水输出: { cht: '純水輸出', en: 'Hydro DPS', ja: '水アタッカー', ko: '물 딜러' },
  星超导: { cht: '星超導', en: 'Star Superconduct', ja: '星超電導', ko: '성 초전도' },
  星扩散: { cht: '星擴散', en: 'Star Swirl', ja: '星拡散', ko: '성 확산' },
  月结晶: { cht: '月結晶', en: 'Lunar Crystal', ja: '月結晶', ko: '월 결정' },
  月共鸣武神: { cht: '月共鳴武神', en: 'Lunar War God', ja: '月共鳴武神', ko: '월공명 무신' },

  /* ── 命座 / 词条 / 投入档位 ── */
  高命: { cht: '高命', en: 'High Cons', ja: '高命', ko: '고명' },
  满命: { cht: '滿命', en: 'C6', ja: '完凸', ko: '풀돌' },
  精通: { cht: '精通', en: 'EM', ja: '熟知', ko: '원마' },
  高配: { cht: '高配', en: 'High Invest', ja: '高火力', ko: '고스펙' },
  '高命（1~3命）': { cht: '高命（1~3命）', en: 'High Cons (C1~3)', ja: '高命(C1~3)', ko: '고명(C1~3)' },
  '高命（1~5命）': { cht: '高命（1~5命）', en: 'High Cons (C1~5)', ja: '高命(C1~5)', ko: '고명(C1~5)' },
  '高命（4~5命）': { cht: '高命（4~5命）', en: 'High Cons (C4~5)', ja: '高命(C4~5)', ko: '고명(C4~5)' },
  '高命（4~6命）': { cht: '高命（4~6命）', en: 'High Cons (C4~6)', ja: '高命(C4~6)', ko: '고명(C4~6)' },
  '高命（6命）': { cht: '高命（6命）', en: 'High Cons (C6)', ja: '高命(C6)', ko: '고명(C6)' },
  '高配（充能40）': { cht: '高配（充能40）', en: 'High Invest (ER 40)', ja: '高火力(チャージ40)', ko: '고스펙(원충40)' },
  '高配（充能70）': { cht: '高配（充能70）', en: 'High Invest (ER 70)', ja: '高火力(チャージ70)', ko: '고스펙(원충70)' },
  '战斗（充能40）': { cht: '戰鬥（充能40）', en: 'Combat (ER 40)', ja: '戦闘(チャージ40)', ko: '전투(원충40)' },
  '战斗（充能70）': { cht: '戰鬥（充能70）', en: 'Combat (ER 70)', ja: '戦闘(チャージ70)', ko: '전투(원충70)' },

  /* ── 武器流派（社区简称，按武器官方名意译） ── */
  专武: { cht: '專武', en: 'Signature', ja: 'モチーフ', ko: '전용무기' },
  西风: { cht: '西風', en: 'Favonius', ja: '西風', ko: '페보니우스' },
  讨龙: { cht: '討龍', en: 'Thrilling Tales', ja: '龍殺し', ko: '드래곤 슬레이어' },
  若水: { cht: '若水', en: 'Aqua Simulacra', ja: '若水', ko: '약수' },
  息燧: { cht: '息燧', en: 'Ezpitzal', ja: 'エズピツァル', ko: '에즈피찰' },
  板砖纯辅: { cht: '板磚純輔', en: 'Key Support', ja: '聖顕サポート', ko: '성현 서포터' },
  苍古纯辅: { cht: '蒼古純輔', en: 'Freedom-Sworn Support', ja: '蒼古サポート', ko: '오래된 자유 서포터' },
  岩峰纯辅: { cht: '岩峰純輔', en: 'Peak Patrol Support', ja: '岩峰サポート', ko: '바위산 서포터' },
  西风纯辅: { cht: '西風純輔', en: 'Favonius Support', ja: '西風サポート', ko: '페보니우스 서포터' },
  西风武神: { cht: '西風武神', en: 'Favonius War God', ja: '西風武神', ko: '페보니우스 무신' },
  西风月共鸣武神: { cht: '西風月共鳴武神', en: 'Favonius Lunar War God', ja: '西風月共鳴武神', ko: '페보니우스 월공명 무신' },

  /* ── 特例：miao 没收录的角色 / 旅行者属性 ── */
  未知: { cht: '未知', en: 'Unknown', ja: '不明', ko: '미확인' },
  旅行者: { cht: '旅行者', en: 'Traveler', ja: '旅人', ko: '여행자' },
  冰主: { cht: '冰主', en: 'Cryo', ja: '氷', ko: '얼음' },
  草主: { cht: '草主', en: 'Dendro', ja: '草', ko: '풀' },
  风主: { cht: '風主', en: 'Anemo', ja: '風', ko: '바람' },
  火主: { cht: '火主', en: 'Pyro', ja: '炎', ko: '불' },
  雷主: { cht: '雷主', en: 'Electro', ja: '雷', ko: '번개' },
  水主: { cht: '水主', en: 'Hydro', ja: '水', ko: '물' },
  岩主: { cht: '岩主', en: 'Geo', ja: '岩', ko: '바위' }
}

/* 名字里的分隔符：`|` 分多条分支、`/` 分同一分支的不同叫法。原样保留，只翻两边的词元 */
const SEPARATORS = new Set(['|', '/'])

/**
 * 规则名 → 当前语言。认不出的词元原样返回（宁可露中文，也不吞字），
 * 所以 rubrics.json 里新增了名字也不会炸，只是那条暂时显示中文。
 */
export function rubricName (zh: string, locale: string): string {
  if (!zh || locale === 'chs') return zh
  const key = locale as keyof Row
  return zh
    .split(/([|/])/)
    .map(part => {
      if (part === '' || SEPARATORS.has(part)) return part
      return RULE_TOKENS[part]?.[key] ?? part
    })
    .join('')
}

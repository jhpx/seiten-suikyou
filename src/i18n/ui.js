/*
 * ui —— 界面文字（按钮、分组标题、提示语）
 *
 * 和 names.json 的区别：names.json 是**游戏内文案**，从官方 TextMap 抽的，
 * 几千条、机器生成、跟着游戏版本走。这里的界面文字官方表里根本没有
 * （「读取」「圣遗物」这种是我们自己页面的说法），所以只能手写。
 *
 * 量很小（二十来条 × 5 种语言），就放在代码里，不值得再开一条同步管线。
 * 缺某门语言时回落到英文 —— 界面上出现英文总比出现空白好认。
 *
 * 占位符用 {n} / {uid} / {loc} 这种 {名字} 的写法，渲染时逐个替换。
 */
import { DEFAULT_LOCALE } from './index.js'

/* 每种语言一张表。chs 是全量，其它语言缺的键由 fallback 补。 */
const TABLE = {
  chs: {
    title: '星天水镜', subtitle: '圣遗物评分',
    uidLabel: 'UID', load: '读取', fetch: '抓取', fetching: '抓取中…',
    fetchTip: '联网从 enka 重新抓一次', localeLabel: '语言',
    level: '等级', worldLevel: '世界等级',
    noData: '还没有数据。', noDataHint: '输入 UID 点「读取」（读本地库），或点「抓取」从 enka 现拉一份。',
    noScorable: '这个账号里没有可评分的角色。',
    noScorableHint: 'enka 只给角色展柜里的角色；也可能是 miao 元数据还不认识这些新角色。',
    readFail: '读不到 uid {uid}。', needUid: '先填一个 UID',
    fetchDone: '抓取完成：本次取得 {n} 个角色', fetchFail: '抓取失败：{msg}', fetchHardFail: '抓取失败。',
    panelSection: '面板属性', artiSection: '圣遗物',
    noWeapon: '无武器', cons: '命之座', fetter: '好感', talent: '天赋', refine: '精',
    mainStat: '主词条', notEquipped: '未装备',
    /* CLI 也用这张表 —— 命令行和网页不该各说各话 */
    account: '账号', data: '数据', weapon: '武器', sets: '套装', substat: '副',
    scene: '场景', summary: '汇总', chars: '个角色', fetched: '最后抓取',
    offline: '库中数据（未联网）', thisFetch: '本次取得', none: '（无）', notFound: '（未识别）',
    effTip: '副词条有效率 {eff}', notEffective: '非有效词条',
    total: '总分', footMeta: '{n} 个角色 · 语言 {loc} · 数据时间 {t}',
    footerNote: '评分内核来自 miao-plugin，分数与上游逐字一致',
    loading: '加载中…', reading: '读取本地库…', switching: '切换语言…',
    fetchingLong: '正在从 enka 抓取（可能需要十几秒）…',
    uidChipTip: '{n} 个角色 · 最后抓取 {t}',
    i18nMissing: '多语言表还没同步，只有中文可用。跑一次 tools/sync_i18n.py 就好。',
    metaFail: '拿不到服务信息：{msg}'
  },
  cht: {
    title: '星天水鏡', subtitle: '聖遺物評分',
    uidLabel: 'UID', load: '讀取', fetch: '抓取', fetching: '抓取中…',
    fetchTip: '連網從 enka 重新抓一次', localeLabel: '語言',
    level: '等級', worldLevel: '世界等級',
    noData: '還沒有資料。', noDataHint: '輸入 UID 點「讀取」（讀本地庫），或點「抓取」從 enka 現拉一份。',
    noScorable: '這個帳號裡沒有可評分的角色。',
    noScorableHint: 'enka 只給角色展櫃裡的角色；也可能是 miao 中繼資料還不認識這些新角色。',
    readFail: '讀不到 uid {uid}。', needUid: '先填一個 UID',
    fetchDone: '抓取完成：本次取得 {n} 個角色', fetchFail: '抓取失敗：{msg}', fetchHardFail: '抓取失敗。',
    panelSection: '面板屬性', artiSection: '聖遺物',
    noWeapon: '無武器', cons: '命之座', fetter: '好感', talent: '天賦', refine: '精',
    mainStat: '主詞條', notEquipped: '未裝備',
    /* CLI 也用這張表 —— 命令行和網頁不該各說各話 */
    account: '帳號', data: '資料', weapon: '武器', sets: '套裝', substat: '副',
    scene: '場景', summary: '彙總', chars: '個角色', fetched: '最後抓取',
    offline: '庫中資料（未聯網）', thisFetch: '本次取得', none: '（無）', notFound: '（未識別）',
    effTip: '副詞條有效率 {eff}', notEffective: '非有效詞條',
    total: '總分', footMeta: '{n} 個角色 · 語言 {loc} · 資料時間 {t}',
    footerNote: '評分核心來自 miao-plugin，分數與上游逐字一致',
    loading: '載入中…', reading: '讀取本地庫…', switching: '切換語言…',
    fetchingLong: '正在從 enka 抓取（可能需要十幾秒）…',
    uidChipTip: '{n} 個角色 · 最後抓取 {t}',
    i18nMissing: '多語言表還沒同步，只有中文可用。跑一次 tools/sync_i18n.py 就好。',
    metaFail: '拿不到服務資訊：{msg}'
  },
  en: {
    title: 'Seiten Suikyou', subtitle: 'Artifact Scoring',
    uidLabel: 'UID', load: 'Load', fetch: 'Fetch', fetching: 'Fetching…',
    fetchTip: 'Re-fetch from Enka Network', localeLabel: 'Language',
    level: 'Adventure', worldLevel: 'World',
    noData: 'No data yet.',
    noDataHint: 'Enter a UID and hit Load (reads the local database), or hit Fetch to pull fresh from Enka.',
    noScorable: 'No scorable characters in this account.',
    noScorableHint: 'Enka only exposes the characters you show in your profile; or miao metadata may not know these new characters yet.',
    readFail: 'Cannot read uid {uid}.', needUid: 'Enter a UID first',
    fetchDone: 'Fetched {n} characters', fetchFail: 'Fetch failed: {msg}', fetchHardFail: 'Fetch failed.',
    panelSection: 'Stats', artiSection: 'Artifacts',
    noWeapon: 'No weapon', cons: 'Constellation', fetter: 'Friendship', talent: 'Talents', refine: 'R',
    mainStat: 'Main', notEquipped: 'Not equipped',
    /* CLI uses this table too — terminal and page should not disagree */
    account: 'Account', data: 'Source', weapon: 'Weapon', sets: 'Sets', substat: 'Sub',
    scene: 'Scenario', summary: 'Summary', chars: 'characters', fetched: 'last fetch',
    offline: 'local database (offline)', thisFetch: 'fetched this run', none: '(none)', notFound: '(unknown)',
    effTip: 'Substat effectiveness {eff}', notEffective: 'Not a useful substat',
    total: 'Total', footMeta: '{n} characters · locale {loc} · fetched {t}',
    footerNote: 'Scoring core from miao-plugin — scores match upstream verbatim',
    loading: 'Loading…', reading: 'Reading local database…', switching: 'Switching language…',
    fetchingLong: 'Fetching from Enka Network (may take a dozen seconds)…',
    uidChipTip: '{n} characters · last fetch {t}',
    i18nMissing: 'Localization table not synced yet, only Chinese available. Run tools/sync_i18n.py once.',
    metaFail: 'Cannot reach service info: {msg}'
  },
  ja: {
    title: '星天水鏡', subtitle: '聖遺物スコア',
    uidLabel: 'UID', load: '読込', fetch: '取得', fetching: '取得中…',
    fetchTip: 'Enka Network から再取得する', localeLabel: '言語',
    level: '冒険ランク', worldLevel: '世界ランク',
    noData: 'データがまだありません。',
    noDataHint: 'UID を入力して「読込」（ローカル DB から）、または「取得」で Enka から新しく引きます。',
    noScorable: 'このアカウントには採点できるキャラがいません。',
    noScorableHint: 'Enka はプロフィール公開中のキャラしか返しません。miao のメタデータが新キャラ未対応の可能性もあります。',
    readFail: 'uid {uid} を読み込めません。', needUid: '先に UID を入力してください',
    fetchDone: '取得完了：今回 {n} キャラ', fetchFail: '取得失敗：{msg}', fetchHardFail: '取得失敗。',
    panelSection: 'ステータス', artiSection: '聖遺物',
    noWeapon: '武器なし', cons: '命ノ星座', fetter: '好感度', talent: '天賦', refine: '精錬',
    mainStat: 'メイン', notEquipped: '未装備',
    /* CLI もこのテーブルを使う —— コマンドラインとページで言い換えを増やさない */
    account: 'アカウント', data: 'ソース', weapon: '武器', sets: 'セット', substat: 'サブ',
    scene: 'シーン', summary: '集計', chars: 'キャラ', fetched: '最終取得',
    offline: 'ローカル DB（オフライン）', thisFetch: '今回取得', none: '（なし）', notFound: '（不明）',
    effTip: 'サブステータス有効率 {eff}', notEffective: '有効ステータスではありません',
    total: '総合', footMeta: '{n} キャラ · 言語 {loc} · 取得日時 {t}',
    footerNote: '採点コアは miao-plugin 由来、スコアは upstream と完全一致',
    loading: '読込中…', reading: 'ローカル DB を読み込み中…', switching: '言語を切り替え中…',
    fetchingLong: 'Enka Network から取得中（十数秒かかる場合があります）…',
    uidChipTip: '{n} キャラ · 最終取得 {t}',
    i18nMissing: '多言語テーブルが未同期のため中国語のみ表示します。tools/sync_i18n.py を一度実行してください。',
    metaFail: 'サービス情報の取得に失敗：{msg}'
  },
  ko: {
    title: '성천수경', subtitle: '성유물 점수',
    uidLabel: 'UID', load: '불러오기', fetch: '가져오기', fetching: '가져오는 중…',
    fetchTip: 'Enka Network에서 다시 가져오기', localeLabel: '언어',
    level: '모험 등급', worldLevel: '세계 레벨',
    noData: '아직 데이터가 없습니다.',
    noDataHint: 'UID를 입력하고 불러오기(로컬 DB)를 누르거나, 가져오기로 Enka에서 새로 받으세요.',
    noScorable: '이 계정에는 점수를 낼 수 있는 캐릭터가 없습니다.',
    noScorableHint: 'Enka는 프로필에 공개한 캐릭터만 제공합니다. miao 메타데이터가 신규 캐릭터를 모를 수도 있습니다.',
    readFail: 'uid {uid}를 읽을 수 없습니다.', needUid: 'UID를 먼저 입력하세요',
    fetchDone: '가져오기 완료: 캐릭터 {n}명', fetchFail: '가져오기 실패: {msg}', fetchHardFail: '가져오기 실패.',
    panelSection: '스탯', artiSection: '성유물',
    noWeapon: '무기 없음', cons: '운명의 자리', fetter: '호감도', talent: '특성', refine: '재련',
    mainStat: '주 옵션', notEquipped: '미장착',
    /* CLI도 이 표를 쓴다 —— 터미널과 페이지가 서로 다르게 말하면 안 된다 */
    account: '계정', data: '출처', weapon: '무기', sets: '세트', substat: '부옵션',
    scene: '시나리오', summary: '집계', chars: '캐릭터', fetched: '마지막 수집',
    offline: '로컬 DB(오프라인)', thisFetch: '이번 수집', none: '(없음)', notFound: '(미확인)',
    effTip: '부옵션 효율 {eff}', notEffective: '유효하지 않은 부옵션',
    total: '총점', footMeta: '캐릭터 {n}명 · 언어 {loc} · 수집 시각 {t}',
    footerNote: '점수 코어는 miao-plugin 기반, upstream과 점수가 글자 단위로 일치',
    loading: '불러오는 중…', reading: '로컬 DB 읽는 중…', switching: '언어 변경 중…',
    fetchingLong: 'Enka Network에서 가져오는 중(십여 초 걸릴 수 있음)…',
    uidChipTip: '캐릭터 {n}명 · 마지막 수집 {t}',
    i18nMissing: '다국어 표가 아직 동기화되지 않아 중국어만 표시됩니다. tools/sync_i18n.py를 한 번 실행하세요.',
    metaFail: '서비스 정보를 가져올 수 없음: {msg}'
  }
}

/* 回落顺序：要的语言 → 英文 → 中文。界面上出现英文好过出现空白。 */
function tableFor (locale) {
  return TABLE[locale] || TABLE.en || TABLE.chs
}

/**
 * 取一条界面文字，并把 {占位符} 换掉
 * @param {string} key
 * @param {string} locale 语言代码（已解析过或未解析都行，这里只做查表）
 * @param {object} vars    形如 { n: 3 }；值一律原样塞进去
 */
export function t (key, locale = DEFAULT_LOCALE, vars = null) {
  const row = tableFor(locale)
  let s = row[key] ?? TABLE.en?.[key] ?? TABLE.chs[key] ?? key
  if (vars) {
    for (const [k, v] of Object.entries(vars)) {
      s = s.split(`{${k}}`).join(String(v ?? ''))
    }
  }
  return s
}

/** 整张表给前端（前端一次拿全，切语言不用再问后端） */
export function all (locale = DEFAULT_LOCALE) {
  return { ...tableFor(locale) }
}

export default { t, all }

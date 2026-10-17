/*
 * ui —— 界面文字（按钮、分组标题、提示语）
 *
 * 与 names.json 的区别：那是**游戏内文案**（官方 TextMap 抽的，几千条、机器生成、跟着游戏版本走）；
 * 这里的界面文字官方表里根本没有（「刷新」「圣遗物」是我们自己页面的说法），只能手写。
 * 量不大（一百来条 × 5 种语言），就放在代码里，不值得再开一条同步管线。
 * 缺某门语言时回落到英文 —— 界面上出现英文总比出现空白好认。
 * 占位符写成 `{名字}`，渲染时逐个替换。
 *
 * 这张表只放数据；对外出口（认语言 + 与名字表合并）在 i18n.ts。
 */
import { DEFAULT_LOCALE } from './config.ts'

/* 每种语言一张表，chs 是全量、其它语言缺的键由 fallback 补。类型标成「语言 → 键 → 文字」：
   键不做字面量约束（chs 全量、别的语言是子集，逐键建联合得不偿失），只保证「查出来一定是 string」。 */
const TABLE: Record<string, Record<string, string>> = {
  chs: {
    title: '星天水镜', subtitle: '圣遗物评分',
    uidLabel: 'UID', fetch: '刷新', fetching: '刷新中…',
    fetchTip: '联网从 enka 刷新一次', localeLabel: '语言',
    level: '等级', worldLevel: '世界等级',
    noData: '还没有数据。', noDataHint: '输入 UID 回车读本地库，或点「刷新」从 enka 现拉一份。',
    noScorable: '这个账号里没有可评分的角色。',
    noScorableHint: 'enka 只给角色展柜里的角色；也可能是 miao 元数据还不认识这些新角色。',
    readFail: '读不到 uid {uid}。', needUid: '先填一个 UID',
    fetchDone: '刷新完成：本次取得 {n} 个角色', fetchFail: '刷新失败：{msg}', fetchHardFail: '刷新失败。',
    panelSection: '面板属性', artiSection: '圣遗物',
    noWeapon: '无武器', unknownWeapon: '未知武器', cons: '命之座', fetter: '好感', talent: '天赋', refine: '精',
    /* 卡片 hover 提示的标签。等级**不能复用 level** —— 那个键给的是顶部账号行的「冒险等阶」
       （en=Adventure、ja=冒険ランク），跟角色/武器等级不是一回事。 */
    tipLevel: '等级', tipScore: '评分', tipScoreTier: '评分等级', tipRefineTier: '精炼等级',
    talentA: '普攻', talentE: '战技', talentQ: '爆发',
    mainStat: '主词条', notEquipped: '未装备',
    back: '返回', tapToView: '点击查看',
    filterSearch: '搜索角色', noMatch: '没有符合筛选条件的角色。', filterTitle: '筛选',
    filterClear: '清空', filterPicked: '已选 {n} 项', filterActive: '筛选：已选 {n} 项',
    filterOk: '确定', filterCancel: '取消',
    viewWeapon: '武器', viewArtis: '圣遗物', noArtis: '无圣遗物',
    viewSwitchHint: '切换到：{next}',
    filterElem: '元素', filterRank: '评价等级', filterWeight: '评价权重',
    sortBy: '排序', sortLevel: '角色等级', sortScore: '评价等级', sortTime: '数据时间',
    sortMulti: '条件排序',
    sortAsc: '升序', sortDesc: '降序',
    sortAdd: '添加', sortRemove: '移除', sortUp: '上移', sortDown: '下移', sortHint: '按从上到下优先级排序，最多 3 项',
    detailTitle: '角色明细', artisRank: '圣遗物评级', artisTotal: '圣遗物总分',
    rule: '评分规则', scoredAt: '数据时间',
    /* 明细页下侧的伤害计算（miao 同款「伤害计算」表）。敌人名（'小宝'）与署名（'冰翼'）是
       内核 calc.js 给的中文串、不本地化（同 elemText 的处理）；句子本身按语言给。 */
    dmgSection: '伤害计算', dmgType: '伤害类型', dmgCrit: '暴击伤害', dmgAvg: '期望伤害',
    dmgBuff: 'Buff列表', dmgBuffTip: '部分Buff的触发条件以及层数可能影响实际伤害结果',
    dmgEnemy: '目标为{lv}级{name}', dmgSource: '伤害计算来源：',
    dmgLoading: '伤害计算中…', dmgFail: '伤害计算失败', dmgNone: '该角色暂无伤害计算',
    /* 上游出图这里还有半句「可使用 #角色名圣遗物 来查看评分详情」—— 那是 QQ 云崽的聊天指令
       （上游模板里写作 {{gameHash}}，渲染出来就是 #），网页版没有这个指令，照抄只会挂一个没头没尾的 #。 */
    artisNotice: '评分为<strong>喵喵版规则</strong>，仅供参考与娱乐。',
    /* CLI 也用这张表 —— 命令行和网页不该各说各话 */
    account: '账号', data: '数据', weapon: '武器', sets: '套装', substat: '副',
    scene: '场景', summary: '汇总', chars: '个角色', fetched: '最后抓取',
    offline: '库中数据（未联网）', thisFetch: '本次取得', none: '（无）', notFound: '（未识别）',
    effTip: '副词条有效率 {eff}', notEffective: '非有效词条',
    total: '总分',
    loading: '加载中…', reading: '读取本地库…', switching: '切换语言…',
    fetchingLong: '正在从 enka 刷新（可能需要十几秒）…',
    uidChipTip: '{n} 个角色 · 最后抓取 {t}',
    i18nMissing: '多语言表还没同步，只有中文可用。跑一次 tools/sync_i18n.py 就好。',
    metaFail: '拿不到服务信息：{msg}'
  },
  cht: {
    title: '星天水鏡', subtitle: '聖遺物評分',
    uidLabel: 'UID', fetch: '刷新', fetching: '刷新中…',
    fetchTip: '連網從 enka 刷新一次', localeLabel: '語言',
    level: '等級', worldLevel: '世界等級',
    noData: '還沒有資料。', noDataHint: '輸入 UID 按 Enter 讀本地庫，或點「刷新」從 enka 現拉一份。',
    noScorable: '這個帳號裡沒有可評分的角色。',
    noScorableHint: 'enka 只給角色展櫃裡的角色；也可能是 miao 中繼資料還不認識這些新角色。',
    readFail: '讀不到 uid {uid}。', needUid: '先填一個 UID',
    fetchDone: '刷新完成：本次取得 {n} 個角色', fetchFail: '刷新失敗：{msg}', fetchHardFail: '刷新失敗。',
    panelSection: '面板屬性', artiSection: '聖遺物',
    noWeapon: '無武器', unknownWeapon: '未知武器', cons: '命之座', fetter: '好感', talent: '天賦', refine: '精',
    tipLevel: '等級', tipScore: '評分', tipScoreTier: '評分等級', tipRefineTier: '精鍊等級',
    talentA: '普攻', talentE: '戰技', talentQ: '爆發',
    mainStat: '主詞條', notEquipped: '未裝備',
    back: '返回', tapToView: '點擊查看',
    filterSearch: '搜尋角色', noMatch: '沒有符合篩選條件的角色。', filterTitle: '篩選',
    filterClear: '清空', filterPicked: '已選 {n} 項', filterActive: '篩選：已選 {n} 項',
    filterOk: '確定', filterCancel: '取消',
    viewWeapon: '武器', viewArtis: '聖遺物', noArtis: '無聖遺物',
    viewSwitchHint: '切換到：{next}',
    filterElem: '元素', filterRank: '評價等級', filterWeight: '評價權重',
    sortBy: '排序', sortLevel: '角色等級', sortScore: '評價等級', sortTime: '資料時間',
    sortMulti: '條件排序',
    sortAsc: '升序', sortDesc: '降序',
    sortAdd: '添加', sortRemove: '移除', sortUp: '上移', sortDown: '下移', sortHint: '按從上到下優先級排序，最多 3 項',
    detailTitle: '角色明細', artisRank: '聖遺物評級', artisTotal: '聖遺物總分',
    rule: '評分規則', scoredAt: '資料時間',
    dmgSection: '傷害計算', dmgType: '傷害類型', dmgCrit: '暴擊傷害', dmgAvg: '期望傷害',
    dmgBuff: 'Buff列表', dmgBuffTip: '部分Buff的觸發條件以及層數可能影響實際傷害結果',
    dmgEnemy: '目標為{lv}級{name}', dmgSource: '傷害計算來源：',
    dmgLoading: '傷害計算中…', dmgFail: '傷害計算失敗', dmgNone: '該角色暫無傷害計算',
    artisNotice: '評分為<strong>喵喵版規則</strong>，僅供參考與娛樂。',
    account: '帳號', data: '資料', weapon: '武器', sets: '套裝', substat: '副',
    scene: '場景', summary: '彙總', chars: '個角色', fetched: '最後抓取',
    offline: '庫中資料（未聯網）', thisFetch: '本次取得', none: '（無）', notFound: '（未識別）',
    effTip: '副詞條有效率 {eff}', notEffective: '非有效詞條',
    total: '總分',
    loading: '載入中…', reading: '讀取本地庫…', switching: '切換語言…',
    fetchingLong: '正在從 enka 刷新（可能需要十幾秒）…',
    uidChipTip: '{n} 個角色 · 最後抓取 {t}',
    i18nMissing: '多語言表還沒同步，只有中文可用。跑一次 tools/sync_i18n.py 就好。',
    metaFail: '拿不到服務資訊：{msg}'
  },
  en: {
    title: 'Seiten Suikyou', subtitle: 'Artifact Scoring',
    uidLabel: 'UID', fetch: 'Refresh', fetching: 'Refreshing…',
    fetchTip: 'Refresh from Enka Network', localeLabel: 'Language',
    level: 'Adventure', worldLevel: 'World',
    noData: 'No data yet.',
    noDataHint: 'Type a UID and hit Enter (reads the local database), or hit Refresh to pull fresh from Enka.',
    noScorable: 'No scorable characters in this account.',
    noScorableHint: 'Enka only exposes the characters you show in your profile; or miao metadata may not know these new characters yet.',
    readFail: 'Cannot read uid {uid}.', needUid: 'Enter a UID first',
    fetchDone: 'Refreshed: {n} characters', fetchFail: 'Refresh failed: {msg}', fetchHardFail: 'Refresh failed.',
    panelSection: 'Stats', artiSection: 'Artifacts',
    noWeapon: 'No weapon', unknownWeapon: 'Unknown weapon', cons: 'Constellation', fetter: 'Friendship', talent: 'Talents', refine: 'R',
    tipLevel: 'Level', tipScore: 'Score', tipScoreTier: 'Score tier', tipRefineTier: 'Refinement rank',
    talentA: 'Normal', talentE: 'Skill', talentQ: 'Burst',
    mainStat: 'Main', notEquipped: 'Not equipped',
    back: 'Back', tapToView: 'Tap to view',
    filterSearch: 'Search characters', noMatch: 'No characters match the filter.', filterTitle: 'Filter',
    filterClear: 'Clear', filterPicked: '{n} selected', filterActive: 'Filter: {n} selected',
    filterOk: 'OK', filterCancel: 'Cancel',
    viewWeapon: 'Weapon', viewArtis: 'Artifacts', noArtis: 'No artifacts',
    viewSwitchHint: 'Switch to: {next}',
    filterElem: 'Element', filterRank: 'Rating tier', filterWeight: 'Rating weight',
    sortBy: 'Sort', sortLevel: 'Character level', sortScore: 'Score tier', sortTime: 'Data time',
    sortMulti: 'Multi-key',
    sortAsc: 'Ascending', sortDesc: 'Descending',
    sortAdd: 'Add', sortRemove: 'Remove', sortUp: 'Up', sortDown: 'Down', sortHint: 'Sorted by priority top to bottom, up to 3 conditions',
    detailTitle: 'Character Details', artisRank: 'Artifact Rank', artisTotal: 'Artifact Score',
    rule: 'Rule', scoredAt: 'Scored at',
    dmgSection: 'Damage', dmgType: 'Damage Type', dmgCrit: 'Critical Hit', dmgAvg: 'Expected',
    dmgBuff: 'Buff List', dmgBuffTip: 'Some buffs depend on trigger conditions and stack counts and may affect actual damage',
    dmgEnemy: 'Target: Lv.{lv} {name}', dmgSource: 'Damage source: ',
    dmgLoading: 'Calculating damage…', dmgFail: 'Damage calculation failed', dmgNone: 'No damage calculation for this character',
    /* 撇号直接写 ’（U+2019），别写 &rsquo; —— 这段文案走 createTextNode 渲染，HTML 实体没人解码，
       写实体会原样显示成「Miao&rsquo;s rules」 */
    artisNotice: 'Scores follow <strong>Miao’s rules</strong>, for reference and fun only.',
    account: 'Account', data: 'Source', weapon: 'Weapon', sets: 'Sets', substat: 'Sub',
    scene: 'Scenario', summary: 'Summary', chars: 'characters', fetched: 'last fetch',
    offline: 'local database (offline)', thisFetch: 'fetched this run', none: '(none)', notFound: '(unknown)',
    effTip: 'Substat effectiveness {eff}', notEffective: 'Not a useful substat',
    total: 'Total',
    loading: 'Loading…', reading: 'Reading local database…', switching: 'Switching language…',
    fetchingLong: 'Fetching from Enka Network (may take a dozen seconds)…',
    uidChipTip: '{n} characters · last fetch {t}',
    i18nMissing: 'Localization table not synced yet, only Chinese available. Run tools/sync_i18n.py once.',
    metaFail: 'Cannot reach service info: {msg}'
  },
  ja: {
    title: '星天水鏡', subtitle: '聖遺物スコア',
    uidLabel: 'UID', fetch: '更新', fetching: '更新中…',
    fetchTip: 'Enka Network から再更新する', localeLabel: '言語',
    level: '冒険ランク', worldLevel: '世界ランク',
    noData: 'データがまだありません。',
    noDataHint: 'UID を入力して Enter（ローカル DB から）、または「更新」で Enka から新しく引きます。',
    noScorable: 'このアカウントには採点できるキャラがいません。',
    noScorableHint: 'Enka はプロフィール公開中のキャラしか返しません。miao のメタデータが新キャラ未対応の可能性もあります。',
    readFail: 'uid {uid} を読み込めません。', needUid: '先に UID を入力してください',
    fetchDone: '更新完了：今回 {n} キャラ', fetchFail: '更新失敗：{msg}', fetchHardFail: '更新失敗。',
    panelSection: 'ステータス', artiSection: '聖遺物',
    noWeapon: '武器なし', unknownWeapon: '不明な武器', cons: '命ノ星座', fetter: '好感度', talent: '天賦', refine: '精錬',
    tipLevel: 'レベル', tipScore: 'スコア', tipScoreTier: 'スコアランク', tipRefineTier: '精錬ランク',
    talentA: '通常攻撃', talentE: '元素スキル', talentQ: '元素爆発',
    mainStat: 'メイン', notEquipped: '未装備',
    back: '戻る', tapToView: 'タップで表示',
    filterSearch: 'キャラを検索', noMatch: '条件に合うキャラがいません。', filterTitle: '絞り込み',
    filterClear: 'クリア', filterPicked: '{n} 件選択', filterActive: '絞り込み：{n} 件選択',
    filterOk: '決定', filterCancel: 'キャンセル',
    viewWeapon: '武器', viewArtis: '聖遺物', noArtis: '聖遺物なし',
    viewSwitchHint: '{next} に切り替え',
    filterElem: '元素', filterRank: '評価ランク', filterWeight: '評価ウェイト',
    sortBy: '並び替え', sortLevel: 'キャラレベル', sortScore: '評価ランク', sortTime: 'データ日時',
    sortMulti: '複数条件',
    sortAsc: '昇順', sortDesc: '降順',
    sortAdd: '追加', sortRemove: '削除', sortUp: '上へ', sortDown: '下へ', sortHint: '上から下へ優先順位、最大 3 項目',
    detailTitle: 'キャラ詳細', artisRank: '聖遺物評価', artisTotal: '聖遺物スコア',
    rule: '採点ルール', scoredAt: '取得日時',
    dmgSection: 'ダメージ計算', dmgType: 'ダメージ種類', dmgCrit: '会心ダメージ', dmgAvg: '期待値',
    dmgBuff: 'Buffリスト', dmgBuffTip: '一部のBuffは発動条件や重数により実際のダメージに影響する場合があります',
    dmgEnemy: '目標：Lv.{lv} {name}', dmgSource: 'ダメージ計算提供元：',
    dmgLoading: 'ダメージ計算中…', dmgFail: 'ダメージ計算に失敗しました', dmgNone: 'このキャラのダメージ計算はありません',
    artisNotice: 'スコアは<strong>喵喵版ルール</strong>に準拠した参考・娯楽用の値です。',
    account: 'アカウント', data: 'ソース', weapon: '武器', sets: 'セット', substat: 'サブ',
    scene: 'シーン', summary: '集計', chars: 'キャラ', fetched: '最終取得',
    offline: 'ローカル DB（オフライン）', thisFetch: '今回取得', none: '（なし）', notFound: '（不明）',
    effTip: 'サブステータス有効率 {eff}', notEffective: '有効ステータスではありません',
    total: '総合',
    loading: '読込中…', reading: 'ローカル DB を読み込み中…', switching: '言語を切り替え中…',
    fetchingLong: 'Enka Network から取得中（十数秒かかる場合があります）…',
    uidChipTip: '{n} キャラ · 最終取得 {t}',
    i18nMissing: '多言語テーブルが未同期のため中国語のみ表示します。tools/sync_i18n.py を一度実行してください。',
    metaFail: 'サービス情報の取得に失敗：{msg}'
  },
  ko: {
    title: '성천수경', subtitle: '성유물 점수',
    uidLabel: 'UID', fetch: '새로고침', fetching: '새로고침 중…',
    fetchTip: 'Enka Network에서 새로고침', localeLabel: '언어',
    level: '모험 등급', worldLevel: '세계 레벨',
    noData: '아직 데이터가 없습니다.',
    noDataHint: 'UID를 입력하고 Enter(로컬 DB)를 누르거나, 새로고침으로 Enka에서 새로 받으세요.',
    noScorable: '이 계정에는 점수를 낼 수 있는 캐릭터가 없습니다.',
    noScorableHint: 'Enka는 프로필에 공개한 캐릭터만 제공합니다. miao 메타데이터가 신규 캐릭터를 모를 수도 있습니다.',
    readFail: 'uid {uid}를 읽을 수 없습니다.', needUid: 'UID를 먼저 입력하세요',
    fetchDone: '새로고침 완료: 캐릭터 {n}명', fetchFail: '새로고침 실패: {msg}', fetchHardFail: '새로고침 실패.',
    panelSection: '스탯', artiSection: '성유물',
    noWeapon: '무기 없음', unknownWeapon: '알 수 없는 무기', cons: '운명의 자리', fetter: '호감도', talent: '특성', refine: '재련',
    tipLevel: '레벨', tipScore: '점수', tipScoreTier: '점수 등급', tipRefineTier: '재련 등급',
    talentA: '일반 공격', talentE: '원소 기술', talentQ: '원소 폭발',
    mainStat: '주 옵션', notEquipped: '미장착',
    back: '뒤로', tapToView: '탭하여 보기',
    filterSearch: '캐릭터 검색', noMatch: '조건에 맞는 캐릭터가 없습니다.', filterTitle: '필터',
    filterClear: '초기화', filterPicked: '{n}개 선택', filterActive: '필터: {n}개 선택',
    filterOk: '확인', filterCancel: '취소',
    viewWeapon: '무기', viewArtis: '성유물', noArtis: '성유물 없음',
    viewSwitchHint: '{next}(으)로 전환',
    filterElem: '원소', filterRank: '평가 등급', filterWeight: '평가 가중치',
    sortBy: '정렬', sortLevel: '캐릭터 레벨', sortScore: '평가 등급', sortTime: '데이터 시간',
    sortMulti: '다중 정렬',
    sortAsc: '오름차순', sortDesc: '내림차순',
    sortAdd: '추가', sortRemove: '제거', sortUp: '위로', sortDown: '아래로', sortHint: '위에서 아래로 우선순위, 최대 3개',
    detailTitle: '캐릭터 상세', artisRank: '성유물 등급', artisTotal: '성유물 점수',
    rule: '채점 규칙', scoredAt: '수집 시각',
    dmgSection: '피해 계산', dmgType: '피해 유형', dmgCrit: '치명타 피해', dmgAvg: '기대 피해',
    dmgBuff: '버프 목록', dmgBuffTip: '일부 버프는 발동 조건과 중첍에 따라 실제 피해에 영향을 줄 수 있습니다',
    dmgEnemy: '목표: Lv.{lv} {name}', dmgSource: '피해 계산 출처: ',
    dmgLoading: '피해 계산 중…', dmgFail: '피해 계산 실패', dmgNone: '이 캐릭터의 피해 계산 데이터가 없습니다',
    artisNotice: '점수는 <strong>喵喵 규칙</strong>을 따른 참고·오락용 값입니다.',
    account: '계정', data: '출처', weapon: '무기', sets: '세트', substat: '부옵션',
    scene: '시나리오', summary: '집계', chars: '캐릭터', fetched: '마지막 수집',
    offline: '로컬 DB(오프라인)', thisFetch: '이번 수집', none: '(없음)', notFound: '(미확인)',
    effTip: '부옵션 효율 {eff}', notEffective: '유효하지 않은 부옵션',
    total: '총점',
    loading: '불러오는 중…', reading: '로컬 DB 읽는 중…', switching: '언어 변경 중…',
    fetchingLong: 'Enka Network에서 새로고침 중(십여 초 걸릴 수 있음)…',
    uidChipTip: '캐릭터 {n}명 · 마지막 수집 {t}',
    i18nMissing: '다국어 표가 아직 동기화되지 않아 중국어만 표시됩니다. tools/sync_i18n.py를 한 번 실행하세요.',
    metaFail: '서비스 정보를 가져올 수 없음: {msg}'
  }
}

/**
 * 取一条界面文字，并把 {占位符} 换掉。查表顺序：要的语言 → 英文 → 中文（出现英文好过出现空白）。
 * `locale` 只用于查表（已解析或未解析都行）；`vars` 形如 `{ n: 3 }`，值一律原样塞进去。
 */
export function t (key: string, locale = DEFAULT_LOCALE, vars: Record<string, unknown> | null = null): string {
  let s = TABLE[locale]?.[key] ?? TABLE.en?.[key] ?? TABLE.chs[key] ?? key
  if (vars) {
    for (const [k, v] of Object.entries(vars)) {
      s = s.split(`{${k}}`).join(String(v ?? ''))
    }
  }
  return s
}

/** 整张表给前端（一次拿全，切语言不用再问后端） */
export function all (locale = DEFAULT_LOCALE): Record<string, string> {
  return { ...(TABLE[locale] || TABLE.en) }
}

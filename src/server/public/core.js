/*
 * 前端共享基座（core）—— 原生 ES 模块，无框架、无构建。
 *
 * 和后端的分工：后端负责「算什么、叫什么」，前端只负责「长什么样」——
 * 所以这里一个词条名都不写死，部位名/词条名/套装名全是后端按 locale 给好的文本。
 *
 * 本文件只放：全局状态 state、取文案 T()、DOM 小工具（el/setBg/rankOf…）、
 * 后端调用 api、视图切换（showView/backToRoster）、几个「跨模块编排函数」
 * （refreshRosterGrid/renderAll/openDetail/applyView）。编排函数通过 reg 注册表
 * 调用各 feature 模块注册进来的渲染器 —— 这样 core 不依赖任何 feature，零循环依赖。
 */

export const $ = (id) => document.getElementById(id)

/* ───────────────── 部署基址（只有前后端分开托管时才用得上） ─────────────────
   默认一台机器一个进程（npm run server 既给页面又给接口），地址写根绝对路径 /api/ 就完事。
   前端可以单独托管（比如丢到 GitHub Pages），那时要把接口指到另一台机器，填这里：
     API_BASE —— 接口基址。留空 = 跟页面同源（默认）。跨域部署时填后端地址，如 https://gs.example.com（末尾别带 /）。
   图片不用配：接口返回的就是相对路径（assets/...），浏览器按页面所在目录解析即可。
   基址在 index.html 的 <meta> 里改，改完刷新即可（前端文件每请求现读盘）。 */
const metaContent = (name) => document.querySelector(`meta[name="${name}"]`)?.content?.trim() || ''
/* 页面自己所在的目录（末尾带 /）。切语言、进明细页改写地址栏时用它拼 ——
   写根绝对路径（/?uid=…）在 Pages 那种 /<repo>/ 子路径部署下会被打回域名根，刷新即 404。 */
export const PAGE_BASE = new URL('.', document.baseURI).href
export const API_BASE = metaContent('api-base')

export const RANK_ORDER = ['MAX', 'ACE', 'SSS', 'SS', 'S', 'A', 'B', 'C', 'D']
export const SLOT_GLYPH = { 1: '花', 2: '羽', 3: '沙', 4: '杯', 5: '冠' }

/* 武器副属性在卡片上的短名，照抄 miao 模板里的 titleMap（profile-detail.html:233） */
export const W_ATTR_TITLE = {
  atkBase: '攻击', atkPct: '攻击', hpPct: '生命', defPct: '防御',
  mastery: '精通', dmg: '伤害', phy: '物伤',
  cpct: '暴击', cdmg: '爆伤', recharge: '充能', heal: '治疗', shield: '护盾'
}

export const state = {
  locale: 'chs',
  uid: null,
  view: null,
  selectedAvatarId: null,
  busy: false,
  ui: {},
  /* 首页「按属性权重筛选」的选项（{ key, label }），随语言从 /api/meta 拿 —— 前端不写死词条名 */
  weightOptions: [],
  /* 首页筛选：elem / rank / weight 各是一个数组 —— 每个维度都能多选
     （维度内 OR、维度间 AND：选了火+水又选 SSS，出的是「火或水里的 SSS」）。
     空数组 = 不限。
     空数组 = 不限。不持久化 —— 筛选是「在这份名单里找人」的临时动作。 */
  filter: { elem: [], rank: [], weight: [] },
  /* 首页卡片显示模式：weapon = 武器块（默认）/ artis = 圣遗物套装块 */
  rosterMode: 'weapon',
  /* 首页排序：key = level(角色等级) / mark(评价等级) / time(数据时间)；dir = asc|desc。
     默认按评价等级降序，和改之前「网格按评分从高到低」的表现一致。 */
  sort: [{ key: 'mark', dir: 'desc' }]
}

export const T = (key, vars) => {
  let s = state.ui[key] ?? key
  if (vars) for (const [k, v] of Object.entries(vars)) s = s.split(`{${k}}`).join(String(v ?? ''))
  return s
}

/*
 * 把文案里的 <strong> 段渲染成金色高亮（miao 的 arti-notice 就带这个标记）。
 * 只认这一种标签、且手工拼节点 —— 不走 innerHTML，省得给文案开注入的口子。
 */
export function richText (parent, text) {
  let last = 0
  for (const m of text.matchAll(/<strong>([\s\S]*?)<\/strong>/g)) {
    if (m.index > last) parent.append(document.createTextNode(text.slice(last, m.index)))
    parent.append(el('strong', '', m[1]))
    last = m.index + m[0].length
  }
  if (last < text.length) parent.append(document.createTextNode(text.slice(last)))
  return parent
}

/* ───────────────────────── 后端调用 ───────────────────────── */

/* 判断一个地址是不是「已经带协议/域名的完整网址」—— 是就别再补前缀了。
   为什么非得判一下：`uidApiUrl()` 拼出来的已经是完整地址，这里再补一次就成了
   `https://a.com https://a.com/api/...` 这种双前缀，fetch 直接抛「解析不了」。 */
const isAbsoluteUrl = (p) => /^(https?:)?\/\//.test(p)

export async function api (path, opts) {
  const res = await fetch(isAbsoluteUrl(path) ? path : API_BASE + path, opts)
  let body = null
  try { body = await res.json() } catch {}
  if (!res.ok || (body && body.ok === false)) {
    throw new Error(body?.error?.message || `HTTP ${res.status}`)
  }
  return body.data
}

/* 按当前语言取某个账号的接口地址（locale 一律跟 state.locale 走） */
export function uidApiUrl (uid) {
  return `${API_BASE}/api/uid/${uid}?locale=${encodeURIComponent(state.locale)}`
}

/* ───────────────────────── 提示条 ───────────────────────── */

let bannerTimer = null
export function banner (text, kind = '') {
  const el = $('banner')
  if (!text) { el.hidden = true; return }
  el.textContent = text
  el.className = 'banner' + (kind ? ' ' + kind : '')
  el.hidden = false
  clearTimeout(bannerTimer)
  if (kind !== 'err') bannerTimer = setTimeout(() => { el.hidden = true }, 4000)
}

/* ───────────────────────── 渲染工具 ───────────────────────── */

export function el (tag, cls, text) {
  const n = document.createElement(tag)
  if (cls) n.className = cls
  if (text !== undefined) n.textContent = text
  return n
}

/* 给元素铺一张背景图（没有图就不铺，让 CSS 的占位露出来） */
export function setBg (node, url) {
  if (url) node.style.backgroundImage = `url("${url}")`
  return node
}

export function rankOf (cls) {
  return RANK_ORDER.includes(cls) ? cls : 'D'
}

/*
 * 名字拿不到时用什么词，看后端给的 weapon.state：
 *   'none'    角色真没装备武器        → 「无武器」
 *   'unknown' 装备了但元数据不认识这把 → 「未知武器」
 * 只负责兜底，名字本身仍由调用点给（首页用全名、明细页 sName 优先，两处优先级不一样）。
 * 别写成 `name || T('noWeapon')` —— 那把「装备了但不认识」也报成没武器。
 */
export function weaponFallback (w) {
  return T(w?.state === 'unknown' ? 'unknownWeapon' : 'noWeapon')
}

/* 词条按权重分三档，和 miao 卡片里「有效/无效词条」的高亮规则一致 */
export function weightClass (w) {
  return w > 79.9 ? 'great' : (w > 0 ? 'useful' : 'nouse')
}

export const slotGlyph = (pos) => SLOT_GLYPH[pos] || '?'

/* 图片加载失败时隐藏自己，让 CSS 占位露出来 */
export function imgError (img) { img.style.display = 'none' }

/* ───────────────────────── 视图切换 ───────────────────────── */

export function showView (name) {
  const onDetail = name === 'detail'
  $('view-roster').classList.toggle('active', name === 'roster')
  $('view-detail').classList.toggle('active', onDetail)
  /* 明细页把整条顶栏收掉（CSS 侧：body.on-detail .top { display:none }）。
     UID 框 / 刷新 / 语言在这儿一个都用不上，留着只是把 600px 画布往下顶，
     还把页面上唯一的退出入口「← 返回」压成次要信息。切回首页再放出来 ——
     语言切换只在首页做，明细页不带这一排。 */
  document.body.classList.toggle('on-detail', onDetail)
  window.scrollTo({ top: 0, behavior: 'smooth' })
}

export function backToRoster () {
  state.selectedAvatarId = null
  showView('roster')
}

/* ───────────────────────── 下拉面板通用 ───────────────────────── */

/* 收面板的唯一入口：点面板外面、按 Esc、选了选项，都走这里 */
export function closeMenus () {
  for (const dd of document.querySelectorAll('.rf-dd.open')) dd.classList.remove('open')
}

/* ───────────────────────── 弹窗通用（筛选 / 排序共用） ─────────────────────────
 * 两处都是「点开一个大框、在里面勾完再确定」，壳子只写一份：
 * 遮罩 + 头（标题 + ×）+ 可滚内容区 + 底（可选清空 / 计数 / 取消 / 确定）。
 *
 * 三条规矩：
 * ① 同时只允许一个弹窗 —— 换 UID 重画、再点按钮，都先把旧的收掉（openDialog 开头做）。
 * ② Esc / 点遮罩 / 取消 = **丢弃**（什么都不写回）；确定才写回。
 * ③ 确定时**先关窗再回调**：回调里重画网格，开着窗重画会让窗后的内容和窗本身一起闪。 */

let openModal = null
let escHandler = null

export function closeModal () {
  if (!openModal) return
  openModal.remove()
  openModal = null
  if (escHandler) {
    removeEventListener('keydown', escHandler)
    escHandler = null
  }
}

/**
 * 开一个弹窗，返回 { body, count, close } —— 内容由调用方自己往 body 里塞。
 * onOk 在关窗之后调用；onClear 给了就在左下角出「清空」钮。
 */
export function openDialog ({ title, onOk, onClear }) {
  closeModal()

  const mask = el('div', 'rf-mask')
  const modal = el('div', 'rf-modal')
  modal.setAttribute('role', 'dialog')
  modal.setAttribute('aria-modal', 'true')

  const head = el('div', 'rf-modal-head')
  head.append(el('span', 'rf-modal-title', title))
  const x = el('button', 'rf-modal-x')
  x.type = 'button'
  x.textContent = '×'
  x.title = T('filterCancel')
  x.addEventListener('click', () => closeModal())
  head.append(x)

  const body = el('div', 'rf-modal-body')

  const foot = el('div', 'rf-modal-foot')
  const count = el('span', 'rf-fpanel-count')
  let clear = null
  if (onClear) {
    clear = el('button', 'rf-fpanel-clear')
    clear.type = 'button'
    clear.textContent = T('filterClear')
    clear.addEventListener('click', onClear)
    foot.append(clear)
  }
  foot.append(count)
  const actions = el('div', 'rf-modal-actions')
  const cancel = el('button', 'rf-btn')
  cancel.type = 'button'
  cancel.textContent = T('filterCancel')
  cancel.addEventListener('click', () => closeModal())
  const ok = el('button', 'rf-btn primary')
  ok.type = 'button'
  ok.textContent = T('filterOk')
  ok.addEventListener('click', () => { closeModal(); onOk?.() })
  actions.append(cancel, ok)
  foot.append(actions)

  modal.append(head, body, foot)
  mask.append(modal)
  /* 点在遮罩上（而不是弹窗里）= 取消 */
  mask.addEventListener('click', e => { if (e.target === mask) closeModal() })
  document.body.append(mask)

  openModal = mask
  escHandler = (e) => { if (e.key === 'Escape') closeModal() }
  addEventListener('keydown', escHandler)
  ok.focus()
  return { modal, body, count, clear, close: closeModal }
}

/* 只在模块加载时装一次 —— 放进 renderFilterBar 会每重绘一次叠一个监听。
   closest 判「点在不在某个下拉里」：点按钮本身也算在里面，交给按钮自己的 toggle 处理。 */
addEventListener('click', e => { if (!e.target?.closest('.rf-dd')) closeMenus() })
addEventListener('keydown', e => { if (e.key === 'Escape') closeMenus() })

/* ───────────────────────── 首页筛选的候选计算 ─────────────────────────
 * 这几个只吃 state + 名单，放在 core 避免 filter↔sort 互相 import 成环。 */

/* 筛选项的排列顺序：游戏内图鉴的元素顺序（火水风雷草冰岩），不按数据出现顺序排。
   旅行者的 elem 是 multi，不在七元素里 —— 他不会有自己的筛选项，
   但「不限」时照常出现在网格里。 */
export const ELEM_ORDER = ['pyro', 'hydro', 'anemo', 'electro', 'dendro', 'cryo', 'geo']

export function rosterElems (view) {
  const have = new Set(view.avatars.map(a => a.elem))
  return ELEM_ORDER.filter(e => have.has(e))
}

/* 等级只列名单里真有人拿到过的档位 —— 摆一排点了也是空的档位没有意义 */
export function rosterRanks (view) {
  return RANK_ORDER.filter(r => view.avatars.some(a => a.score.markClass === r))
}

/* 换了 UID 之后，旧条件可能在这份名单里根本不存在 —— 那时 chips 全不激活、
   网格却是空的，看着像 bug。不成立的值就地剔除，整组空了就是「不限」。
   多选版：把每个维度里不在候选中的值过滤掉（原来单值版是直接清空整键）。 */
export function dropStaleFilter (key, values) {
  state.filter[key] = state.filter[key].filter(v => values.includes(v))
}

/* ───────────────────────── URL / 加载态 ───────────────────────── */

export function syncUrl () {
  const q = new URLSearchParams()
  if (state.uid) q.set('uid', state.uid)
  if (state.locale) q.set('locale', state.locale)
  if (state.selectedAvatarId && $('view-detail').classList.contains('active')) q.set('char', state.selectedAvatarId)
  history.replaceState(null, '', q.toString() ? `${PAGE_BASE}?${q}` : PAGE_BASE)
}

export function showLoading (text) {
  const box = $('view-roster')
  box.innerHTML = ''
  const wrap = el('div', 'loading')
  wrap.append(el('div', 'spin'), el('div', '', text ?? T('loading')))
  box.append(wrap)
}

/* ───────────────────────── 注册表 + 编排函数 ─────────────────────────
 * feature 模块在加载时把自己的渲染器写进 reg；编排函数只在运行时读 reg，
 * 因此 core 在求值期不触碰任何 feature（零循环依赖）。 */

export const reg = {}

/* 只重画网格那一块（筛选/排序点了之后），不重建筛选栏 —— 重建会把下拉选中态和展开态冲掉 */
export function refreshRosterGrid () {
  const slot = document.querySelector('#view-roster .rf-grid')
  if (slot) reg.renderRosterGrid?.(slot)
}

export function renderAll () {
  reg.renderRoster?.()
  reg.renderDetail?.()
}

export function openDetail (avatarId) {
  state.selectedAvatarId = avatarId
  reg.renderDetail?.()
  showView('detail')
}

/* 新数据到手后统一走这里：记地址、重画、回首页 */
export function applyView (view) {
  state.view = view
  syncUrl()
  renderAll()
  showView('roster')
}

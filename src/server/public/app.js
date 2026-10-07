/*
 * 页面逻辑 —— 原生 JS，移动优先，不引框架
 *
 * 结构：首页（账号头 + 筛选条 + 角色网格）→ 点击卡片 → 角色明细页。
 * PC 上也做成手机风格：顶栏/主容器/页脚都收在同一条 --app-width 内容带里居中。
 *
 * 和后端的分工：后端负责「算什么、叫什么」，前端只负责「长什么样」——
 * 所以这里一个词条名都不写死，部位名/词条名/套装名全是后端按 locale 给好的文本。
 */

const $ = (id) => document.getElementById(id)

const RANK_ORDER = ['MAX', 'ACE', 'SSS', 'SS', 'S', 'A', 'B', 'C', 'D']
/* 首页卡片角标的档位色。这是 `miao.css` 里 .mark-* 那一套的 JS 副本 ——
   那边是 CSS（明细页/圣遗物卡），这里是 JS（首页角标在渲染时上色），改一边要同步改另一边。
 * 档位配色：灰(D) → 白(C) → 冰蓝(B) → 天蓝(A) → 绿(S) → 梅紫(SS) → 金(SSS) → 橙(ACE) → 正红(MAX)。
 * 九档要九个色，一个都不许重。
 * ⚠️ SS 的紫偏偏要**避开普通紫**：四星角色卡底色就是紫（bg4.png 主色 #8a6ab0），角标压在它上面，
 *   用 #b07ae8 那种正紫会和底色同色相（差 2°）糊成一片。现在这个 #ef8ce0 偏粉，色相差 42°。
 */
const RANK_COLOR = {
  MAX: '#ec2b2b', ACE: '#ff9f2e', SSS: '#ffe066', SS: '#ef8ce0',
  S: '#5fd48f', A: '#4fb0ee', B: '#a9d8ff', C: '#ffffff', D: '#6b7280'
}
const SLOT_GLYPH = { 1: '花', 2: '羽', 3: '沙', 4: '杯', 5: '冠' }

/* 武器副属性在卡片上的短名，照抄 miao 模板里的 titleMap（profile-detail.html:233） */
const W_ATTR_TITLE = {
  atkBase: '攻击', atkPct: '攻击', hpPct: '生命', defPct: '防御',
  mastery: '精通', dmg: '伤害', phy: '物伤',
  cpct: '暴击', cdmg: '爆伤', recharge: '充能', heal: '治疗', shield: '护盾'
}

const state = {
  locale: 'chs',
  uid: null,
  view: null,
  selectedAvatarId: null,
  busy: false,
  ui: {},
  /* 首页筛选：q = 名称搜索串（大小写不敏感），elem = 元素 key（'' = 不限）。
     不持久化 —— 筛选是「在这份名单里找人」的临时动作，下次进来还停在旧条件上反而碍事。 */
  filter: { q: '', elem: '' }
}

const T = (key, vars) => {
  let s = state.ui[key] ?? key
  if (vars) for (const [k, v] of Object.entries(vars)) s = s.split(`{${k}}`).join(String(v ?? ''))
  return s
}

/*
 * 把文案里的 <strong> 段渲染成金色高亮（miao 的 arti-notice 就带这个标记）。
 * 只认这一种标签、且手工拼节点 —— 不走 innerHTML，省得给文案开注入的口子。
 */
function richText (parent, text) {
  const re = /<strong>([\s\S]*?)<\/strong>/g
  let last = 0
  let m
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) parent.append(document.createTextNode(text.slice(last, m.index)))
    parent.append(el('strong', '', m[1]))
    last = m.index + m[0].length
  }
  if (last < text.length) parent.append(document.createTextNode(text.slice(last)))
  return parent
}

/* ───────────────────────── 后端调用 ───────────────────────── */

async function api (path, opts) {
  const res = await fetch(path, opts)
  let body = null
  try { body = await res.json() } catch {}
  if (!res.ok || (body && body.ok === false)) {
    throw new Error(body?.error?.message || `HTTP ${res.status}`)
  }
  return body.data
}

/* ───────────────────────── 提示条 ───────────────────────── */

let bannerTimer = null
function banner (text, kind = '') {
  const el = $('banner')
  if (!text) { el.hidden = true; return }
  el.textContent = text
  el.className = 'banner' + (kind ? ' ' + kind : '')
  el.hidden = false
  clearTimeout(bannerTimer)
  if (kind !== 'err') bannerTimer = setTimeout(() => { el.hidden = true }, 4000)
}

/* ───────────────────────── 渲染工具 ───────────────────────── */

function el (tag, cls, text) {
  const n = document.createElement(tag)
  if (cls) n.className = cls
  if (text !== undefined) n.textContent = text
  return n
}

/* 给元素铺一张背景图（没有图就不铺，让 CSS 的占位露出来） */
function setBg (node, url) {
  if (url) node.style.backgroundImage = `url("${url}")`
  return node
}

function rankOf (cls) {
  return RANK_ORDER.includes(cls) ? cls : 'D'
}

/*
 * 名字拿不到时用什么词，看后端给的 weapon.state：
 *   'none'    角色真没装备武器        → 「无武器」
 *   'unknown' 装备了但元数据不认识这把 → 「未知武器」
 * 只负责兜底，名字本身仍由调用点给（首页用全名、明细页 sName 优先，两处优先级不一样）。
 * 别写成 `name || T('noWeapon')` —— 那把「装备了但不认识」也报成没武器。
 */
function weaponFallback (w) {
  return T(w?.state === 'unknown' ? 'unknownWeapon' : 'noWeapon')
}

function rankColor (rank) {
  return RANK_COLOR[rank] || '#e8edf4'
}

/* 词条按权重分三档，和 miao 卡片里「有效/无效词条」的高亮规则一致 */
function weightClass (w) {
  return w > 79.9 ? 'great' : (w > 0 ? 'useful' : 'nouse')
}

const slotGlyph = (pos) => SLOT_GLYPH[pos] || '?'

/* 图片加载失败时隐藏自己，让 CSS 占位露出来 */
function imgError (img) { img.style.display = 'none' }

/* ───────────────────────── 视图切换 ───────────────────────── */

function showView (name) {
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

function backToRoster () {
  state.selectedAvatarId = null
  showView('roster')
}

/* 新数据到手后统一走这里：记地址、重画、回首页 */
function applyView (view) {
  state.view = view
  syncUrl()
  renderAll()
  showView('roster')
}

/* ───────────────────────── 首页：账号头 + 筛选条 + 网格 ───────────────────────── */

function renderAccountHeader (acct) {
  const box = el('div', 'acct-header')
  if (!acct) return box

  box.append(el('div', 'acct-nick', acct.nickname || `UID ${acct.uid}`))
  if (acct.signature) box.append(el('div', 'acct-sig', acct.signature))

  const meta = el('div', 'acct-meta')
  for (const [label, value] of [[T('level'), acct.level], [T('worldLevel'), acct.worldLevel], ['UID', acct.uid]]) {
    const d = el('div')
    d.append(el('b', '', value ?? '—'))
    d.append(el('span', '', label))
    meta.append(d)
  }
  box.append(meta)
  return box
}

/*
 * 首页的一张角色卡 —— 照原魔工具箱「角色展柜」中间那块做的。
 *
 * 它跟明细页是两种东西：明细页是 miao 那张**出图**，要 1:1；首页是**列表**，
 * 只借它的视觉语言（星级底色 / 半透明分数带 / 白色等级条 / 元素图标），
 * 所以这里不照抄 miao 的任何 CSS。
 *
 * 一条铁律：**不显示角色名**（名字只在 hover 提示和明细页里出现）。既然版面上一个名字都没有，
 * 提示就是唯一的「认人」入口，得**分两块挂**：画像区报角色那四项，武器块报武器那三项 ——
 * 整卡挂一个提示的话，鼠标停在武器上却报角色等级，答非所问。
 *
 * 卡片两段：ⓐ 画像区（四个角：元素图标 / 等级 / 评分 / 评级）ⓑ 武器块（白底）。
 * 分数不再单独占一条通栏黑带（黑带 + 白条上下叠会把卡片切成四段，太重），
 * 但它自己那块半透明黑底不能省 —— 星级橙底/紫底上奶白字不垫底看不清（见 style.css 的 .cc-score）。
 */
function renderCharCard (av) {
  const rank = rankOf(av.score.markClass)
  const card = el('div', 'char-card')

  const bg = setBg(el('div', 'cc-bg'), av.rarityBg)

  const face = el('img', 'cc-face')
  face.src = av.imgs?.face || av.splash
  face.alt = ''
  face.loading = 'lazy'
  face.onerror = () => imgError(face)

  const elem = el('img', 'cc-elem')
  elem.src = av.elemIcon
  elem.alt = av.elemText || ''
  elem.onerror = () => imgError(elem)

  const lv = el('div', 'cc-lv', `Lv.${av.level ?? '?'}`)
  const score = el('div', 'cc-score', av.score.mark)
  const badge = el('span', 'cc-rank', rank)
  badge.style.color = rankColor(rank)

  const top = el('div', 'cc-top')
  top.append(bg, face, elem, lv, score, badge)
  /* 画像区提示：只报这个人自己的四项，不掺武器 */
  top.title = [
    av.name,
    `${T('tipLevel')} ${av.level ?? '?'}`,
    `${T('tipScore')} ${av.score.mark}`,
    `${T('tipScoreTier')} ${rank}`
  ].join(' · ')

  /* 武器块：白底。没武器（或 miao 不认识这把）也要出这一块，整排高度才整齐。
     左边图标一整栏、右边名字 + 等级·精炼两行 —— 短名字也不会在底部空出一块。 */
  const wName = av.weapon?.name || weaponFallback(av.weapon)
  const wText = el('div', 'cc-wtext')
  wText.append(el('strong', '', wName))

  /* 等级 · 精炼跟在名字下面，中间那个「·」由 CSS 补 */
  const meta = el('div', 'cc-wmeta')
  if (av.weapon?.level) meta.append(el('b', '', `Lv.${av.weapon.level}`))
  if (av.weapon?.affix) meta.append(el('b', 'refine', `${T('refine')}${av.weapon.affix}`))
  wText.append(meta)

  const wp = el('div', 'cc-weapon')
  wp.append(setBg(el('div', 'cc-wicon'), av.weapon?.icon), wText)
  /* 武器区提示：只报这把武器。没武器时只剩「无武器」一个词，不再补空字段 */
  const wTip = [wName]
  if (av.weapon?.level) wTip.push(`${T('tipLevel')} ${av.weapon.level}`)
  if (av.weapon?.affix) wTip.push(`${T('tipRefineTier')} ${av.weapon.affix}`)
  wp.title = wTip.join(' · ')

  card.append(top, wp)
  card.addEventListener('click', () => openDetail(av.avatarId))
  return card
}

function renderRoster () {
  const view = state.view
  const box = $('view-roster')
  box.innerHTML = ''

  /* 原来这儿有个「角色大全」的 h2。它是账号头上面孤零零一行大字，
     而账号头里已经有昵称/签名/等级这一整套身份信息，下面紧接着就是筛选条 ——
     标题夹在中间既没有新增信息，又把首屏往下推了一行。删掉（2026-10-07）。 */
  box.append(renderAccountHeader(view?.account))

  /* 页脚只报「数据时间」。写在这里（早退之前）：没角色可评时卡片不画，
     但时间得跟着当前这份数据走，不能停在上一个 UID 的时刻上。 */
  $('footmeta').textContent = `${T('scoredAt')} ${view?.fetchedAt || '—'}`

  if (!view || !view.avatars.length) {
    const ph = el('div', 'placeholder')
    ph.append(el('p', '', T('noScorable')), el('p', 'dim', T('noScorableHint')))
    box.append(ph)
    return
  }

  box.append(renderFilterBar(view))
  const slot = el('div', 'rf-grid')
  box.append(slot)
  renderRosterGrid(slot)
}

/* ───────────────────────── 首页：筛选条 ─────────────────────────
 *
 * 名称搜索框 + 元素 chips。两条规则：
 * ① 筛选只重画网格那一块（refreshRosterGrid），不重建整条筛选栏 ——
 *    重建会把搜索框的焦点和光标位置一起冲掉，每敲一个字焦点丢一次。
 * ② 元素图标/元素名都从名单里已有角色的 elemIcon / elemText 借，
 *    前端不自己拼 /assets 路径（和卡片一个规矩：URL 一律后端下发）。
 */

/* 筛选项的排列顺序：游戏内图鉴的元素顺序（火水风雷草冰岩），不按数据出现顺序排。
   旅行者的 elem 是 multi，不在七元素里 —— 他不会有自己的筛选项，
   但「不限」时照常出现在网格里。 */
const ELEM_ORDER = ['pyro', 'hydro', 'anemo', 'electro', 'dendro', 'cryo', 'geo']

function rosterElems (view) {
  const have = new Set(view.avatars.map(a => a.elem))
  return ELEM_ORDER.filter(e => have.has(e))
}

function renderFilterBar (view) {
  const bar = el('div', 'roster-filter')

  const search = el('input', 'rf-search')
  search.type = 'search'
  search.placeholder = T('filterSearch')
  search.value = state.filter.q
  search.addEventListener('input', () => {
    state.filter.q = search.value
    refreshRosterGrid()
  })
  bar.append(search)

  const chips = el('div', 'rf-elems')
  /* 激活态只改 class，不重建 chips —— 和搜索框同一个理由 */
  const paint = () => {
    for (const c of chips.children) c.classList.toggle('active', c.dataset.elem === state.filter.elem)
  }
  const pick = (e) => {
    /* 再点一次已激活的 chip = 取消筛选，回到「全部」 */
    state.filter.elem = state.filter.elem === e ? '' : e
    paint()
    refreshRosterGrid()
  }

  const elems = rosterElems(view)
  /* 换了 UID 之后，旧的元素条件可能在这份名单里根本不存在 —— 那时一个 chip 都不激活、
     网格却是空的，看着像 bug。条件不成立就地清空，回到「全部」。 */
  if (state.filter.elem && !elems.includes(state.filter.elem)) state.filter.elem = ''

  const all = el('button', 'rf-elem rf-all', T('filterAll'))
  all.type = 'button'
  all.dataset.elem = ''
  all.addEventListener('click', () => pick(''))
  chips.append(all)

  for (const e of elems) {
    const src = view.avatars.find(a => a.elem === e)
    const c = el('button', 'rf-elem')
    c.type = 'button'
    c.dataset.elem = e
    c.title = src?.elemText || e
    const img = el('img')
    img.src = src?.elemIcon || ''
    img.alt = src?.elemText || e
    img.onerror = () => imgError(img)
    c.append(img)
    c.addEventListener('click', () => pick(e))
    chips.append(c)
  }
  paint()
  bar.append(chips)
  return bar
}

function filteredAvatars (view) {
  const q = state.filter.q.trim().toLowerCase()
  const e = state.filter.elem
  return view.avatars
    .filter(a => !e || a.elem === e)
    /* name 是当前语言的，nameZh 恒为中文 —— 英文页也允许直接敲中文名找人 */
    .filter(a => !q || (a.name || '').toLowerCase().includes(q) || (a.nameZh || '').toLowerCase().includes(q))
}

function renderRosterGrid (slot) {
  slot.innerHTML = ''
  const list = filteredAvatars(state.view)
  if (!list.length) {
    slot.append(el('div', 'placeholder', T('noMatch')))
    return
  }
  const sorted = [...list].sort((a, b) => b.score.markValue - a.score.markValue)
  const grid = el('div', 'char-grid')
  for (const av of sorted) grid.append(renderCharCard(av))
  slot.append(grid)
}

function refreshRosterGrid () {
  const slot = document.querySelector('#view-roster .rf-grid')
  if (slot) renderRosterGrid(slot)
}

/* ─────────────────────────
 * 明细页：miao-plugin 的评分结果图（profile-detail）复刻
 *
 * 那张结果图在 miao 那边是**一张固定 600px 宽的画布**，所以这里也照 600px 做，
 * 再由 fitDetailZoom() 整张等比缩到屏幕宽度 —— 缩下来就是同一张图的缩小版。
 *
 * 结构照抄上游，不自己发明：
 *   .basic            立绘（1400×500 左溢出）+ 右上角浮信息（名字/UID-Lv/天赋/属性表）+ 命座 + 数据时间
 *   .arti-mark-cont   左：总分 + 评级；右：有效词条汇总 + 评分规则
 *   .artis            武器卡 + 5 件圣遗物卡（185px 宽，一格一个）
 * ───────────────────────── */

function renderDetail () {
  const box = $('view-detail')
  box.innerHTML = ''

  const av = state.view?.avatars.find(a => a.avatarId === state.selectedAvatarId)
  if (!av) {
    box.append(el('div', 'placeholder', T('noData')))
    return
  }

  /* 顶部返回栏：画布之外，不跟着缩放 */
  const bar = el('div', 'detail-bar')
  const back = el('button', 'btn back', '← ' + T('back'))
  back.addEventListener('click', backToRoster)
  /* 原来右边还挂了个角色名（.detail-title）。名字在下面 600px 画布最顶上写了更大一号，
     这儿再来一遍是重复，而且灰色小字跟金色按钮挨着，视觉上把按钮的分量分走了一半 ——
     删掉，让「← 返回」独占这一行（2026-10-07）。 */
  bar.append(back)
  box.append(bar)

  /* 600px 画布。元素类名照 miao 的 elemLayout 挂在容器上，CSS 据此选背景图 */
  const canvas = setBg(el('div', 'pd-canvas elem-' + (av.elem || 'hydro')), av.elemBg)
  const cont = el('div', 'profile-cont game-gs')
  const frame = el('div', 'pd-frame')
  canvas.append(cont)
  frame.append(canvas)
  box.append(frame)

  /* ===== .basic ===== */
  const basic = el('div', 'basic')
  basic.append(setBg(el('div', 'main-pic'), av.splash))

  const detail = el('div', 'detail')
  detail.append(el('div', 'char-name', av.name))

  const lvRow = el('div', 'char-lv')
  lvRow.append(el('span', '', `UID ${av.uid} - Lv.${av.level ?? '?'}`))
  lvRow.append(el('span', 'cons-badge', `${av.cons}${T('cons')}`))
  detail.append(lvRow)

  /* 天赋 a/e/q：图标 + 等级牌。talent-plus = 被命座提升过，talent-crown = 原始等级满 10 —— 判定来自后端 */
  const talents = el('div', 'char-talents')
  for (const k of ['a', 'e', 'q']) {
    const t = av.talent?.[k] || {}
    const icon = el('div', 'talent-icon' + (t.plus ? ' talent-plus' : '') + (t.crown ? ' talent-crown' : ''))
    icon.append(setBg(el('div', 'talent-icon-img'), av.imgs?.[k]))
    icon.append(el('strong', '', String(t.level ?? 0)))
    const item = el('div', 'talent-item')
    item.append(icon)
    talents.append(item)
  }
  detail.append(talents)

  /* 面板属性表：图标 + 名称 + 权重胶囊 + 总值 +（基础值 / 绿字） */
  if (av.attrTable?.length) {
    /* attr-tall：面板超过 8 行时给 .basic 加一条 class 撑开底部空间。
       面板的 7 个固定项之外，dmg/phy/heal 是**按需出行**的（见 shape.js 的 DMG_ATTRS），
       所以行数在 8~9 之间浮动。9 行时右侧信息列会顶进下方评分卡（实测压 1px）。
       以前用 CSS 的 min-height 解决，那会给只有 8 行的角色凭空多留一块空白 ——
       改成「按需」：只有真的多出一行时才撑。 */
    const tall = av.attrTable.length > 8 ? ' attr-tall' : ''
    const ul = el('ul', 'char-attr' + tall)
    for (const r of av.attrTable) {
      const li = el('li')
      const ic = el('div', 'icon')
      /* 图标类名默认就是属性 key，只有元素伤害那行会被后端换成具体元素（.i-pyro / .i-cryo …）
         —— 因为图标是一属性一张独立 SVG，没有「通用元素伤害」那张，只有七元素各自的。 */
      ic.append(el('i', 'i-' + (r.iconKey || r.key)))
      li.append(ic, el('div', 'title', r.label))
      const wt = el('div', 'weight')
      /* 权重 0 的项 miao 也留空位，保持列对齐 */
      if (r.weight) wt.append(el('span', r.weight >= 80 ? 'gold' : 'normal', String(r.weight)))
      li.append(wt, el('div', 'value', r.value))
      const v2 = el('div', 'value2')
      v2.append(el('span', 'base' + (r.baseZero ? ' zero' : ''), r.base))
      v2.append(el('span', 'plus', '+' + r.plus))
      li.append(v2)
      ul.append(li)
    }
    detail.append(ul)
  }
  basic.append(detail)

  /* 命座 6 格：未点亮的置灰（.off） */
  const cons = el('div', 'char-cons')
  for (let i = 1; i <= 6; i++) {
    const icon = el('div', 'talent-icon' + (i <= (av.cons ?? 0) ? '' : ' off'))
    icon.append(setBg(el('div', 'talent-icon-img'), av.imgs?.[`cons${i}`]))
    const item = el('div', 'cons-item')
    item.append(icon)
    cons.append(item)
  }
  basic.append(cons)

  const info = el('div', 'data-info')
  if (state.view?.fetchedAt) info.append(el('span', 'time', `${T('scoredAt')} ${state.view.fetchedAt}`))
  basic.append(info)
  cont.append(basic)

  /* ===== .profile-detail ===== */
  const pd = el('div', 'profile-detail')

  /* 圣遗物评分汇总：左总分卡 + 右有效词条 */
  const statBox = el('div', 'arti-stat')
  const ret = el('div', 'arti-stat-ret')
  for (const [label, value, cls] of [
    [T('artisTotal'), av.score.mark, ''],
    /* 档位本身按 miao 的配色上色：红(ACE/MAX) / 黄(SSS/SS) / 紫(S/A) */
    [T('artisRank'), av.score.markClass, 'mark-' + rankOf(av.score.markClass)]
  ]) {
    const d = el('div')
    d.append(el('span', '', label), el('strong', cls, value))
    ret.append(d)
  }
  statBox.append(ret)
  if (av.score.classTitle) statBox.append(el('div', 'arti-class-title', `${T('rule')}：${av.score.classTitle}`))

  const infoBox = el('div', 'arti-info')
  const allWrap = el('div', 'arti-all-attr')
  const allUl = el('ul', 'detail attr arti-attr')
  for (const a of (av.allAttr || [])) {
    if (!a || !a.key) { allUl.append(el('li')); continue }
    const li = el('li', a.cls || 'nouse')
    const title = el('span', 'title')
    if (a.eff && a.eff !== '-') title.append(el('i', 'eff', a.eff))
    title.append(document.createTextNode(a.label))
    li.append(title, el('span', 'val', '+' + a.value))
    allUl.append(li)
  }
  allWrap.append(allUl)
  infoBox.append(allWrap)
  /* 只传文案本身：上游那句「可使用 #角色名圣遗物 …」是 QQ 指令提示，网页版没有对应功能，
     后端文案表里已经把它剪掉了，这里不再拼 tag 插值 */
  infoBox.append(richText(el('div', 'arti-notice'), T('artisNotice')))

  const markCont = el('div', 'arti-mark-cont')
  markCont.append(statBox, infoBox)
  pd.append(markCont)

  /* 武器卡：图标（右上溢出）+ 名 + 精N·Lv.N + 主副属性 + 精炼描述。
     只要**装备了**就出这张卡（state 非 'none'）—— 元数据不认识这把时名字/属性/
     描述都是空的，但等级和精炼是 enka 给的真实数据，不该整张卡消失。 */
  const artis = el('div', 'artis')
  if (av.weapon && av.weapon.state !== 'none') artis.append(renderWeaponCard(av.weapon))
  for (const a of av.artifacts) artis.append(renderArtiCard(a, av.charWeight))
  pd.append(artis)

  cont.append(pd)

  const copy = el('div', 'pd-copyright')
  copy.textContent = `miao-plugin · ${T('artisRank')} ${av.score.markClass} · ${av.score.classTitle || ''}`
  cont.append(copy)

  fitDetailZoom()
}

/*
 * 武器卡：图标（右上溢出）+ 名字 + 精N Lv.N + 属性条 + 描述。
 *
 * 「名字 / 精N Lv.N」两行是上限，别再往里加行：.head 高 90px，底部 26px 被属性条
 * （Absolute bottom:0）占掉，剩下 64px 刚好装下这两行。曾加过一行武器星级，
 * 结果等级行（精2 Lv.90）被顶到 64px 以下，整行压进属性条里、和「攻击 +608.10」叠在一起。
 * 参考图里武器名下面直接就是「精1 Lv.90」，本来也没有星级行。
 */
function renderWeaponCard (w) {
  const item = el('div', 'item weapon')
  item.append(setBg(el('div', 'img'), w.icon))

  const head = el('div', 'head')
  head.append(el('strong', '', w.sName || w.name || weaponFallback(w)))
  const wInfo = el('span', 'info')
  wInfo.append(el('span', 'affix affix-' + (w.affix ?? 1), `${T('refine')}${w.affix ?? 1}`))
  wInfo.append(document.createTextNode(` Lv.${w.level ?? '?'}`))
  head.append(wInfo)

  /* 主副属性贴在 head 底部（miao 里 .weapon-attr 是 .head 的子元素、absolute bottom:0，
     挂到整张卡上会掉到卡片底部去） */
  const wa = el('div', 'weapon-attr')
  for (const [k, v] of Object.entries(w.attrs || {})) {
    const d = el('div')
    d.append(el('span', '', W_ATTR_TITLE[k] || k))
    d.append(document.createTextNode(' +' + v))
    wa.append(d)
  }
  head.append(wa)
  item.append(head)

  /* miao 的描述里带 <nobr> 高亮标签，这里只取纯文本（顺手避免注入） */
  const dc = el('div', 'weapon-desc-cont')
  dc.append(el('div', 'weapon-desc', String(w.desc || '').replace(/<[^>]*>/g, '')))
  item.append(dc)
  return item
}

/*
 * 把 600px 画布等比缩到屏幕宽度。PC 上可用宽度 > 600，scale 恒为 1 —— 就是 miao 出图的原尺寸。
 * 直接写 zoom 内联样式（不用 CSS 变量转一手，实测 var() 在这里不生效）。
 */
function fitDetailZoom () {
  const frame = document.querySelector('.pd-frame')
  if (!frame) return
  const vw = document.documentElement.clientWidth || window.innerWidth
  frame.style.zoom = String(Math.min(1, (Math.min(vw, 760) - 16) / 600))
}
window.addEventListener('resize', fitDetailZoom)

/* 强化命中次数的标记：实心圆 + 镂空数字（数字从圆里抠掉，露出词条行的底色），
 * 对齐游戏 5.3 的「强化次数标记」（米游社那篇教学里叫「强化命中次数」）。
 *
 * 为什么只能用 SVG 的 <mask> 抠：
 *   CSS 的 mask 只能拿渐变/图片/路径当蒙版，**没法拿字形当蒙版**；
 *   而想在 CSS 里硬做镂空，就只剩「拿一个不透明色去填数字」这条路 ——
 *   可这一行的底色是「模糊的圣遗物图 + 半透明黑」叠出来的
 *   （ul.detail 带 backdrop-filter，行本身还是 rgba(0,0,0,.4) 这种半透明），
 *   填任何固定颜色都能看出一个色块。SVG 的 mask 抠出来的是真 alpha，行底下是什么就露什么。
 *
 * 数字写进 <mask> 里的 <text>、不给 <i> 加文本节点：
 *   两者会画在同一层，文本节点会顺着镂空的口子露出来（等于没镂空）；
 *   放进 mask 就只当蒙版用。它仍算 <i> 的后代，textContent 照样读得到那个数字。
 */
let hitMaskSeq = 0
function hitMark (n) {
  const NS = 'http://www.w3.org/2000/svg'
  const mk = (tag) => document.createElementNS(NS, tag)
  const attr = (node, kv) => { for (const [k, v] of Object.entries(kv)) node.setAttribute(k, v); return node }

  const mask = mk('mask')
  /* url(#id) 是全文档查的，同页几十个圈号不能重名 —— 用自增序号，一次页面加载内不会撞 */
  mask.id = 'up-hit-' + (++hitMaskSeq)
  /* 蒙版按亮度取：白整块留着（＝圆），黑的地方抠掉（＝数字） */
  mask.append(attr(mk('rect'), { width: 14, height: 14, fill: '#fff' }))
  /* x 用 7（圆心）当起点、再按实测校：
     text-anchor 居中的是「字的宽度（advance）」而不是「墨迹」，这套字体（微软雅黑 Bold）
     的数字墨迹偏左，实测 x=6 时墨迹中心落在 6.0、圆心在 7.0 —— 所以取 7。
     y=10.6 是让数字墨迹的竖直中心压着圆心的基线位置（实测偏移 +0.0）。
     两个数都是截图像素量出来的，不是估的；换字体要重量。 */
  const digit = attr(mk('text'), { x: 7, y: 10.6, 'text-anchor': 'middle', fill: '#000' })
  digit.textContent = String(n)
  mask.append(digit)

  const defs = mk('defs')
  defs.append(mask)
  /* 圆用 currentColor：跟着 span.title 的三档配色走，CSS 里不用再为它配一遍颜色 */
  const disc = attr(mk('circle'), { cx: 7, cy: 7, r: 7, fill: 'currentColor', mask: `url(#${mask.id})` })
  const svg = attr(mk('svg'), { viewBox: '0 0 14 14' })
  svg.append(defs, disc)
  return svg
}

/* 一件圣遗物：条目结构照抄 miao 的 .item.arti（右上图标 / 头 / 词条表）
 *
 * 词条名外面多包了一层 .label（miao 没有），为的是让过长的标签被省略号收在自己格里：
 * 表格列宽是按「所有行里最宽的那个单元格」算的，英文标签最长 18 字
 * （Physical DMG Bonus / Elemental Mastery / Electro DMG Bonus），
 * 一行这么长就把整张表撑到 222px（卡只有 185），于是每一行的数值都右移到隔壁卡片上。
 * 详见 miao.css 的 .label 规则（含「跟在强化命中圈号后的标签只能有 61px」那条）。 */
function renderArtiCard (a, cw = {}) {
  if (a.empty) {
    const c = el('div', 'item arti empty')
    const icon = el('div', 'arti-icon')
    icon.append(el('span', 'arti-fallback', slotGlyph(a.pos)))
    const head = el('div', 'head')
    head.append(el('strong', '', a.posName))
    c.append(icon, head, el('div', 'arti-empty', T('notEquipped')))
    return c
  }

  const rank = rankOf(a.markClass)
  const c = el('div', 'item arti arti-class-' + rank)

  /* 图标：miao 的套装图标（斜切淡出），缺图时露出部位单字兜底 */
  const icon = el('div', 'arti-icon')
  icon.dataset.slot = slotGlyph(a.pos)
  icon.append(setBg(el('div', 'img'), a.icon))
  icon.append(el('span', '', '+' + (a.level ?? 0)))
  c.append(icon)

  const head = el('div', 'head')
  head.append(el('strong', '', a.name))
  const mk = el('span', 'mark mark-' + rank)
  mk.append(el('span', '', a.mark + '分'))
  mk.append(document.createTextNode(' - ' + a.markClass))
  head.append(mk)
  c.append(head)

  const ul = el('ul', 'detail attr')
  if (a.main) {
    const li = el('li', 'arti-main')
    const mt = el('span', 'title')
    mt.append(el('span', 'label', a.main.label))
    li.append(mt, el('span', 'val', '+' + a.main.value))
    ul.append(li)
  }
  for (const s of a.subs) {
    const li = el('li', weightClass(Number(cw[s.key] ?? 0)))
    const lab = el('span', 'title')
    /* eff = 词条有效率；up-num = 强化命中了几次，实心圆+镂空数字（见 hitMark 与 CSS） */
    if (s.eff && s.eff !== '-') lab.append(el('i', 'eff', s.eff))
    /* 命中次数 = upNum - 1：upNum 是这条「出过几次」，含初始那一次，而初始那次不算强化命中，
       所以滚过两回的词条是 1 次命中、滚过三回的是 2 次（和游戏里数出来的一样）。
       上限 5：五星一共 5 次强化，全砸在同一条上也只可能是 5 次。
       0 次命中的不画 —— 和游戏一样留空，也顺带省掉一排没信息的 ⓪。 */
    const hit = Math.min(5, (s.upNum || 0) - 1)
    if (hit > 0) {
      const um = el('i', 'up-num')
      um.append(hitMark(hit))   /* append 返回 undefined，不能连在 el(...) 后面往 lab 里塞 */
      lab.append(um)
    }
    lab.append(el('span', 'label', s.label))
    li.append(lab, el('span', 'val', '+' + s.value))
    ul.append(li)
  }
  c.append(ul)
  return c
}

/* ───────────────────────── 全局刷新 ───────────────────────── */

function renderAll () {
  renderRoster()
  renderDetail()
}

/* ───────────────────────── 交互 ───────────────────────── */

function openDetail (avatarId) {
  state.selectedAvatarId = avatarId
  renderDetail()
  showView('detail')
}

function syncUrl () {
  const q = new URLSearchParams()
  if (state.uid) q.set('uid', state.uid)
  if (state.locale) q.set('locale', state.locale)
  if (state.selectedAvatarId && $('view-detail').classList.contains('active')) q.set('char', state.selectedAvatarId)
  history.replaceState(null, '', q.toString() ? `/?${q}` : '/')
}

function showLoading (text) {
  const box = $('view-roster')
  box.innerHTML = ''
  const wrap = el('div', 'loading')
  wrap.append(el('div', 'spin'), el('div', '', text ?? T('loading')))
  box.append(wrap)
}

/*
 * UID 输入历史。原生 autocomplete 靠不住（表单 submit 被 preventDefault 后，
 * 浏览器记不记全看心情），所以自己用 localStorage 存最近用过的 UID、
 * 渲染成 <datalist> —— 点一下输入框就能选回上次那个，跨会话也在。
 * 上限 8 个：再多这个下拉就变成翻名单了。
 */
const UID_HISTORY_KEY = 'st.uids'
function uidHistory () {
  try {
    const list = JSON.parse(localStorage.getItem(UID_HISTORY_KEY) || '[]')
    return Array.isArray(list) ? list.map(String) : []
  } catch { return [] }
}
function renderUidHistory () {
  const dl = $('uidHistory')
  dl.innerHTML = ''
  for (const u of uidHistory()) {
    const o = document.createElement('option')
    o.value = u
    dl.append(o)
  }
}
function rememberUid (uid) {
  const s = String(uid)
  const list = [s, ...uidHistory().filter(u => u !== s)].slice(0, 8)
  localStorage.setItem(UID_HISTORY_KEY, JSON.stringify(list))
  renderUidHistory()
}

async function loadUid (uid, { keepSelection = false } = {}) {
  if (!keepSelection) state.selectedAvatarId = null
  showLoading(T('reading'))
  try {
    const view = await api(`/api/uid/${uid}?locale=${encodeURIComponent(state.locale)}`)
    state.uid = Number(uid)
    localStorage.setItem('st.uid', String(uid))
    rememberUid(uid)
    applyView(view)
  } catch (e) {
    state.view = null
    renderAll()
    banner(e.message, 'err')
  }
}

async function fetchUid (uid) {
  if (state.busy) return
  state.busy = true
  const btn = $('fetch')
  btn.disabled = true
  btn.textContent = T('fetching')
  showLoading(T('fetchingLong'))
  try {
    const data = await api('/api/fetch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ uid: Number(uid), locale: state.locale })
    })
    state.uid = Number(uid)
    state.selectedAvatarId = null
    localStorage.setItem('st.uid', String(uid))
    rememberUid(uid)
    applyView(data)
    banner(T('fetchDone', { n: data.count }), 'ok')
  } catch (e) {
    banner(T('fetchFail', { msg: e.message }), 'err')
    if (state.uid) await loadUid(state.uid, { keepSelection: true })
  } finally {
    state.busy = false
    btn.disabled = false
    btn.textContent = T('fetch')
  }
}

/* 拉一次界面文字表 —— 语言解析的规则在后端，这里只负责拿回来 */
async function loadMeta (locale) {
  const meta = await api(`/api/meta?locale=${encodeURIComponent(locale)}`)
  state.ui = meta.ui || {}
  return meta
}

async function changeLocale (locale) {
  state.locale = locale
  localStorage.setItem('st.locale', locale)
  try { await loadMeta(locale) } catch {}
  applyStaticUi()
  syncUrl()
  if (!state.uid) { renderAll(); return }
  showLoading(T('switching'))
  try {
    state.view = await api(`/api/uid/${state.uid}?locale=${encodeURIComponent(locale)}`)
    renderAll()
  } catch (e) {
    banner(e.message, 'err')
  }
}

function applyStaticUi () {
  document.title = `${T('title')} · ${T('subtitle')}`
  document.documentElement.lang = state.locale
  $('brandName').textContent = T('title')
  $('brandSub').textContent = `seiten-suikyou · ${T('subtitle')}`
  $('uidLabel').textContent = T('uidLabel')
  $('fetch').textContent = T('fetch')
  $('fetch').title = T('fetchTip')
  $('localeLabel').textContent = T('localeLabel')
  $('uid').placeholder = T('uidLabel')
}

/* ───────────────────────── 启动 ───────────────────────── */

async function boot () {
  const params = new URLSearchParams(location.search)
  state.locale = params.get('locale') || localStorage.getItem('st.locale') || 'chs'
  renderUidHistory()

  try {
    const meta = await loadMeta(state.locale)
    const sel = $('locale')
    sel.innerHTML = ''
    for (const l of meta.locales) {
      const o = document.createElement('option')
      o.value = l.code
      o.textContent = l.label
      sel.append(o)
    }
    state.locale = meta.locales.some(l => l.code === state.locale) ? state.locale : meta.defaultLocale
    sel.value = state.locale
    applyStaticUi()
    if (!meta.i18nReady) banner(T('i18nMissing'))
  } catch (e) {
    banner(T('metaFail', { msg: e.message }), 'err')
  }

  const wanted = Number(params.get('uid') || localStorage.getItem('st.uid') || 0)
  const wantedChar = Number(params.get('char') || 0)
  if (!wanted) { renderAll(); return }

  $('uid').value = wanted
  await loadUid(wanted)
  if (wantedChar) {
    state.selectedAvatarId = wantedChar
    renderDetail()
    showView('detail')
  }
}

$('query').addEventListener('submit', (e) => {
  e.preventDefault()
  const uid = Number($('uid').value.trim())
  if (uid) loadUid(uid)
})
$('fetch').addEventListener('click', () => {
  const uid = Number($('uid').value.trim())
  if (!uid) { banner(T('needUid'), 'err'); return }
  fetchUid(uid)
})
$('locale').addEventListener('change', (e) => changeLocale(e.target.value))

boot()

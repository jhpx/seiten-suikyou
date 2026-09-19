/*
 * 页面逻辑 —— 原生 JS，移动优先，不引框架
 *
 * 结构：首页（角色大全）→ 点击卡片 → 角色明细页
 * PC 上也做成手机风格：外层固定最大宽度、居中。
 *
 * 和后端的分工：后端负责「算什么、叫什么」，前端只负责「长什么样」。
 * 所以这里一个词条名都不写死 —— 部位名、词条名、套装名全是后端按 locale 给好的文本。
 */

const $ = (id) => document.getElementById(id)

const RANK_ORDER = ['MAX', 'ACE', 'SSS', 'SS', 'S', 'A', 'B', 'C', 'D']
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
  ui: {}
}

const T = (key, vars) => {
  let s = state.ui[key] ?? key
  if (vars) for (const [k, v] of Object.entries(vars)) s = s.split(`{${k}}`).join(String(v ?? ''))
  return s
}

/* ───────────────────────── 后端调用 ───────────────────────── */

async function api (path, opts) {
  const res = await fetch(path, opts)
  let body = null
  try { body = await res.json() } catch {}
  if (!res.ok || (body && body.ok === false)) {
    const msg = body?.error?.message || `HTTP ${res.status}`
    throw new Error(msg)
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

function rankColor (cls) {
  const c = cls?.toUpperCase?.() || 'D'
  if (['ACE', 'MAX'].includes(c)) return '#e85656'
  if (['SS', 'SSS'].includes(c)) return '#ffe699'
  if (['A', 'S'].includes(c)) return '#d699ff'
  return '#e8edf4'
}

function rankOf (cls) {
  return RANK_ORDER.includes(cls) ? cls : 'D'
}

const ELEM_COLOR = {
  pyro: '#ff6a3d', hydro: '#3da6ff', electro: '#b46bff',
  cryo: '#7fd4ff', anemo: '#5fd0a0', geo: '#f0c24a', dendro: '#8fd14f'
}

/* 图片加载失败时隐藏自己，让 CSS 占位露出来 */
function imgError (img) { img.style.display = 'none' }

/* ───────────────────────── 视图切换 ───────────────────────── */

function showView (name) {
  $('view-roster').classList.toggle('active', name === 'roster')
  $('view-detail').classList.toggle('active', name === 'detail')
  window.scrollTo({ top: 0, behavior: 'smooth' })
}

function backToRoster () {
  state.selectedAvatarId = null
  showView('roster')
}

/* ───────────────────────── 首页：角色大全 ───────────────────────── */

function renderAccountHeader (acct) {
  const box = el('div', 'acct-header')
  if (!acct) return box

  const nick = el('div', 'acct-nick', acct.nickname || `UID ${acct.uid}`)
  box.append(nick)

  if (acct.signature) {
    const sig = el('div', 'acct-sig', acct.signature)
    box.append(sig)
  }

  const meta = el('div', 'acct-meta')
  const items = [
    [T('level'), acct.level],
    [T('worldLevel'), acct.worldLevel],
    ['UID', acct.uid]
  ]
  for (const [label, value] of items) {
    const d = el('div')
    d.append(el('b', '', value ?? '—'))
    d.append(el('span', '', label))
    meta.append(d)
  }
  box.append(meta)
  return box
}

function renderCharCard (av) {
  const card = el('div', 'char-card')
  const rank = rankOf(av.score.markClass)
  const color = rankColor(rank)

  card.style.setProperty('--rank', color)
  card.style.setProperty('--elem', ELEM_COLOR[av.elem] || '#888')

  const splash = el('div', 'char-splash')
  /* 首页网格用正面大头照（face，256x256），比整张立绘裁出来更像「选人」界面 */
  const faceUrl = av.imgs?.face || av.splash
  if (faceUrl) {
    const img = el('img')
    img.src = faceUrl
    img.alt = ''
    img.loading = 'lazy'
    img.onerror = function () { img.style.display = 'none' }
    splash.append(img)
  }
  splash.append(el('div', 'char-overlay'))

  const info = el('div', 'char-info')
  const top = el('div', 'char-top')
  top.append(el('span', 'char-elem', av.elemText || av.elem || ''))
  top.append(el('span', 'char-lv', `Lv.${av.level ?? '?'}`))
  info.append(top)

  info.append(el('div', 'char-name', av.name))

  const sub = el('div', 'char-sub')
  sub.append(el('span', '', `${T('cons')} ${av.cons}`))
  if (av.weapon?.name) sub.append(el('span', '', av.weapon.name))
  info.append(sub)

  const score = el('div', 'char-score')
  score.append(el('b', '', av.score.mark))
  score.append(el('span', 'char-rank', av.score.markClass))
  info.append(score)

  card.append(splash, info)
  card.addEventListener('click', () => openDetail(av.avatarId))
  return card
}

function renderRoster () {
  const view = state.view
  const box = $('view-roster')
  box.innerHTML = ''

  box.append(el('h2', 'page-title', T('rosterTitle')))
  box.append(renderAccountHeader(view?.account))

  if (!view || !view.avatars.length) {
    const ph = el('div', 'placeholder')
    ph.append(el('p', '', T('noScorable')), el('p', 'dim', T('noScorableHint')))
    box.append(ph)
    return
  }

  const sorted = [...view.avatars].sort((a, b) => b.score.markValue - a.score.markValue)
  const grid = el('div', 'char-grid')
  for (const av of sorted) grid.append(renderCharCard(av))
  box.append(grid)

  const foot = $('footmeta')
  foot.textContent = T('footMeta', { n: view.count, loc: view.locale, t: view.fetchedAt || '—' })
}

/* ─────────────────────────
 * 明细页：按 miao-plugin 结果图（profile-detail）1:1 画
 *
 * DOM 结构、class 名、图片资源全部照抄 miao 的 resources/character/profile-detail.html：
 *   .basic            立绘 + 角色名/UID/等级/命座 + 天赋图 + 面板属性 + 命座图 + 数据时间
 *   .profile-detail
 *     .arti-mark-cont 圣遗物总分 / 评级 / 评分规则 + 有效词条汇总（great/useful/nouse）
 *     .artis          武器（图标+主副属性+精炼描述）+ 5 件圣遗物
 *
 * 图片全是从 miao-plugin 仓库同步来的真图（tools/sync_assets.py）：
 *   立绘     meta-gs/character/{名}/imgs/splash.webp
 *   命座     meta-gs/character/{名}/icons/cons-{1..6}.webp
 *   天赋 A   common/item/atk-{武器类型}.webp   （普攻图标本来就是武器图标）
 *   天赋 E/Q 提升它的那个命座图标             （miao 的 talentCons 规则）
 *   武器     meta-gs/weapon/{类型}/{名}/icon.webp
 * ───────────────────────── */

function renderDetail () {
  const box = $('view-detail')
  box.innerHTML = ''

  const av = state.view?.avatars.find(a => a.avatarId === state.selectedAvatarId)
  if (!av) {
    box.append(el('div', 'placeholder', T('noData')))
    return
  }

  const cont = el('div', 'pd')
  cont.style.setProperty('--elem', ELEM_COLOR[av.elem] || '#888')
  cont.style.setProperty('--rank', rankColor(rankOf(av.score.markClass)))

  /* 顶部返回栏 */
  const bar = el('div', 'detail-bar')
  const back = el('button', 'btn back', '← ' + T('back'))
  back.addEventListener('click', backToRoster)
  bar.append(back)
  bar.append(el('span', 'detail-title', T('detailTitle')))
  box.append(bar)

  /* ===== .basic ===== */
  const basic = el('div', 'basic')

  const mainPic = el('div', 'main-pic')
  if (av.splash) mainPic.style.backgroundImage = `url("${av.splash}")`
  basic.append(mainPic)
  /* 压暗层：立绘很亮，不压一层上面的白字看不清 */
  basic.append(el('div', 'basic-shade'))

  const detail = el('div', 'detail')
  detail.append(el('div', 'char-name', av.name))

  const lvRow = el('div', 'char-lv')
  lvRow.append(el('span', '', `UID ${av.uid} - Lv.${av.level ?? '?'}`))
  lvRow.append(el('span', 'cons', `${av.cons}${T('cons')}`))
  detail.append(lvRow)

  /* 天赋 a/e/q：等级牌 + miao 的图标。
     talent-plus = 被命座提升过，talent-crown = 原始等级满 10（戴皇冠），判定都来自后端 */
  const talents = el('div', 'char-talents')
  for (const k of ['a', 'e', 'q']) {
    const t = av.talent?.[k] || {}
    const item = el('div', 'talent-item')
    const icon = el('div', 'talent-icon' +
      (t.plus ? ' talent-plus' : '') + (t.crown ? ' talent-crown' : ''))
    const im = el('div', 'talent-icon-img')
    if (av.imgs?.[k]) im.style.backgroundImage = `url("${av.imgs[k]}")`
    icon.append(im)
    icon.append(el('strong', '', String(t.level ?? 0)))
    item.append(icon)
    talents.append(item)
  }
  detail.append(talents)

  /* 面板属性：图标 + 名称 + 权重 + 总值 +（基础值 / 绿字） */
  if (av.attrTable?.length) {
    const ul = el('ul', 'char-attr')
    for (const r of av.attrTable) {
      const li = el('li')
      const ic = el('div', 'icon')
      ic.append(el('i', 'i-' + r.key))
      li.append(ic)
      li.append(el('div', 'title', r.label))
      const wt = el('div', 'weight')
      if (r.weight) wt.append(el('span', r.weight >= 80 ? 'gold' : 'normal', String(r.weight)))
      li.append(wt)
      li.append(el('div', 'value', r.value))
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
    const item = el('div', 'cons-item')
    const icon = el('div', 'talent-icon' + (i <= (av.cons ?? 0) ? '' : ' off'))
    const im = el('div', 'talent-icon-img')
    if (av.imgs?.[`cons${i}`]) im.style.backgroundImage = `url("${av.imgs[`cons${i}`]}")`
    icon.append(im)
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

  /* 圣遗物评分汇总 */
  const markCont = el('div', 'arti-mark-cont')
  const statBox = el('div', 'arti-stat')
  const ret = el('div', 'arti-stat-ret')
  const boxTotal = el('div')
  boxTotal.append(el('span', '', T('artisTotal')))
  boxTotal.append(el('strong', '', av.score.mark))
  ret.append(boxTotal)
  const boxRank = el('div')
  boxRank.append(el('span', '', T('artisRank')))
  boxRank.append(el('strong', 'mark-' + rankOf(av.score.markClass), av.score.markClass))
  ret.append(boxRank)
  statBox.append(ret)
  if (av.score.classTitle) {
    statBox.append(el('div', 'arti-class-title', `${T('rule')}：${av.score.classTitle}`))
  }
  markCont.append(statBox)

  /* 有效词条汇总（miao 的 allAttr，补到 9 格） */
  const infoBox = el('div', 'arti-info')
  const allWrap = el('div', 'arti-all-attr')
  const allUl = el('ul', 'detail attr arti-attr')
  for (const a of (av.allAttr || [])) {
    if (a && a.key) {
      const li = el('li', a.cls || 'nouse')
      li.append(el('span', 'title', a.label))
      li.append(el('span', 'val', '+' + a.value))
      allUl.append(li)
    } else {
      allUl.append(el('li'))
    }
  }
  allWrap.append(allUl)
  infoBox.append(allWrap)
  infoBox.append(el('div', 'dmg-desc arti-notice', T('artisNotice')))
  markCont.append(infoBox)
  pd.append(markCont)

  /* 武器 + 5 件圣遗物 */
  const artis = el('div', 'artis')

  /* 武器卡：图标 + 名 + 精N/Lv.N + 主副属性 + 精炼描述（都来自 miao 的 Weapon 元数据） */
  const wBox = el('div', 'artis-weapon')
  const wItem = el('div', 'item weapon')
  const wImg = el('div', 'img')
  if (av.weapon?.icon) wImg.style.backgroundImage = `url("${av.weapon.icon}")`
  wItem.append(wImg)

  const wHead = el('div', 'head')
  wHead.append(el('strong', '', av.weapon?.sName || av.weapon?.name || T('noWeapon')))
  const wInfo = el('span', 'info')
  wInfo.append(el('span', 'affix', `${T('refine')}${av.weapon?.affix ?? 1}`))
  wInfo.append(document.createTextNode(` Lv.${av.weapon?.level ?? '?'}`))
  wHead.append(wInfo)
  wItem.append(wHead)

  const wa = el('div', 'weapon-attr')
  for (const [k, v] of Object.entries(av.weapon?.attrs || {})) {
    const d = el('div')
    d.append(el('span', '', W_ATTR_TITLE[k] || k))
    d.append(document.createTextNode(' +' + v))
    wa.append(d)
  }
  wItem.append(wa)

  if (av.weapon?.desc) {
    const dc = el('div', 'weapon-desc-cont')
    /* miao 的描述里带 <nobr> 之类的高亮标签，这里只取纯文本（也顺手避免注入） */
    dc.append(el('div', 'weapon-desc', av.weapon.desc.replace(/<[^>]*>/g, '')))
    wItem.append(dc)
  }
  wBox.append(wItem)
  artis.append(wBox)

  for (const a of av.artifacts) artis.append(renderArtiCard(a, av.charWeight))
  pd.append(artis)

  cont.append(pd)
  box.append(cont)
}

/* 一件圣遗物：条目结构照抄 miao 的 .item.arti（图标 / 头 / 词条列表） */
function renderArtiCard (a, cw = {}) {
  if (a.empty) {
    const c = el('div', 'item arti empty')
    const icon = el('div', 'arti-icon')
    icon.append(el('span', 'arti-fallback', SLOT_GLYPH[a.pos] || '?'))
    c.append(icon)
    const head = el('div', 'head')
    head.append(el('strong', '', a.posName))
    c.append(head)
    c.append(el('div', 'empty-tip', T('notEquipped')))
    return c
  }

  const rank = rankOf(a.markClass)
  const c = el('div', 'item arti arti-class-' + rank)
  c.style.setProperty('--rank', rankColor(rank))

  /* 图标：miao 的套装图标，404 时露出部位单字占位 */
  const icon = el('div', 'arti-icon')
  if (a.icon) {
    const img = el('img')
    img.src = a.icon
    img.alt = ''
    img.loading = 'lazy'
    /* 图标 404（比如还没同步到的套装）时藏掉自己，露出部位单字占位 */
    img.onerror = function () { img.style.display = 'none'; icon.classList.add('fallback') }
    icon.append(img)
  } else {
    icon.classList.add('fallback')
  }
  icon.append(el('span', 'arti-fallback', SLOT_GLYPH[a.pos] || '?'))
  icon.append(el('span', 'arti-lv', '+' + (a.level ?? 0)))
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
    li.append(el('span', 'title', a.main.label))
    li.append(el('span', 'val', '+' + a.main.value))
    li.append(el('span', 'mark', a.main.point ?? '-'))
    ul.append(li)
  }
  for (const s of a.subs) {
    const w = Number(cw[s.key] ?? 0)
    const cls = w > 79.9 ? 'great' : (w > 0 ? 'useful' : 'nouse')
    const li = el('li', cls)
    const lab = el('span', 'title')
    /* eff = 词条有效率（miao 算好的串），up-num = 这条滚了几次的小图标 */
    if (s.eff && s.eff !== '-') lab.append(el('i', 'eff', s.eff))
    if (s.upNum) lab.append(el('i', 'up-num up-' + s.upNum))
    lab.append(document.createTextNode(s.label))
    li.append(lab)
    li.append(el('span', 'val', '+' + s.value))
    li.append(el('span', 'mark', s.point ?? '-'))
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
  wrap.append(el('div', 'spin'))
  wrap.append(el('div', '', text ?? T('loading')))
  box.append(wrap)
}

async function loadUid (uid, { keepSelection = false } = {}) {
  if (!keepSelection) state.selectedAvatarId = null
  showLoading(T('reading'))
  try {
    const view = await api(`/api/uid/${uid}?locale=${encodeURIComponent(state.locale)}`)
    state.uid = Number(uid)
    state.view = view
    localStorage.setItem('st.uid', String(uid))
    syncUrl()
    renderAll()
    showView('roster')
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
    state.view = data
    localStorage.setItem('st.uid', String(uid))
    syncUrl()
    renderAll()
    showView('roster')
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

async function changeLocale (locale) {
  state.locale = locale
  localStorage.setItem('st.locale', locale)
  try {
    const meta = await api(`/api/meta?locale=${encodeURIComponent(locale)}`)
    state.ui = meta.ui || {}
  } catch {}
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
  $('load').textContent = T('load')
  $('fetch').textContent = T('fetch')
  $('fetch').title = T('fetchTip')
  $('localeLabel').textContent = T('localeLabel')
  $('uid').placeholder = T('uidLabel')
  $('footnote').textContent = T('footerNote')
}

/* ───────────────────────── 启动 ───────────────────────── */

async function boot () {
  const params = new URLSearchParams(location.search)
  state.locale = params.get('locale') || localStorage.getItem('st.locale') || 'chs'

  try {
    const meta = await api(`/api/meta?locale=${encodeURIComponent(state.locale)}`)
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
    state.ui = meta.ui || {}
    applyStaticUi()
    if (!meta.i18nReady) banner(T('i18nMissing'))
  } catch (e) {
    banner(T('metaFail', { msg: e.message }), 'err')
  }

  const wanted = Number(params.get('uid') || localStorage.getItem('st.uid') || 0)
  const wantedChar = Number(params.get('char') || 0)
  if (wanted) {
    $('uid').value = wanted
    await loadUid(wanted)
    if (wantedChar) {
      state.selectedAvatarId = wantedChar
      renderDetail()
      showView('detail')
    }
  } else {
    renderAll()
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

/*
 * 页面逻辑 —— 原生 JS，不引框架
 *
 * 和后端的分工：后端负责「算什么、叫什么」，前端只负责「长什么样」。
 * 所以这里一个词条名都不写死 —— 部位名、词条名、套装名全是后端按 locale 给好的文本，
 * 加一门语言不需要动这个文件。
 *
 * 唯一的例外是「排版用的常量」：评分档位到颜色的映射、排名顺序，那些是视觉决定。
 */

const $ = (id) => document.getElementById(id)

const RANK_ORDER = ['MAX', 'ACE', 'SSS', 'SS', 'S', 'A', 'B', 'C', 'D']
const ELEM_KEY = {
  anemo: 'anemo', geo: 'geo', electro: 'electro', dendro: 'dendro',
  pyro: 'pyro', hydro: 'hydro', cryo: 'cryo'
}

const state = { locale: 'chs', uid: null, view: null, selected: null, busy: false, ui: {} }

/* 取一条界面文字。所有按钮/标题/提示都走这里，本文件里不留任何中文面。 */
const T = (key, vars) => {
  let s = state.ui[key] ?? key
  if (vars) for (const [k, v] of Object.entries(vars)) s = s.split(`{${k}}`).join(String(v ?? ''))
  return s
}

/* ───────────────────────── 后端调用 ───────────────────────── */

async function api (path, opts) {
  const res = await fetch(path, opts)
  let body = null
  try { body = await res.json() } catch { /* 空响应体 */ }
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

/* ───────────────────────── 渲染 ───────────────────────── */

const rankOf = (cls) => (RANK_ORDER.includes(cls) ? cls : 'D')

function renderAccount (acct) {
  const el = $('acct')
  if (!acct) { el.innerHTML = ''; return }
  el.innerHTML = ''
  const nick = document.createElement('div')
  nick.className = 'nick'
  nick.textContent = acct.nickname || `UID ${acct.uid}`
  el.append(nick)
  if (acct.signature) {
    const sig = document.createElement('p')
    sig.className = 'sig'
    sig.textContent = acct.signature
    el.append(sig)
  }
  const meta = document.createElement('div')
  meta.className = 'meta'
  for (const [k, v] of [[T('level'), acct.level], [T('worldLevel'), acct.worldLevel], ['UID', acct.uid]]) {
    const d = document.createElement('div')
    d.innerHTML = `<b></b><span></span>`
    d.querySelector('b').textContent = v ?? '—'
    d.querySelector('span').textContent = k
    meta.append(d)
  }
  el.append(meta)
}

function renderCharList (view) {
  const ol = $('charlist')
  ol.innerHTML = ''
  const tpl = $('tpl-char')
  /* 按总分降序 —— 和 CLI 的汇总一致，这样列表本身就是一张排行榜 */
  const sorted = [...view.avatars].sort((a, b) => b.score.markValue - a.score.markValue)
  for (const av of sorted) {
    const node = tpl.content.firstElementChild.cloneNode(true)
    const rank = rankOf(av.score.markClass)
    node.dataset.avatar = av.avatarId
    node.style.setProperty('--rank', `var(--rank-${rank.toLowerCase()})`)
    node.setAttribute('aria-selected', String(av.avatarId === state.selected))
    node.querySelector('.rank').textContent = av.score.markClass
    node.querySelector('.cname').textContent = av.name
    node.querySelector('.csub').textContent =
      `Lv.${av.level ?? '?'} ${T('cons')}${av.cons} · ${av.weapon.name || T('noWeapon')}`
    node.querySelector('.cscore b').textContent = av.score.mark
    node.querySelector('.cscore span').textContent = av.score.classTitle || ''
    node.addEventListener('click', () => selectChar(av.avatarId))
    node.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); selectChar(av.avatarId) }
    })
    ol.append(node)
  }
}

function el (tag, cls, text) {
  const n = document.createElement(tag)
  if (cls) n.className = cls
  if (text !== undefined) n.textContent = text
  return n
}

function renderArtifact (arti) {
  const node = $('tpl-arti').content.firstElementChild.cloneNode(true)
  if (arti.empty) {
    const wrap = el('div', 'arti empty')
    wrap.append(el('span', 'dim', `${arti.posName} · ${T('notEquipped')}`))
    return wrap
  }
  const rank = rankOf(arti.markClass)
  node.style.setProperty('--rank', `var(--rank-${rank.toLowerCase()})`)
  node.querySelector('.pos').textContent = arti.posName
  node.querySelector('.aname').textContent = arti.name
  node.querySelector('.aset').textContent = arti.setName
  const ring = node.querySelector('.ring')
  ring.style.setProperty('--p', String(Math.max(0, Math.min(100, arti.markValue / 70 * 100))))
  node.querySelector('.amark').textContent = arti.mark
  node.querySelector('.aclass').textContent = arti.markClass

  node.querySelector('.mkey').textContent = arti.main?.label || '—'
  node.querySelector('.mval').textContent = arti.main?.value ?? ''

  const ul = node.querySelector('.subs')
  for (const s of arti.subs) {
    const li = el('li')
    const name = el('span', 'sname', s.label)
    const val = el('b', 'sval', s.upNum > 1 ? `${s.value} ×${s.upNum}` : s.value)
    const bar = el('span', 'sbar')
    const fill = el('i')
    /* 单条副词条的强化次数最多 5 次，拿它当条长；未知就按 1 次显示一个短条 */
    fill.style.width = `${Math.max(8, Math.min(100, (s.upNum || 1) / 5 * 100))}%`
    bar.append(fill)
    li.title = s.eff && s.eff !== '-' ? T('effTip', { eff: s.eff }) : T('notEffective')
    li.append(name, val, bar)
    ul.append(li)
  }
  return node
}

function renderHero (av) {
  const rank = rankOf(av.score.markClass)
  const hero = el('section', 'hero')
  hero.style.setProperty('--rank', `var(--rank-${rank.toLowerCase()})`)
  hero.style.setProperty('--elem', `var(--elem-${ELEM_KEY[av.elem] || 'anemo'})`)

  const avatar = el('div', 'avatar')
  avatar.textContent = (av.name || '?').slice(0, 1)
  avatar.append(el('span', 'e', av.elemText || '—'))
  hero.append(avatar)

  const info = el('div', 'hinfo')
  const h = el('div')
  h.append(el('b', 'hname', av.name))
  if (av.nameZh && av.nameZh !== av.name) h.append(el('span', 'hzh', av.nameZh))
  info.append(h)

  const line = el('div', 'hline')
  line.append(el('span', 'tag', `★${av.star} Lv.${av.level ?? '?'}`))
  line.append(el('span', 'tag', `${T('cons')} ${av.cons}`))
  if (av.fetter) line.append(el('span', 'tag', `${T('fetter')} ${av.fetter}`))
  line.append(el('span', 'tag', av.weapon.name
    ? `${av.weapon.name} ${T('refine')}${av.weapon.affix}`
    : T('noWeapon')))
  if (av.talent.a || av.talent.e || av.talent.q) {
    line.append(el('span', 'tag', `${T('talent')} ${av.talent.a}/${av.talent.e}/${av.talent.q}`))
  }
  const tagline = el('div', 'tagline')
  for (const s of av.sets) tagline.append(el('span', 'tag set', `${s.name} ×${s.count}`))
  line.append(...tagline.children)
  info.append(line)
  hero.append(info)

  const score = el('div', 'hscore')
  const ring = el('div', 'ring')
  /* 角色总分是 5 件的和，档位阈值是按「单件均分（0..70）」定的；
     所以进度环要用 均分/70，不是 总分/70 */
  ring.style.setProperty('--p', String(Math.max(0, Math.min(100, av.score.markValue / 5 / 70 * 100))))
  const rv = el('div', 'rv')
  rv.append(el('b', '', av.score.mark), el('span', '', T('total')))
  ring.append(rv)
  const right = el('div')
  right.append(el('div', 'rankbadge', av.score.markClass))
  right.append(el('div', 'scene', av.score.classTitle || ''))
  score.append(ring, right)
  hero.append(score)

  return hero
}

function renderDetail () {
  const box = $('detail')
  box.innerHTML = ''
  const av = state.view?.avatars.find(a => a.avatarId === state.selected)
  if (!av) {
    const ph = el('div', 'placeholder')
    ph.append(el('p', '', T('noScorable')), el('p', 'dim', T('noScorableHint')))
    box.append(ph)
    return
  }

  box.append(renderHero(av))

  box.append(el('div', 'section-title', T('panelSection')))
  const grid = el('div', 'panel-grid')
  for (const p of av.panel) {
    const cell = el('div', 'pstat')
    cell.append(el('span', '', p.label), el('b', '', p.text))
    grid.append(cell)
  }
  box.append(grid)

  box.append(el('div', 'section-title', T('artiSection')))
  const artis = el('div', 'artis')
  for (const a of av.artifacts) artis.append(renderArtifact(a))
  box.append(artis)
}

function renderUids (list) {
  const box = $('uids')
  box.innerHTML = ''
  for (const u of list) {
    const chip = el('span', 'chip', `${u.uid}${u.nickname ? ' ' + u.nickname : ''}`)
    chip.title = T('uidChipTip', { n: u.avatarCount, t: u.fetchedAt || '—' })
    if (u.uid === state.uid) chip.setAttribute('aria-current', 'true')
    chip.addEventListener('click', () => loadUid(u.uid))
    box.append(chip)
  }
}

function renderAll () {
  const view = state.view
  renderAccount(view?.account)
  if (!view) { $('charlist').innerHTML = ''; renderDetail(); return }
  if (state.selected == null && view.avatars.length) {
    state.selected = [...view.avatars].sort((a, b) => b.score.markValue - a.score.markValue)[0].avatarId
  }
  renderCharList(view)
  renderDetail()
  const meta = $('footmeta')
  meta.textContent = T('footMeta', { n: view.count, loc: view.locale, t: view.fetchedAt || '—' })
}

/* ───────────────────────── 交互 ───────────────────────── */

function selectChar (avatarId) {
  state.selected = avatarId
  for (const li of $('charlist').children) {
    li.setAttribute('aria-selected', String(Number(li.dataset.avatar) === avatarId))
  }
  renderDetail()
}

function syncUrl () {
  const q = new URLSearchParams()
  if (state.uid) q.set('uid', state.uid)
  if (state.locale) q.set('locale', state.locale)
  history.replaceState(null, '', q.toString() ? `/?${q}` : '/')
}

function showLoading (text) {
  $('detail').innerHTML = ''
  const box = el('div', 'loading')
  box.append(el('div', 'spin'))
  box.append(el('div', '', text ?? T('loading')))
  $('detail').append(box)
}

async function loadUid (uid, { keepSelection = false } = {}) {
  if (!keepSelection) state.selected = null
  showLoading(T('reading'))
  try {
    const view = await api(`/api/uid/${uid}?locale=${encodeURIComponent(state.locale)}`)
    state.uid = Number(uid)
    state.view = view
    localStorage.setItem('st.uid', String(uid))
    syncUrl()
    renderAll()
    renderUids(await api('/api/uids'))
  } catch (e) {
    state.view = null
    renderAll()
    $('detail').innerHTML = ''
    const ph = el('div', 'placeholder')
    ph.append(el('p', '', T('readFail', { uid })), el('p', 'dim', e.message))
    $('detail').append(ph)
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
    state.selected = null
    state.view = data
    localStorage.setItem('st.uid', String(uid))
    syncUrl()
    renderAll()
    renderUids(await api('/api/uids'))
    banner(T('fetchDone', { n: data.count }), 'ok')
  } catch (e) {
    banner(T('fetchFail', { msg: e.message }), 'err')
    /* 抓取失败时，库里原来那份还是能看的 */
    if (state.uid) await loadUid(state.uid, { keepSelection: true })
    else {
      $('detail').innerHTML = ''
      const ph = el('div', 'placeholder')
      ph.append(el('p', '', T('fetchHardFail')), el('p', 'dim', e.message))
      $('detail').append(ph)
    }
  } finally {
    state.busy = false
    btn.disabled = false
    btn.textContent = T('fetch')
  }
}

async function changeLocale (locale) {
  state.locale = locale
  localStorage.setItem('st.locale', locale)
  syncUrl()
  /* 先换界面文字，再换数据 —— 断网时页面至少不是半中半英 */
  try {
    const meta = await api(`/api/meta?locale=${encodeURIComponent(locale)}`)
    state.ui = meta.ui || {}
  } catch { /* 拿不到就沿用上一张表，不至于白屏 */ }
  applyStaticUi()
  if (!state.uid) { renderAll(); return }
  showLoading(T('switching'))
  try {
    state.view = await api(`/api/uid/${state.uid}?locale=${encodeURIComponent(locale)}`)
    renderAll()
  } catch (e) {
    banner(e.message, 'err')
  }
}

/* ───────────────────────── 启动 ───────────────────────── */

/* 把界面文字刷到页面上所有静态节点（顶栏/按钮/页脚/模板里的固定标签）。
   每次拿到新的 ui 表都调一次 —— 切语言时网页自带的那些字也要跟着变。 */
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
  /* 主词条标签在 <template> 里，模板内容不在主文档树上，getElementById 找不到它 */
  const tplMain = $('tpl-arti').content.querySelector('#mainStat')
  if (tplMain) tplMain.textContent = T('mainStat')
  /* 还没加载数据时，详情区那块占位提示也要跟着换语言 */
  const ph = $('detail').querySelector('.placeholder[data-idle]')
  if (ph) {
    ph.innerHTML = ''
    ph.append(el('p', '', T('noData')), el('p', 'dim', T('noDataHint')))
  }
}

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

  const uids = await api('/api/uids').catch(() => [])
  renderUids(uids)

  const wanted = Number(params.get('uid') || localStorage.getItem('st.uid') || uids[0]?.uid || 0)
  if (wanted) {
    $('uid').value = wanted
    await loadUid(wanted)
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

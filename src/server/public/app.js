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

/*
 * 首页的一张角色卡 —— 照原魔工具箱「角色展柜」中间那块做的。
 *
 * 它跟明细页是两种东西：明细页是 miao 那张**出图**，要 1:1；首页是**列表**，
 * 只借它的视觉语言（星级底色 / 半透明分数带 / 白色等级条 / 元素图标），
 * 再按我们手上有的数据多挂一条武器信息。所以这里不照抄 miao 的任何 CSS。
 *
 * 一条铁律：**不显示角色名**（名字在 hover 的 title 里，以及明细页里）。
 * 卡片自上而下两段：
 *   ⓐ 画像区 —— 星级底图（五星橙 / 四星紫）打底，四角挂四样东西：
 *      左上元素图标 · 右上角色等级 · 左下圣遗物评分 · 右下圣遗物评级
 *   ⓑ 武器块 —— 白底，图标 + 名字 + 等级 + 精炼
 *
 * 分数为什么不再单独占一条「黑带」（2026-09-19 改版）：
 *   参考图里分数是**直接压在画像左下角**的；黑带 + 白条上下叠两层，视觉上把卡片切成四段，太重。
 *   现在只留底部一块白（装武器），上方全是画像。
 *   注意「去掉黑带」只是说不要**通栏**那条，分数自己那块半透明黑底不能省 ——
 *   星级的橙底/紫底都是亮色，奶白字不垫底看不清（见 style.css 的 .cc-score）。
 */
function renderCharCard (av) {
  const rank = rankOf(av.score.markClass)
  const card = el('div', 'char-card')
  /* 名字只挂在 tooltip 上，不进版面 */
  card.title = [av.name, `Lv.${av.level ?? '?'}`, av.weapon?.name || T('noWeapon')].join(' · ')

  /* ⓐ 星级底图 + 大头照 */
  const bg = el('div', 'cc-bg')
  if (av.rarityBg) bg.style.backgroundImage = `url("${av.rarityBg}")`

  const face = el('img', 'cc-face')
  face.src = av.imgs?.face || av.splash
  face.alt = ''
  face.loading = 'lazy'
  face.onerror = () => imgError(face)

  /* ⓑ 左上角元素图标；右上角角色等级（原来这里挂的是评级，改版挪去右下） */
  const elem = el('img', 'cc-elem')
  elem.src = av.elemIcon
  elem.alt = av.elemText || ''
  elem.onerror = () => imgError(elem)

  const lv = el('div', 'cc-lv', `Lv.${av.level ?? '?'}`)

  /* ⓒ 左下角评分：压在画像上，垫一块半透明黑胶囊（亮橙/亮紫底上不垫读不出来） */
  const score = el('div', 'cc-score', av.score.mark)

  /* ⓓ 右下角评级（档位色跟明细页共用 rankColor） */
  const badge = el('span', 'cc-rank', rank)
  badge.style.color = rankColor(rank)

  const top = el('div', 'cc-top')
  top.append(bg, face, elem, lv, score, badge)

  /* ⓔ 武器块：白底，顶替原来那条「白色等级条」的位置。
     没武器（或 miao 不认识这把）也要出这一块，整排高度才整齐 */
  const wp = el('div', 'cc-weapon')
  const wIcon = el('div', 'cc-wicon')
  if (av.weapon?.icon) wIcon.style.backgroundImage = `url("${av.weapon.icon}")`

  const wText = el('div', 'cc-wtext')
  wText.append(el('strong', '', av.weapon?.name || T('noWeapon')))
  const meta = el('span', 'cc-wmeta')
  if (av.weapon?.level) meta.append(el('b', '', `Lv.${av.weapon.level}`))
  if (av.weapon?.affix) {
    if (meta.childNodes.length) meta.append(document.createTextNode(' · '))
    meta.append(el('b', 'refine', `${T('refine')}${av.weapon.affix}`))
  }
  wText.append(meta)
  wp.append(wIcon, wText)

  card.append(top, wp)
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
 * 明细页：miao-plugin 的评分结果图（profile-detail）复刻
 *
 * 这张结果图在 miao 那边是**一张固定 600px 宽的画布**（resources/character/profile-detail.html
 * + .css），所以这里也照 600px 画布做，再由 fitDetailZoom() 把整张等比缩到屏幕宽度 ——
 * 缩下来就是同一张图的缩小版，构图和 miao 出图一致。
 *
 * 关键结构（照抄上游，不自己发明）：
 *   .basic            立绘（1400×500 左溢出，margin-left:-545px）
 *                     右上角浮信息：角色名 / UID-Lv / 天赋 a/e/q / 8 行属性表
 *                     左下角 6 个命座、右下角数据时间
 *   .arti-mark-cont   左：圣遗物总分 + 评级（按档位配色）；右：有效词条汇总 + 评分规则
 *   .artis            武器卡 + 5 件圣遗物卡（185px 宽，一格一个）
 *
 * 图片全是 tools/sync_assets.py 从 miao-plugin 仓库同步的真图：
 *   画布底图  common/bg/bg-{元素}.webp     （按属性分类的背景，见 elemLayout）
 *   立绘      meta-gs/character/{名}/imgs/splash.webp
 *   命座      meta-gs/character/{名}/icons/cons-{1..6}.webp
 *   天赋 A    common/item/atk-{武器类型}.webp
 *   天赋 E/Q  提升它的那个命座图标（miao 的 talentCons 规则）
 *   武器      meta-gs/weapon/{类型}/{名}/icon.webp
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
  bar.append(back)
  bar.append(el('span', 'detail-title', av.name))
  box.append(bar)

  /* 600px 画布（元素背景 + 缩放外壳）。
     元素类名照 miao 的 elemLayout：挂在容器上，CSS 据此选背景图和天赋底盘图 */
  const frame = el('div', 'pd-frame')
  const canvas = el('div', 'pd-canvas elem-' + (av.elem || 'hydro'))
  if (av.elemBg) canvas.style.backgroundImage = `url("${av.elemBg}")`
  const cont = el('div', 'profile-cont game-gs')
  canvas.append(cont)
  frame.append(canvas)
  box.append(frame)

  /* ===== .basic ===== */
  const basic = el('div', 'basic')

  const mainPic = el('div', 'main-pic')
  if (av.splash) mainPic.style.backgroundImage = `url("${av.splash}")`
  basic.append(mainPic)

  const detail = el('div', 'detail')
  detail.append(el('div', 'char-name', av.name))

  const lvRow = el('div', 'char-lv')
  lvRow.append(el('span', '', `UID ${av.uid} - Lv.${av.level ?? '?'}`))
  lvRow.append(el('span', 'cons-badge', `${av.cons}${T('cons')}`))
  detail.append(lvRow)

  /* 天赋 a/e/q：图标 + 等级牌。
     talent-plus = 被命座提升过，talent-crown = 原始等级满 10（戴皇冠）—— 判定来自后端 */
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

  /* 面板属性表：图标 + 名称 + 权重胶囊 + 总值 +（基础值 / 绿字） */
  if (av.attrTable?.length) {
    const ul = el('ul', 'char-attr')
    for (const r of av.attrTable) {
      const li = el('li')
      const ic = el('div', 'icon')
      ic.append(el('i', 'i-' + r.key))
      li.append(ic)
      li.append(el('div', 'title', r.label))
      const wt = el('div', 'weight')
      /* 权重 0 的项 miao 也留空位，保持列对齐 */
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

  /* 圣遗物评分汇总：左总分卡 + 右有效词条 */
  const markCont = el('div', 'arti-mark-cont')
  const statBox = el('div', 'arti-stat')
  const ret = el('div', 'arti-stat-ret')

  const boxTotal = el('div')
  boxTotal.append(el('span', '', T('artisTotal')))
  boxTotal.append(el('strong', '', av.score.mark))
  ret.append(boxTotal)

  const boxRank = el('div')
  boxRank.append(el('span', '', T('artisRank')))
  /* 档位本身按 miao 的配色上色：红(ACE/MAX) / 黄(SSS/SS) / 紫(S/A) */
  boxRank.append(el('strong', 'mark-' + rankOf(av.score.markClass), av.score.markClass))
  ret.append(boxRank)

  statBox.append(ret)
  if (av.score.classTitle) {
    statBox.append(el('div', 'arti-class-title', `${T('rule')}：${av.score.classTitle}`))
  }
  markCont.append(statBox)

  const infoBox = el('div', 'arti-info')
  const allWrap = el('div', 'arti-all-attr')
  const allUl = el('ul', 'detail attr arti-attr')
  for (const a of (av.allAttr || [])) {
    if (a && a.key) {
      const li = el('li', a.cls || 'nouse')
      const title = el('span', 'title')
      if (a.eff && a.eff !== '-') title.append(el('i', 'eff', a.eff))
      title.append(document.createTextNode(a.label))
      li.append(title)
      li.append(el('span', 'val', '+' + a.value))
      allUl.append(li)
    } else {
      allUl.append(el('li'))
    }
  }
  allWrap.append(allUl)
  infoBox.append(allWrap)
  infoBox.append(richText(el('div', 'arti-notice'),
    T('artisNotice', { tag: T('artisTag', { name: av.name }) })))
  markCont.append(infoBox)
  pd.append(markCont)

  /* 武器 + 5 件圣遗物 */
  const artis = el('div', 'artis')

  /* 武器卡：图标（右上溢出）+ 名 + 精N·Lv.N + 主副属性 + 精炼描述 */
  if (av.weapon?.name) {
    const wItem = el('div', 'item weapon')
    const wImg = el('div', 'img')
    if (av.weapon.icon) wImg.style.backgroundImage = `url("${av.weapon.icon}")`
    wItem.append(wImg)

    const wHead = el('div', 'head')
    wHead.append(el('strong', '', av.weapon.sName || av.weapon.name))
    if (av.weapon.star) wHead.append(el('div', 'star star-' + av.weapon.star))
    const wInfo = el('span', 'info')
    wInfo.append(el('span', 'affix affix-' + (av.weapon.affix ?? 1), `${T('refine')}${av.weapon.affix ?? 1}`))
    wInfo.append(document.createTextNode(` Lv.${av.weapon.level ?? '?'}`))
    wHead.append(wInfo)

    /* 主副属性贴在 head 底部（miao 里 .weapon-attr 是 .head 的子元素、absolute bottom:0，
       挂在整张卡上会掉到卡片底部去） */
    const wa = el('div', 'weapon-attr')
    for (const [k, v] of Object.entries(av.weapon.attrs || {})) {
      const d = el('div')
      d.append(el('span', '', W_ATTR_TITLE[k] || k))
      d.append(document.createTextNode(' +' + v))
      wa.append(d)
    }
    wHead.append(wa)
    wItem.append(wHead)

    const dc = el('div', 'weapon-desc-cont')
    /* miao 的描述里带 <nobr> 高亮标签，这里只取纯文本（顺手避免注入） */
    dc.append(el('div', 'weapon-desc', String(av.weapon.desc || '').replace(/<[^>]*>/g, '')))
    wItem.append(dc)

    artis.append(wItem)
  }

  for (const a of av.artifacts) artis.append(renderArtiCard(a, av.charWeight))
  pd.append(artis)

  cont.append(pd)

  const copy = el('div', 'pd-copyright')
  copy.textContent = `miao-plugin · ${T('artisRank')} ${av.score.markClass} · ${av.score.classTitle || ''}`
  cont.append(copy)

  fitDetailZoom()
}

/*
 * 把 600px 画布等比缩到屏幕宽度。
 * PC 上可用宽度 > 600，所以 scale 恒为 1 —— 就是 miao 出图的原尺寸。
 * 直接写 zoom 内联样式（不用 CSS 变量转一手，实测 var() 在这里不生效）。
 */
function fitDetailZoom () {
  const frame = document.querySelector('.pd-frame')
  if (!frame) return
  const vw = document.documentElement.clientWidth || window.innerWidth
  const avail = Math.min(vw, 760) - 16
  frame.style.zoom = String(Math.min(1, avail / 600))
}
window.addEventListener('resize', fitDetailZoom)

/* 一件圣遗物：条目结构照抄 miao 的 .item.arti（右上图标 / 头 / 词条表） */
function renderArtiCard (a, cw = {}) {
  if (a.empty) {
    const c = el('div', 'item arti empty')
    const icon = el('div', 'arti-icon')
    icon.append(el('span', 'arti-fallback', SLOT_GLYPH[a.pos] || '?'))
    c.append(icon)
    const head = el('div', 'head')
    head.append(el('strong', '', a.posName))
    c.append(head)
    c.append(el('div', 'arti-empty', T('notEquipped')))
    return c
  }

  const rank = rankOf(a.markClass)
  const c = el('div', 'item arti arti-class-' + rank)

  /* 图标：miao 的套装图标（斜切淡出），缺图时露出部位单字兜底 */
  const icon = el('div', 'arti-icon')
  icon.dataset.slot = SLOT_GLYPH[a.pos] || '?'
  const im = el('div', 'img')
  if (a.icon) im.style.backgroundImage = `url("${a.icon}")`
  icon.append(im)
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
    li.append(el('span', 'title', a.main.label))
    li.append(el('span', 'val', '+' + a.main.value))
    ul.append(li)
  }
  for (const s of a.subs) {
    const w = Number(cw[s.key] ?? 0)
    const cls = w > 79.9 ? 'great' : (w > 0 ? 'useful' : 'nouse')
    const li = el('li', cls)
    const lab = el('span', 'title')
    /* eff = 词条有效率，up-num = 这条滚了几次的小图标（按三档换色，见 CSS） */
    if (s.eff && s.eff !== '-') lab.append(el('i', 'eff', s.eff))
    if (s.upNum > 1) lab.append(el('i', 'up-num up-' + Math.min(5, s.upNum)))
    lab.append(document.createTextNode(s.label))
    li.append(lab)
    li.append(el('span', 'val', '+' + s.value))
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

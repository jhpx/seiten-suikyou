/*
 * 首页：账号头 + 角色网格 + 卡片。
 * 渲染器在加载时注册进 core.reg（renderRoster / renderRosterGrid），由编排函数统一调用。
 */

import { $, state, T, el, setBg, rankOf, weaponFallback, imgError, openDetail, reg } from './core.js'
import { sortAvatars, filteredAvatars } from './sort.js'

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
  /* 色走 miao.css 的 .mark-*（档位名就是类名后缀），跟明细页 / 圣遗物卡同一套 */
  const badge = el('span', 'cc-rank mark-' + rank, rank)

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
     但时间得跟着当前这份数据走，不能停在上一个 UID 的时刻上。
     这里报的是 **UID 级**时间（= 上次抓 enka 的时刻，view.fetchedAt 来自 fetch_log）；
     某个角色自己的时间在明细页看（av.fetchedAt）。两个粒度不许混 —— 展柜分批攒，
     用 UID 级时间去说单个角色有多新，会把 10 月 6 号的老数据说成刚抓的。 */
  $('footmeta').textContent = `${T('scoredAt')} ${view?.fetchedAt || '—'}`

  if (!view || !view.avatars.length) {
    const ph = el('div', 'placeholder')
    ph.append(el('p', '', T('noScorable')), el('p', 'dim', T('noScorableHint')))
    box.append(ph)
    return
  }

  box.append(reg.renderFilterBar?.(view))
  const slot = el('div', 'rf-grid')
  box.append(slot)
  renderRosterGrid(slot)
}

function renderRosterGrid (slot) {
  slot.innerHTML = ''
  const list = filteredAvatars(state.view)
  if (!list.length) {
    slot.append(el('div', 'placeholder', T('noMatch')))
    return
  }
  const sorted = sortAvatars(list)
  const grid = el('div', 'char-grid')
  for (const av of sorted) grid.append(renderCharCard(av))
  slot.append(grid)
}

reg.renderRoster = renderRoster
reg.renderRosterGrid = renderRosterGrid

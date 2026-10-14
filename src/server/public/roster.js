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

/*
 * 圣遗物视图的一张卡 —— 画像区与武器卡完全一样（同一套 grid、同一张 rarityBg），
 * 只把底部白块从「武器」换成「圣遗物套装构成」。
 *
 * 套装构成 = 花图标 + 名字 + 件数（「绝缘之旗印 ×4」），不搞缩写 —— 缩写（「绝4」）
 * 认不出来是哪套，而这批名字最长 7 字（华馆梦醒形骸记），10px 下一行放得下。
 * miao 的 sets 只收 >=2 件的（1 件不激活套装效果），所以最多两行：4件 或 2+2。
 * 一个套装都没带（或没带满 2 件的）时出「无圣遗物」占位，高度才整齐。
 */

/*
 * 套装图标：一套 → 一张完整的花；两套（2+2）→ 第一套的花完整打底，第二套在**右下角**
 * 裁一块楔形压上来（CSS 画那条斜切线）。第一套是件数多的那套，跟文字行顺序一致。
 *
 * 为什么用**花**：每套都出全五件，部位图不缺；而五件里花（和羽）的造型差别最大 ——
 * 沙/杯/冠在不同套之间轮廓很接近，缩到 24cqw 分不出来。
 * 为什么不各切一半：两套的花在素材里并不一样大、也不都居中，各切一半拼出来轮廓对不上，
 * 看着是两个半朵。让第一套完整兜住轮廓，整体就还是一朵花。
 */
function setIconBox (sets) {
  const box = el('div', 'cc-set-icon' + (sets.length > 1 ? ' mix' : ''))
  const piece = (src) => {
    const i = el('img')
    i.src = src || ''
    i.alt = ''
    i.onerror = () => imgError(i)
    return i
  }
  box.append(piece(sets[0].icon))
  if (sets.length > 1) box.append(piece(sets[1].icon))
  /* 两套时图标区整体挂提示：光看半张花认不出是哪两套，名字还得给一次 */
  if (sets.length > 1) box.title = sets.map(s => `${s.name} ×${s.count}`).join(' · ')
  return box
}
function renderArtiCard (av) {
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
  const badge = el('span', 'cc-rank mark-' + rank, rank)

  const top = el('div', 'cc-top')
  top.append(bg, face, elem, lv, score, badge)
  /* 画像区提示：和武器卡同一套四项，切视图不该让「这是谁」的答案变 */
  top.title = [
    av.name,
    `${T('tipLevel')} ${av.level ?? '?'}`,
    `${T('tipScore')} ${av.score.mark}`,
    `${T('tipScoreTier')} ${rank}`
  ].join(' · ')

  const sets = (av.sets || []).slice().sort((a, b) => b.count - a.count)
  const sp = el('div', 'cc-sets')
  if (!sets.length) {
    sp.append(el('div', 'cc-sets-empty', T('noArtis')))
  } else {
    const box = el('div', 'cc-sets-list')
    for (const s of sets) {
      const row = el('div', 'cc-set-row')
      row.append(el('span', '', s.name), el('b', 'cc-set-n', `×${s.count}`))
      box.append(row)
    }
    sp.append(setIconBox(sets), box)
    /* 套装区提示：五件部位的名字太长，这里报「几套什么、各几件」就够认了 */
    sp.title = [
      av.name,
      ...sets.map(s => `${s.name} ×${s.count}`)
    ].join(' · ')
  }

  card.append(top, sp)
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
  /* 两种视图只差卡片下半块：武器（默认）/ 圣遗物套装。
     画像区、网格、筛选、排序全共用 —— 视图切换不重置任何筛选条件。 */
  const draw = state.rosterMode === 'artis' ? renderArtiCard : renderCharCard
  for (const av of sorted) grid.append(draw(av))
  slot.append(grid)
}

reg.renderRoster = renderRoster
reg.renderRosterGrid = renderRosterGrid

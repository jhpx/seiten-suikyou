/*
 * 明细页：复刻 miao-plugin 的评分结果图（profile-detail）。
 * renderDetail 在加载时注册进 core.reg，由 openDetail / renderAll 调用。
 */

import {
  $, state, T, el, setBg, rankOf, slotGlyph, backToRoster, richText,
  weaponFallback, weightClass, W_ATTR_TITLE, api, reg
} from './core.js'

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
    const icon = el('div', 'talent-icon' + (i <= (av.cons ?? 0) ? '' : 'off'))
    icon.append(setBg(el('div', 'talent-icon-img'), av.imgs?.[`cons${i}`]))
    const item = el('div', 'cons-item')
    item.append(icon)
    cons.append(item)
  }
  basic.append(cons)

  const info = el('div', 'data-info')
  /* 明细页报**这个角色**的上次同步时间（av.fetchedAt），不是整个 UID 的 ——
     展柜分批攒，角色之间能差好几天，报 UID 级会把老角色说成刚抓过。 */
  if (av.fetchedAt) info.append(el('span', 'time', `${T('scoredAt')} ${av.fetchedAt}`))
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

  /* 伤害计算（miao 明细页下侧的「伤害计算」表）：先放一个 loading 骨架占位，
     数据到了再填 —— renderDetail 是同步的（reg 契约），而伤害要跑一遍评分内核。 */
  const dmgBox = el('div', 'dmg-wrap')
  cont.append(dmgBox)
  loadDamage(av, dmgBox)

  /* 画布最底下这行原来写的是出处「miao-plugin · 圣遗物评级 SS · 梦见月-星扩散」——
     评级和评分规则在 .arti-stat / .arti-class-title 里各占一块，这行只是把同样的字
     又抄了一遍，等于白占一行。改成数据时间（和首页页脚同一个键、同一句话）。 */
  /* 同上：报这个角色自己的同步时间 */
  cont.append(el('div', 'pd-scored-at', `${T('scoredAt')} ${av.fetchedAt || '—'}`))

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

/* ───────────────────────── 伤害计算（明细页下侧） ─────────────────────────
 * 结构照 miao 的 profile-detail.html「伤害表格」块：标题条 + 表格（表头 / 斑马纹数据行）
 * + 页脚（敌人等级 + 署名），下面再挂一块 Buff 列表。去掉的两样都是网页版没有对应物的：
 *   · dmg-idx 列（「#XX伤害+序号」指令选第几条用的，评分图里本来就 display:none）
 *   · 「使用#XX伤害命令可以查看伤害详情」提示（QQ 指令，同 artisNotice 的处理）
 *
 * ⚠️ renderDetail 每渲染一次都会调 loadDamage（切语言、回首页再进来都会），而 fetch 是异步的：
 *    回来时用户可能已经点了另一个角色。所以填之前必须核对还停在同一个角色上
 *    （state.selectedAvatarId === av.avatarId）—— 否则会把 A 的伤害填进 B 的页面。
 *    同一个角色重复渲染时旧请求回来也没关系：数据一样，且 box 已被 innerHTML='' 清空重建。
 */
async function loadDamage (av, box) {
  box.append(dmgStatus(T('dmgLoading')))
  let dmg = null
  try {
    dmg = await api(`/api/uid/${av.uid}/character/${av.avatarId}/damage`)
  } catch (e) {
    if (state.selectedAvatarId !== av.avatarId) return
    console.error('[damage] 明细页伤害计算失败:', e)
    box.innerHTML = ''
    box.append(dmgStatus(T('dmgFail'), true))
    return
  }
  if (state.selectedAvatarId !== av.avatarId) return
  box.innerHTML = ''
  /* data 为 null = 这个角色算不出伤害（没配 calc.js 等）—— 出一行小字说明，不出表 */
  if (!dmg) { box.append(dmgStatus(T('dmgNone'))); return }
  box.append(renderDmgList(dmg))
  if (dmg.buffs?.length) box.append(renderDmgBuffs(dmg.buffs))
}

/* 骨架 / 失败 / 无数据三种「只有一行字」的状态共用一个外壳 */
function dmgStatus (text, err = false) {
  const cont = el('div', 'dmg-cont dmg-list cont')
  cont.append(el('div', 'cont-title', T('dmgSection')))
  cont.append(el('div', 'dmg-status' + (err ? ' err' : ''), text))
  return cont
}

function dmgHead () {
  const tr = el('div', 'tr thead')
  tr.append(el('div', 'title dmg-title', T('dmgType')))
  tr.append(el('div', '', T('dmgCrit')))
  tr.append(el('div', '', T('dmgAvg')))
  return tr
}

function renderDmgList (dmg) {
  const cont = el('div', 'dmg-cont dmg-list cont')
  cont.append(el('div', 'cont-title', T('dmgSection')))
  const table = el('div', 'cont-table')
  table.append(dmgHead())
  for (const e of dmg.rows) {
    const tr = el('div', 'dmg tr')
    tr.append(el('div', 'title dmg-title', e.title))
    if (e.dmg) {
      tr.append(el('div', 'value', e.dmg + e.unit))
      tr.append(el('div', 'value', e.avg + e.unit))
    } else {
      /* 反应 / 护盾 / 治疗类不吃暴击，没有暴击伤害 —— 期望值跨两列独占一行。
         行里只发两个单元格（标题 + 期望值），跨列靠 CSS 的 grid-column，不是留个空单元格。 */
      tr.append(el('div', 'value value-full', e.avg + e.unit))
    }
    table.append(tr)
  }
  cont.append(table)
  const foot = el('div', 'cont-footer dmg-desc')
  foot.append(el('span', '', T('dmgEnemy', { lv: dmg.enemyLv, name: dmg.enemyName })))
  if (dmg.createdBy) {
    /* 冒号在文案键里（dmgSource 末尾）—— 各语言的标点不一样，不硬拼 */
    const by = el('span', 'dmg-created-by')
    by.append(document.createTextNode(T('dmgSource')))
    by.append(el('strong', '', dmg.createdBy))
    foot.append(by)
  }
  cont.append(foot)
  return cont
}

function renderDmgBuffs (buffs) {
  const cont = el('div', 'dmg-cont dmg-msg cont')
  const title = el('div', 'cont-title')
  title.append(document.createTextNode(T('dmgBuff')))
  title.append(el('span', '', T('dmgBuffTip')))
  cont.append(title)
  const table = el('div', 'cont-table')
  for (const b of buffs) {
    const tr = el('div', 'tr')
    tr.append(el('div', 'th', b.title))
    tr.append(el('div', 'td', b.desc))
    table.append(tr)
  }
  cont.append(table)
  return cont
}

reg.renderDetail = renderDetail

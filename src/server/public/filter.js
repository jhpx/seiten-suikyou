/*
 * 首页筛选条：三段 —— 排序（左）｜武器/圣遗物视图切换（中）｜漏斗筛选（右）。
 *
 * 布局规则：
 * ① 顺序 = 使用频率：先定「怎么排」，再切「看什么」，最后「收窄」。
 *    筛选是末态动作（点完就看结果），所以沉到最右；排序决定第一印象，放最左。
 * ② 视图切换居中（CSS 的 margin: 0 auto）：窄屏 wrap 成两行时它自己一行也是居中的。
 * ③ 筛选/排序只重画网格那一块（refreshRosterGrid），不重建筛选栏 ——
 *    重建会把下拉的选中态和展开态冲掉，交互断片。
 *
 * 筛选从「三个独立下拉」聚合成一个漏斗按钮 + 一个**弹窗**：三个维度（元素 / 等级 / 权重）
 * 都能多选 —— 维度内 OR、维度间 AND（选了火+水又选「吃暴击」，出的是「火或水里吃暴击的」）。
 * 弹窗（不是贴着按钮的小面板）是被逼出来的：小面板最宽只能到 300px，三组 chips 挤在里面
 * 要换行、要点中还得瞄准；而「勾三个元素再确定」本来就是一次大动作，给个大框更顺手。
 * 代价是**必须带草稿态**：弹窗里勾的只是 draft，点「确定」才写回 state.filter 并重画网格 ——
 * 否则每勾一下整页闪一次，而「取消」也没有意义了。
 *
 * 漏斗图标是自绘 inline SVG（项目没有现成的漏斗素材，也不想为一个图标引一套图标库）。
 *
 * 元素图标从名单里已有角色借、属性名由 /api/meta 返回 ——
 * 和卡片一个规矩：URL 和文案一律后端给，前端不拼路径、不写死词条名。
 *
 * 排序面板由 sort.js 提供（renderFilterBar 直接拼进来）。
 */

import { $, state, T, el, imgError, closeMenus, closeModal, openDialog, refreshRosterGrid, rosterElems, rosterRanks, dropStaleFilter, reg } from './core.js'
import { sortPanel } from './sort.js'

/* 元素选项：图标 + 名字，都从名单里已有角色身上借（URL 一律由接口返回） */
function elemOption (view, e) {
  const src = view.avatars.find(a => a.elem === e)
  const label = src?.elemText || e
  const img = el('img')
  img.src = src?.elemIcon || ''
  img.alt = label
  img.onerror = () => imgError(img)
  const node = el('span', 'rf-opt-elem')
  node.append(img, el('span', '', label))
  return { value: e, label, node }
}

/* 漏斗图标：上口宽、下管细的滤斗形。描边继承文字色（currentColor），
   激活/展开态跟着按钮文字一起变金，不用再写一套换色规则。 */
function funnelIcon () {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  svg.setAttribute('viewBox', '0 0 16 16')
  svg.setAttribute('aria-hidden', 'true')
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path')
  path.setAttribute('d', 'M1.5 2h13L9.2 7.6v6.1l-2.4-1.4V7.6L1.5 2z')
  path.setAttribute('fill', 'none')
  path.setAttribute('stroke', 'currentColor')
  path.setAttribute('stroke-width', '1.6')
  path.setAttribute('stroke-linejoin', 'round')
  svg.append(path)
  return svg
}

/* ───────────────────────── 筛选弹窗 ─────────────────────────
 * 壳子（遮罩 / 头 / 底 / Esc / 取消）走 core 的 openDialog，这里只管内容：
 * 三组 chips + 「勾的是草稿、确定才写回」。
 * 草稿是必须的：否则每勾一下整页闪一次，而「取消」也就没意义了。 */

/*
 * 一枚 chip：选中 = 金底金字。
 * 点的是 draft（草稿），不碰 state.filter —— 弹窗关掉前网格不该动。
 * paint / draft 都由调用方传进来：chip 是顶层函数，那两个是弹窗内的闭包，
 * 直接在 handler 里引用会因作用域链够不着而 ReferenceError。
 */
function chip (group, item, draft, paint) {
  const b = el('button', 'rf-chip')
  b.type = 'button'
  b.dataset.val = item.value
  b.append(item.node || document.createTextNode(item.label))
  b.addEventListener('click', () => {
    const arr = draft[group]
    const i = arr.indexOf(item.value)
    if (i < 0) arr.push(item.value)
    else arr.splice(i, 1)
    paint()
  })
  return b
}

/* 弹窗内容：`view` 取候选（元素/等级按名单裁剪），`paintBadge` 是漏斗角标的重画函数 */
function filterModal (view, paintBadge) {
  /* 候选先裁旧值再开草稿：换了 UID 之后上一份名单里选过的元素可能根本不存在，
     带着它进草稿会「面板里没一个亮着、结果却是空的」 */
  const elems = rosterElems(view)
  const ranks = rosterRanks(view)
  dropStaleFilter('elem', elems)
  dropStaleFilter('rank', ranks)
  const draft = {
    elem: [...state.filter.elem],
    rank: [...state.filter.rank],
    weight: [...state.filter.weight]
  }

  /* groups 与 .rf-fchips 容器按 DOM 顺序一一对应，paint() 靠这个配对点亮 */
  const groups = []
  let paint = () => {}
  const dlg = openDialog({
    title: T('filterTitle'),
    onOk: () => {
      for (const g of groups) state.filter[g.key] = [...draft[g.key]]
      paintBadge()
      refreshRosterGrid()
    },
    onClear: () => {
      for (const g of groups) draft[g.key] = []
      paint()
    }
  })
  const body = dlg.body

  /* groups 与 .rf-fchips 容器按 DOM 顺序一一对应，paint() 靠这个配对点亮 */
  const addGroup = (key, titleKey, items) => {
    const g = el('div', 'rf-fgroup')
    g.append(el('div', 'rf-fgroup-title', T(titleKey)))
    const box = el('div', 'rf-fchips')
    for (const it of items) box.append(chip(key, it, draft, () => paint()))
    g.append(box)
    body.append(g)
    groups.push({ key })
  }

  addGroup('elem', 'filterElem', elems.map(e => elemOption(view, e)))
  addGroup('rank', 'filterRank', ranks.map(r => ({ value: r, label: r })))
  /* 权重那四个选项是固定的 taxonomy，不按名单裁剪 —— 点出空结果也是有效信息
     （「我这号里没人吃防御」），裁剪掉反而看不出来 */
  addGroup('weight', 'filterWeight', state.weightOptions.map(o => ({ value: o.key, label: o.label })))

  paint = () => {
    let n = 0
    const boxes = [...body.querySelectorAll('.rf-fchips')]
    for (let i = 0; i < boxes.length; i++) {
      const cur = draft[groups[i].key]
      n += cur.length
      for (const c of boxes[i].children) c.classList.toggle('active', cur.includes(c.dataset.val))
    }
    dlg.count.textContent = n ? T('filterPicked', { n }) : ''
    /* 清空钮：没得清就藏起来（visibility，不改布局），弹窗里不留一颗点了没反应的钮 */
    dlg.clear.style.visibility = n ? 'visible' : 'hidden'
  }

  paint()
}

/*
 * 漏斗筛选：一颗按钮，点了开弹窗。
 * 按钮平时只画漏斗；有选中时右上角挂数字角标（不写「已选 N 项」文字 ——
 * 按钮就那么宽，写上就把漏斗挤变形了，全称挂 title）。
 */
function filterPanel (view) {
  const dd = el('div', 'rf-filter')
  const btn = el('button', 'rf-dd-btn rf-funnel-btn')
  btn.type = 'button'
  const badge = el('span', 'rf-funnel-badge')
  btn.append(funnelIcon(), badge)

  const paintBadge = () => {
    const n = state.filter.elem.length + state.filter.rank.length + state.filter.weight.length
    badge.textContent = n ? String(n) : ''
    badge.classList.toggle('on', n > 0)
    btn.title = n ? T('filterActive', { n }) : T('filterTitle')
    btn.classList.toggle('active', n > 0)
  }

  btn.addEventListener('click', () => {
    closeMenus()
    /* 已经开着就当「再点一次 = 收起（丢弃草稿）」，不然按钮看着没反应 */
    if (document.querySelector('.rf-mask')) { closeModal(); return }
    filterModal(view, paintBadge)
  })

  paintBadge()
  dd.append(btn)
  return dd
}

/*
 * 视图切换：一颗按钮，**点一下换下一个视图**（武器 → 圣遗物 → 回到武器）。
 *
 * 不做左右分段的 segmented：那种壳子一眼看过去只有「两半」，天生暗示只有两种状态，
 * 加第三个视图就得重排版式。循环按钮只显示「当前是哪个」，点一下走下一个，
 * 视图再多也是同一颗按钮 —— 文案永远是当前的那个，不用给未选中的状态留位置。
 *
 * 它**不用**循环箭头之类的记号（用户 2026-10-14 点名不要），改用**不一样的框**：
 * 实心金底 + 全圆角胶囊，和右边两颗「深色玻璃 + 方角」的按钮一眼分得开 ——
 * 右边两颗是「点开弹窗去选」，这一颗是「点一下就换状态」，本来就不是一类东西。
 *
 * 标签存 i18n **键**而不是 `T()` 的结果：模块加载时 state.ui 还是空的，
 * 顶层调 T() 会把裸键名永久存进按钮里。渲染时现调（见 MEMORY ⑦）。
 */
const VIEWS = [
  { key: 'weapon', labelKey: 'viewWeapon' },
  { key: 'artis', labelKey: 'viewArtis' }
]

function viewSwitch () {
  const btn = el('button', 'rf-switch-btn')
  btn.type = 'button'
  const label = el('span', 'rf-switch-text', T(VIEWS[0].labelKey))
  btn.append(label)

  const paint = () => {
    const i = Math.max(0, VIEWS.findIndex(v => v.key === state.rosterMode))
    const next = VIEWS[(i + 1) % VIEWS.length]
    label.textContent = T(VIEWS[i].labelKey)
    /* 提示报「下一个是什么」—— 按钮上写的是当前状态，光看文案不知道点下去会变成谁 */
    btn.title = T('viewSwitchHint', { next: T(next.labelKey) })
    btn.dataset.mode = VIEWS[i].key
  }

  btn.addEventListener('click', () => {
    const i = Math.max(0, VIEWS.findIndex(v => v.key === state.rosterMode))
    state.rosterMode = VIEWS[(i + 1) % VIEWS.length].key
    paint()
    refreshRosterGrid()
  })

  paint()
  return btn
}

function renderFilterBar (view) {
  /* 换 UID / 重画首页时把可能还开着的弹窗收掉 —— 它的候选是按上一份名单算的，留着就是脏的 */
  closeModal()
  const bar = el('div', 'roster-filter')

  /* 顺序 = 视图切换（左）｜排序 + 筛选（右，两颗挨在一起）。
     左边这颗是「状态」（当前看什么），右边两颗是「操作」（弹窗去选），按性质分边站。 */
  bar.append(viewSwitch())
  bar.append(sortPanel())
  bar.append(filterPanel(view))

  return bar
}

reg.renderFilterBar = renderFilterBar

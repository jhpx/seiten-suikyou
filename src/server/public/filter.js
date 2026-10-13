/*
 * 首页筛选条：三个下拉（元素 / 评分等级 / 属性权重）+ 排序。
 * 选项收进下拉而不是平铺成 chips：三组平铺要占三行，520px 宽下把角色网格挤下去一大截。
 *
 * 两条规则：
 * ① 筛选/排序只重画网格那一块（refreshRosterGrid），不重建筛选栏 ——
 *    重建会把下拉的选中态和展开态冲掉，交互断片。
 * ② 元素图标从名单里已有角色借、属性名由 /api/meta 下发 ——
 *    和卡片一个规矩：URL 和文案一律后端给，前端不拼路径、不写死词条名。
 *
 * 排序面板由 sort.js 提供（renderFilterBar 直接拼进来）。
 */

import { $, state, T, el, imgError, closeMenus, refreshRosterGrid, rosterElems, rosterRanks, dropStaleFilter, reg } from './core.js'
import { sortDropdown } from './sort.js'

/* 元素选项：图标 + 名字，都从名单里已有角色身上借（URL 一律后端下发） */
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

/*
 * 一个下拉筛选：按钮 + 竖排面板。
 * 按钮平时只写组名，选中后写「组名·值」—— 不写成「选中就把组名换成值」，
 * 那样「权重·攻击力」会缩成光秃秃的「攻击力」，看不出这颗按钮管的是权重。
 * 值长了用省略号截（按钮宽度不跟着文案乱跳），全称挂 title。
 * items 是 [{ value, label, node? }]，node 缺省时直接渲染 label。
 */
function filterDropdown (labelKey, key, items, store = state.filter, withAll = true, endAlign = false) {
  const dd = el('div', endAlign ? 'rf-dd rf-dd-end' : 'rf-dd')
  const btn = el('button', 'rf-dd-btn')
  btn.type = 'button'
  const text = el('span', 'rf-dd-text')
  btn.append(text, el('span', 'rf-caret', '▾'))

  const options = (withAll ? [{ value: '', label: T('filterAll') }] : []).concat(items)
  const menu = el('div', 'rf-menu')

  const paint = () => {
    const cur = store[key]
    const name = options.find(o => o.value === cur)?.label || cur
    text.textContent = cur ? `${T(labelKey)}·${name}` : T(labelKey)
    btn.title = cur ? `${T(labelKey)}：${name}` : T(labelKey)
    btn.classList.toggle('active', !!cur)
    for (const b of menu.children) b.classList.toggle('active', b.dataset.val === cur)
  }

  for (const o of options) {
    const b = el('button', 'rf-opt')
    b.type = 'button'
    b.dataset.val = o.value
    b.append(o.node || document.createTextNode(o.label))
    b.addEventListener('click', () => {
      store[key] = o.value
      paint()
      closeMenus()
      refreshRosterGrid()
    })
    menu.append(b)
  }

  btn.addEventListener('click', () => {
    const open = !dd.classList.contains('open')
    closeMenus()
    dd.classList.toggle('open', open)
  })

  paint()
  dd.append(btn, menu)
  return dd
}

function renderFilterBar (view) {
  const bar = el('div', 'roster-filter')

  const elems = rosterElems(view)
  dropStaleFilter('elem', elems)
  bar.append(filterDropdown('filterElem', 'elem', elems.map(e => elemOption(view, e))))

  const ranks = rosterRanks(view)
  dropStaleFilter('rank', ranks)
  bar.append(filterDropdown('filterRank', 'rank', ranks.map(r => ({ value: r, label: r }))))

  /* 权重那四个选项是固定的 taxonomy，不按名单裁剪 —— 点出空结果也是有效信息
     （「我这号里没人吃防御」），裁剪掉反而看不出来 */
  bar.append(filterDropdown('filterWeight', 'weight',
    state.weightOptions.map(o => ({ value: o.key, label: o.label })), state.filter, true, true))

  /* 排序：一个下拉里选至多 3 个字段，按优先级从上到下排，各自设升降序 */
  bar.append(sortDropdown())

  return bar
}

reg.renderFilterBar = renderFilterBar

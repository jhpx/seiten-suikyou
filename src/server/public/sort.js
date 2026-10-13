/*
 * 首页排序：一个下拉里选至多 3 个字段，按优先级从上到下排，各自设升降序。
 * 排序字段只存 i18n 键、不存渲染好的文案 —— 模块加载时 state.ui 还是空，
 * 那时调 T() 会回退成裸键（之前就因此显示成「排序-sortScore」）。文案在 paint() 渲染时现取。
 */

import { $, state, T, el, closeMenus, refreshRosterGrid, rosterElems, rosterRanks } from './core.js'

/* 排序字段：顺序固定，但谁能进排序链、排第几由用户点。只存 i18n 键。 */
const SORT_FIELDS = [
  { key: 'level', labelKey: 'sortLevel' },
  { key: 'mark', labelKey: 'sortScore' },
  { key: 'time', labelKey: 'sortTime' }
]
const sortFieldLabel = (key) => {
  const f = SORT_FIELDS.find(x => x.key === key)
  return f ? T(f.labelKey) : key
}

/* 多条件排序下拉：面板里列出三个字段，已选的带头标①②③和升降序/上下移/移除，
   未选的带「+」添加；最多 3 项。链顺序 = 优先级（从高到低）。
   面板不点外面不关 —— 一次要设好几个条件，选中即重画网格但菜单保持开着。 */
function sortDropdown () {
  const dd = el('div', 'rf-dd rf-dd-end')
  const btn = el('button', 'rf-dd-btn')
  btn.type = 'button'
  const text = el('span', 'rf-dd-text')
  btn.append(text, el('span', 'rf-caret', '▾'))

  const menu = el('div', 'rf-menu rf-sort-menu')

  const paint = () => {
    const n = state.sort.length
    if (!n) text.textContent = T('sortBy')
    else if (n === 1) text.textContent = `${T('sortBy')}·${sortFieldLabel(state.sort[0].key)}`
    else text.textContent = `${T('sortBy')}·${n}`
    btn.classList.toggle('active', n > 0)

    menu.innerHTML = ''
    const inChain = new Set(state.sort.map(s => s.key))
    /* 已选项按链顺序排前，未选项跟后 —— 用户一眼看出当前优先级 */
    const order = [...state.sort.map(s => s.key), ...SORT_FIELDS.map(f => f.key).filter(k => !inChain.has(k))]
    for (const key of order) {
      const row = el('div', 'rf-sort-row')
      const pos = state.sort.findIndex(s => s.key === key)
      if (pos < 0) {
        const name = el('span', 'rf-sort-name', sortFieldLabel(key))
        const add = el('button', 'rf-sort-mini rf-sort-add')
        add.type = 'button'; add.textContent = '+'; add.title = T('sortAdd')
        add.disabled = state.sort.length >= 3
        add.addEventListener('click', e => {
          e.stopPropagation()
          if (state.sort.length < 3) state.sort.push({ key, dir: 'desc' })
          paint(); refreshRosterGrid()
        })
        row.append(name, add)
      } else {
        const cond = state.sort[pos]
        const badge = el('span', 'rf-sort-pos', String(pos + 1))
        const name = el('span', 'rf-sort-name', sortFieldLabel(key))
        const dir = el('button', 'rf-sort-mini')
        dir.type = 'button'
        dir.textContent = cond.dir === 'asc' ? '▲' : '▼'
        dir.title = cond.dir === 'asc' ? T('sortAsc') : T('sortDesc')
        dir.addEventListener('click', e => {
          e.stopPropagation()
          cond.dir = cond.dir === 'asc' ? 'desc' : 'asc'
          paint(); refreshRosterGrid()
        })
        const up = el('button', 'rf-sort-mini')
        up.type = 'button'; up.textContent = '↑'; up.title = T('sortUp'); up.disabled = pos === 0
        up.addEventListener('click', e => {
          e.stopPropagation()
          if (pos > 0) { [state.sort[pos - 1], state.sort[pos]] = [state.sort[pos], state.sort[pos - 1]]; paint(); refreshRosterGrid() }
        })
        const down = el('button', 'rf-sort-mini')
        down.type = 'button'; down.textContent = '↓'; down.title = T('sortDown'); down.disabled = pos === state.sort.length - 1
        down.addEventListener('click', e => {
          e.stopPropagation()
          if (pos < state.sort.length - 1) { [state.sort[pos + 1], state.sort[pos]] = [state.sort[pos], state.sort[pos + 1]]; paint(); refreshRosterGrid() }
        })
        const rm = el('button', 'rf-sort-mini')
        rm.type = 'button'; rm.textContent = '×'; rm.title = T('sortRemove')
        rm.addEventListener('click', e => {
          e.stopPropagation()
          state.sort.splice(pos, 1)
          paint(); refreshRosterGrid()
        })
        row.append(badge, name, dir, up, down, rm)
      }
      menu.append(row)
    }
    const hint = el('div', 'rf-sort-hint', T('sortHint'))
    menu.append(hint)
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

/* 排序链比较：依次按第 1、2、3 个条件比，遇到不等的就定胜负；全相等才并列。
   取值：时间取格式化串做字典序（YYYY-MM-DD HH:MM:SS 同序于时间先后），数字取原始值。 */
function sortAvatars (list) {
  const val = (a, key) => {
    if (key === 'level') return a.level ?? 0
    if (key === 'mark') return a.score?.markValue ?? 0
    if (key === 'time') return a.fetchedAt || ''
    return 0
  }
  return [...list].sort((a, b) => {
    for (const { key, dir } of state.sort) {
      const d = dir === 'asc' ? 1 : -1
      const va = val(a, key), vb = val(b, key)
      if (va < vb) return -d
      if (va > vb) return d
    }
    return 0
  })
}

function filteredAvatars (view) {
  const f = state.filter
  return view.avatars
    .filter(a => !f.elem || a.elem === f.elem)
    .filter(a => !f.rank || a.score.markClass === f.rank)
    /* 权重筛选：这一项权重不为 0 就算命中 —— 表里给 0 的，就是这个角色不吃这条属性 */
    .filter(a => !f.weight || (a.charWeight?.[f.weight] || 0) !== 0)
}

export { sortAvatars, filteredAvatars, sortDropdown }

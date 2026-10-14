/*
 * 首页排序：一个**弹窗**里选至多 3 个字段，按优先级从上到下排，各自设升降序；点「确定」才生效。
 * 排序字段只存 i18n 键、不存渲染好的文案 —— 模块加载时 state.ui 还是空，
 * 那时调 T() 会回退成裸键（之前就因此显示成「排序-sortScore」）。文案在渲染时现取。
 *
 * 按钮文案必须**自己说清当前排成什么样**（用户 2026-10-14）：
 *   单条件 → 「排序：评价等级 ↓」（字段 + 方向一个都不能少，否则看不出是升还是降）
 *   多条件 → 「排序：条件排序」（三条名字全铺上去按钮放不下，只报性质）
 * 弹窗里勾的是草稿，确定才写回 —— 和筛选同一个规矩，不然每点一下箭头整页闪一次。
 */

import { $, state, T, el, closeMenus, closeModal, openDialog, refreshRosterGrid, rosterElems, rosterRanks } from './core.js'

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

/* 排序按钮 + 弹窗。按钮只报「当前排成什么样」，具体编辑在弹窗里做。
   caret 用 ▾（表意「展开」）—— 升降序已经写在按钮文案里了，不需要再用 ↕ 提示。 */
function sortPanel () {
  const wrap = el('div', 'rf-sort')
  const btn = el('button', 'rf-dd-btn')
  btn.type = 'button'
  const text = el('span', 'rf-dd-text')
  btn.append(text, el('span', 'rf-caret', '▾'))

  const paintBtn = () => {
    const n = state.sort.length
    if (!n) text.textContent = T('sortBy')
    else if (n === 1) {
      const s = state.sort[0]
      text.textContent = `${T('sortBy')}：${sortFieldLabel(s.key)} ${s.dir === 'asc' ? '↑' : '↓'}`
    } else text.textContent = `${T('sortBy')}：${T('sortMulti')}`
    btn.classList.toggle('active', n > 0)
  }

  btn.addEventListener('click', () => {
    closeMenus()
    openSortDialog(paintBtn)
  })

  paintBtn()
  wrap.append(btn)
  return wrap
}

/* 排序弹窗：草稿 = state.sort 的一份拷贝，确定才写回 */
function openSortDialog (paintBtn) {
  const draft = state.sort.map(s => ({ ...s }))
  const dlg = openDialog({
    title: T('sortBy'),
    onOk: () => { state.sort = draft; paintBtn(); refreshRosterGrid() },
    onClear: () => { draft.length = 0; paintBody() }
  })
  const body = dlg.body

  const paintBody = () => {
    body.innerHTML = ''
    const inChain = new Set(draft.map(s => s.key))
    /* 已选项按链顺序排前，未选项跟后 —— 用户一眼看出当前优先级 */
    const order = [...draft.map(s => s.key), ...SORT_FIELDS.map(f => f.key).filter(k => !inChain.has(k))]
    for (const key of order) {
      const row = el('div', 'rf-sort-row')
      const pos = draft.findIndex(s => s.key === key)
      if (pos < 0) {
        const name = el('span', 'rf-sort-name', sortFieldLabel(key))
        const add = el('button', 'rf-sort-mini rf-sort-add')
        add.type = 'button'; add.textContent = '+'; add.title = T('sortAdd')
        add.disabled = draft.length >= 3
        add.addEventListener('click', () => {
          if (draft.length < 3) draft.push({ key, dir: 'desc' })
          paintBody()
        })
        row.append(name, add)
      } else {
        const cond = draft[pos]
        const badge = el('span', 'rf-sort-pos', String(pos + 1))
        const name = el('span', 'rf-sort-name', sortFieldLabel(key))
        const dir = el('button', 'rf-sort-mini')
        dir.type = 'button'
        dir.textContent = cond.dir === 'asc' ? '▲' : '▼'
        dir.title = cond.dir === 'asc' ? T('sortAsc') : T('sortDesc')
        dir.addEventListener('click', () => {
          cond.dir = cond.dir === 'asc' ? 'desc' : 'asc'
          paintBody()
        })
        const up = el('button', 'rf-sort-mini')
        up.type = 'button'; up.textContent = '↑'; up.title = T('sortUp'); up.disabled = pos === 0
        up.addEventListener('click', () => {
          if (pos > 0) { [draft[pos - 1], draft[pos]] = [draft[pos], draft[pos - 1]]; paintBody() }
        })
        const down = el('button', 'rf-sort-mini')
        down.type = 'button'; down.textContent = '↓'; down.title = T('sortDown'); down.disabled = pos === draft.length - 1
        down.addEventListener('click', () => {
          if (pos < draft.length - 1) { [draft[pos + 1], draft[pos]] = [draft[pos], draft[pos + 1]]; paintBody() }
        })
        const rm = el('button', 'rf-sort-mini')
        rm.type = 'button'; rm.textContent = '×'; rm.title = T('sortRemove')
        rm.addEventListener('click', () => { draft.splice(pos, 1); paintBody() })
        row.append(badge, name, dir, up, down, rm)
      }
      body.append(row)
    }
    body.append(el('div', 'rf-sort-hint', T('sortHint')))
    dlg.count.textContent = draft.length ? T('filterPicked', { n: draft.length }) : ''
  }

  paintBody()
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
  /* 多选：维度内 OR（选了火+水 → 火或水都留）、维度间 AND（元素和等级同时成立）。
     每个维度空数组 = 不限。 */
  return view.avatars
    .filter(a => !f.elem.length || f.elem.includes(a.elem))
    .filter(a => !f.rank.length || f.rank.includes(a.score.markClass))
    /* 权重筛选：这一项权重不为 0 就算命中 —— 表里给 0 的，就是这个角色不吃这条属性 */
    .filter(a => !f.weight.length || f.weight.some(w => (a.charWeight?.[w] || 0) !== 0))
}

export { sortAvatars, filteredAvatars, sortPanel }

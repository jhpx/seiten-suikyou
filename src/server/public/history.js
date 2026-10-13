/*
 * UID 输入历史：用 localStorage 存最近用过的 UID，渲染成 <datalist>。
 * 原生 autocomplete 对 preventDefault 的表单不可靠，所以自己维护。
 * renderUidHistory 注册进 core.reg，由 bootstrap 的 boot() 调用。
 */

import { $, el, state, reg } from './core.js'

const UID_HISTORY_KEY = 'st.uids'

function uidHistory () {
  try {
    const list = JSON.parse(localStorage.getItem(UID_HISTORY_KEY) || '[]')
    return Array.isArray(list) ? list.map(String) : []
  } catch { return [] }
}

function renderUidHistory () {
  const dl = $('uidHistory')
  dl.innerHTML = ''
  for (const u of uidHistory()) {
    const o = el('option', '', u)
    o.value = u
    dl.append(o)
  }
}

function rememberUid (uid) {
  const s = String(uid)
  const list = [s, ...uidHistory().filter(u => u !== s)].slice(0, 8)
  localStorage.setItem(UID_HISTORY_KEY, JSON.stringify(list))
  renderUidHistory()
}

/* 这个 uid 成了「当前」：写进内存、存会话、进历史下拉 */
function persistUid (uid) {
  state.uid = Number(uid)
  localStorage.setItem('st.uid', String(uid))
  rememberUid(uid)
}

reg.renderUidHistory = renderUidHistory

export { uidHistory, renderUidHistory, rememberUid, persistUid }

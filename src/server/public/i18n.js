/*
 * 界面多语言：拉取 / 切换 / 应用静态文案。
 * 渲染器注册进 core.reg（loadMeta / applyStaticUi），由 bootstrap 的 boot() 调用。
 */

import { $, state, T, api, uidApiUrl, syncUrl, showLoading, renderAll, banner, reg } from './core.js'

/* 拉一次界面文字表 —— 语言解析的规则在后端，这里只负责拿回来 */
async function loadMeta (locale) {
  const meta = await api(`/api/meta?locale=${encodeURIComponent(locale)}`)
  state.ui = meta.ui || {}
  state.weightOptions = meta.weightOptions || []
  return meta
}

async function changeLocale (locale) {
  state.locale = locale
  localStorage.setItem('st.locale', locale)
  try { await loadMeta(locale) } catch {}
  applyStaticUi()
  syncUrl()
  if (!state.uid) { renderAll(); return }
  showLoading(T('switching'))
  try {
    state.view = await api(uidApiUrl(state.uid))
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
  $('fetch').textContent = T('fetch')
  $('fetch').title = T('fetchTip')
  $('localeLabel').textContent = T('localeLabel')
  $('uid').placeholder = T('uidLabel')
}

reg.loadMeta = loadMeta
reg.applyStaticUi = applyStaticUi

export { loadMeta, changeLocale, applyStaticUi }

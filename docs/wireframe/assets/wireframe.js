/* 首页两种视图态切换；其他分节没有这个控件，直接跳过 */
const sw = document.querySelector('[data-switch="roster"]')
if (sw) {
  sw.addEventListener('click', e => {
    const btn = e.target.closest('button')
    if (!btn) return
    for (const b of sw.querySelectorAll('button')) b.classList.toggle('on', b === btn)
    for (const v of document.querySelectorAll('[data-roster]')) v.classList.toggle('on', v.dataset.roster === btn.dataset.v)
    const label = document.getElementById('viewSwitchLabel')
    if (label) label.textContent = btn.dataset.v === 'weapon' ? '武器视图' : '套装视图'
  })
}

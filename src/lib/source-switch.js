/**
 * 服务器切换器（老板 2026-09-14）
 *
 * 「只登录 abs 时不显示 nd 的东西；两个都登录时分开显示，右上角弄个切换按钮；
 *   只登录 nd 也不显示 abs 的东西」
 *
 * 形态（照抄老板口述）：
 *  - **只登录一台** → 整个切换器不渲染（右上角什么都没有），界面里也不会出现另一家的东西。
 *  - **两台都登录** → 右上角出现一枚按钮，显示当前源的简称（ABS / ND），点开是二选一菜单；
 *    切换后当前页重渲染，标题也会带上源名（"我的书架 · Navidrome"）。
 *
 * 为什么按钮放右上角：老板原话「右上角弄个切换按钮」；书架页右上角原先只有齿轮
 * （已挪到底栏），位置正好空着。
 */
import { hub, SOURCES } from './servers.js'
import { icon } from './icons.js'
import { haptic } from './haptics.js'

/**
 * 生成切换器 HTML（只有一源时返回空串）
 * @param {string} view 当前视图 id（切换后回到同一视图）
 */
export function sourceSwitchHTML(view = 'kidhome') {
  if (!hub.multi) return ''
  const cur = hub.active
  const s = SOURCES[cur] || SOURCES.abs
  return `<button class="src-btn" id="srcSwitch" data-view="${view}" aria-label="切换服务器">
    <span class="src-dot src-${cur}"></span>${s.short}
  </button>`
}

/** 绑定切换器（元素不存在时静默返回，绝不抛） */
export function wireSourceSwitch(root, { go, rerender } = {}) {
  const btn = root.querySelector('#srcSwitch')
  if (!btn) return
  btn.onclick = () => {
    haptic.tap()
    openSourceMenu(btn, { go, rerender })
  }
}

function openSourceMenu(anchor, { go, rerender } = {}) {
  document.querySelectorAll('.src-menu').forEach(e => e.remove())
  const cur = hub.active
  const menu = document.createElement('div')
  menu.className = 'src-menu'
  menu.innerHTML = hub.available.map(k => {
    const s = SOURCES[k]
    return `<button class="src-item ${k === cur ? 'on' : ''}" data-src="${k}">
      <span class="src-dot src-${k}"></span>
      <span class="src-label">${s.label}</span>
      ${k === cur ? `<span class="src-check">${icon('check', 18)}</span>` : ''}
    </button>`
  }).join('')
  document.body.appendChild(menu)

  // 定位到按钮下方（考虑屏幕右侧边界）
  const r = anchor.getBoundingClientRect()
  const w = 200
  const left = Math.max(10, Math.min(r.right - w, window.innerWidth - w - 10))
  menu.style.top = (r.bottom + 6) + 'px'
  menu.style.left = left + 'px'

  const close = () => menu.remove()
  menu.addEventListener('click', async e => {
    const b = e.target.closest('[data-src]')
    if (!b) { close(); return }
    const src = b.dataset.src
    close()
    if (src === hub.active) return
    await hub.setActivePersist(src)
    haptic.select()
    if (typeof rerender === 'function') await rerender()
    else if (typeof go === 'function') await go(anchor.dataset.view || 'kidhome')
  })
  // 点别处关闭
  setTimeout(() => {
    const h = ev => { if (!menu.contains(ev.target)) { close(); document.removeEventListener('click', h) } }
    document.addEventListener('click', h)
  }, 0)
}

/**
 * 底部三页签（书架 / 找书 / 设置）
 *
 * 抽出来共用，是为了避免"某个页面漏掉底栏"——之前书架页和搜索页各写了一份，
 * 设置页干脆没有，导致同一个 App 里三个 Tab 的导航形态不一致
 * （用户反馈：搜索页有底栏、设置页只有左上角返回）。
 */
import { icon } from './icons.js'
import { haptic } from './haptics.js'

const TABS = [
  { nav: 'kidhome', ic: 'books', label: '书架' },
  { nav: 'search', ic: 'search', label: '找书' },
  { nav: 'settings', ic: 'cog', label: '设置' },
]

/**
 * 生成底栏 HTML
 * @param {string} active 当前页签（kidhome / search / settings）
 */
export function kidTabsHTML(active) {
  return `<div class="kid-tabs">${TABS.map(t => `
    <button class="kid-tab${t.nav === active ? ' active' : ''}" data-nav="${t.nav}">
      <span class="ic">${icon(t.ic, 24)}</span>${t.label}
    </button>`).join('')}</div>`
}

/**
 * 绑定底栏点击。进设置页要家长密码（儿童模式的出口），其余直接跳。
 * @param {HTMLElement} root
 * @param {{go:Function, requireParentPin:Function}} deps
 */
export function wireKidTabs(root, { go, requireParentPin }) {
  const el = root.querySelector('.kid-tabs')
  if (!el) return
  el.querySelectorAll('[data-nav]').forEach(b => {
    const nav = b.dataset.nav
    b.onclick = async () => {
      haptic.tap()
      // 老板 2026-09-13：只有「家长设置」需要密码；普通设置页直接进。
      // （原来整个 settings 页都拦，普通用户改语音开关也要输密码，太重。）
      go(nav)
    }
  })
}

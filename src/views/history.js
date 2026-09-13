/**
 * 历史记录页（老板 2026-09-14）
 *
 * 首页只露最近 3 条预览，完整列表在这里。点「历史记录」入口进入。
 *
 * 为什么不是简单的「继续听」复制：
 *  ① 首页那份要短小（3 条预览），这份是完整清单；
 *  ② 数据源必须和首页同一套口径（服务端 items-in-progress + 本地补记合并），
 *     并且都过滤掉用户在服务端隐藏过的书 —— 审计发现 ABS 的
 *     /api/me/items-in-progress 会把 hideFromContinueListening=true 的书照样返回，
 *     所以过滤必须放在客户端（详见 lib/history.js）。
 *  ③ 长按删除：调 ABS 的 remove-from-continue-listening（真删服务端记录），
 *     同时清本地补记，并标记本地隐藏集合，避免用户再次长按前它又冒出来。
 */
import { state, go, toast, esc, playItem, updateMini, fmtDur } from '../app.js'
import { abs } from '../lib/api.js'
import { fallbackCover, wireCoverFallback } from '../lib/cover.js'
import { loadHistory, removeHistoryEntry } from '../lib/history.js'
import { icon } from '../lib/icons.js'
import { kidTabsHTML, wireKidTabs } from '../lib/nav.js'
import { requireParentPin } from '../app.js'
import { haptic } from '../lib/haptics.js'

export async function renderHistory(root, params = {}) {
  root.innerHTML = `
    <div class="page-head">
      <button class="icon-btn" id="btnBack" aria-label="返回">${icon('back', 22)}</button>
      <div class="page-title">历史记录</div>
    </div>
    <div id="hlist"><div class="empty"><div class="glyph">${icon('loader', 40, 'spin')}</div>正在加载…</div></div>
  `

  const $ = s => root.querySelector(s)
  $('#btnBack').onclick = () => { haptic.tap(); go('kidhome') }

  let entries = []
  try {
    entries = await loadHistory()
  } catch (e) {
    $('#hlist').innerHTML = `<div class="empty"><div class="glyph">${icon('warning', 44)}</div>${esc(e.message)}</div>`
    return
  }

  const paint = () => {
    if (!entries.length) {
      $('#hlist').innerHTML = `<div class="empty" style="margin-top:40px">
        <div class="glyph">${icon('list', 44)}</div>
        还没有收听记录<br>
        <span style="font-size:13px">开始听一本书，这里就会留下记录</span>
      </div>`
      return
    }
    $('#hlist').innerHTML = entries.map(e => {
      const m = e.media?.metadata || {}
      const pct = e.pct || 0
      const tail = e.finished ? '已听完' : (pct > 0 ? `已听 ${pct}%` : '未开始')
      return `<div class="list-item" data-id="${e.id}" data-hist="1">
        <div class="cover-slot">
          ${fallbackCover({ title: m.title, author: m.authorName || m.narratorName, cls: 'cover-ph-list' })}
          <img class="list-cover" data-cover src="${abs.coverUrl(e.id, { width: 160 })}" alt="" loading="lazy">
        </div>
        <div class="list-main">
          <div class="list-title">${esc(m.title || '未命名')}</div>
          <div class="list-sub">${esc(m.authorName || m.narratorName || '')}</div>
        </div>
        <div class="list-pct">${tail}</div>
      </div>`
    }).join('')
    wireCoverFallback($('#hlist'))
    bindRows()
  }

  // 重入防护（老板 2026-09-16「它会卡着播放两次一样感觉」）：
  // playItem 网络慢时 1~3 秒无反馈，用户再点 → 第二次 playItem 停掉第一次、
  // 从头重播。正在加载时忽略后续点击 + 行上加半透明表示"点了、在干活"。
  let _opening = false

  const bindRows = () => {
    root.querySelectorAll('[data-hist]').forEach(el => {
      wireLongPress(el, () => confirmRemove(el.dataset.id))
      el.addEventListener('click', async () => {
        if (el._longPressed) { el._longPressed = false; return }
        if (_opening) return
        _opening = true
        el.style.opacity = '0.5'
        try {
          await openEntry(el)
        } finally {
          _opening = false
          el.style.opacity = ''
        }
      })
    })
  }

  /** 打开某条历史记录对应的书 */
  const openEntry = async (el) => {
    haptic.tap()
    const id = el.dataset.id
    const entry = entries.find(x => x.id === id)
    if (!entry) return
    try {
      // 有进度就接着听。⚠️ 不能用 entry.pct 判断 —— pct 是四舍五入的百分比，
      // 时长很长的书「听了 2 秒」也是 0%（老板 2026-09-16 实测：
      // 《示例侦探剧1》2.7s / 74390s → pct=0）。旧写法把它当"未开始"，
      // 于是 resumeAt=0 把服务器上真实的进度覆盖掉，从第 1 集开头重播 ——
      // 用户看到的就是"我明明刚听了，怎么又从头"。
      // 正确做法：不传 startTime（undefined）→ playItem 去读服务器进度；
      // 只有「已听完」才显式归零（重听语义）。
      const resumeAt = entry.finished ? 0 : undefined
      await playItem(entry.raw || { id, media: entry.media }, { startTime: resumeAt })
    } catch (e) { toast(e.message || '打不开这本书') }
  }

  const confirmRemove = async (id) => {
    const modal = document.createElement('div')
    modal.className = 'lock'
    modal.innerHTML = `<div class="lock-card">
      <div class="lock-title">从历史记录移除？</div>
      <div class="lock-sub">这本书的收听进度会被清空，书架里还在。</div>
      <div class="lock-actions">
        <button class="btn ghost" id="rmCancel">取消</button>
        <button class="btn danger" id="rmOk">移除</button>
      </div>
    </div>`
    document.body.appendChild(modal)
    modal.querySelector('#rmCancel').onclick = () => modal.remove()
    modal.querySelector('#rmOk').onclick = async () => {
      modal.remove()
      try {
        await removeHistoryEntry(id)
        entries = entries.filter(x => x.id !== id)
        paint()
        haptic.success()
        toast('已从历史记录移除')
      } catch (e) { haptic.error(); toast('移除失败：' + e.message) }
    }
  }

  paint()

  root.insertAdjacentHTML('beforeend', kidTabsHTML('kidhome'))
  wireKidTabs(root, { go, requireParentPin })
  updateMini()
}

/**
 * 长按（600ms）。与首页同款：设 el._longPressed 防止抬手时又触发一次点击。
 */
function wireLongPress(el, fn) {
  let timer = null
  const start = () => {
    clearTimeout(timer)
    el.classList.add('longpress')
    timer = setTimeout(() => {
      timer = null
      el._longPressed = true
      el.classList.remove('longpress')
      haptic.heavy()
      fn()
    }, 600)
  }
  const cancel = () => { clearTimeout(timer); timer = null; el.classList.remove('longpress') }
  el.addEventListener('touchstart', start, { passive: true })
  el.addEventListener('touchend', cancel)
  el.addEventListener('touchcancel', cancel)
  el.addEventListener('touchmove', cancel, { passive: true })
  el.addEventListener('mousedown', start)
  el.addEventListener('mouseup', cancel)
  el.addEventListener('mouseleave', cancel)
}

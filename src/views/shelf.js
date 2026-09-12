/** 书架：大卡片网格 + 继续听（只有一种模式，见 2026-09-12 老板要求取消模式分类） */
import { abs } from '../lib/api.js'
import { state, go, toast, esc, fmtDur, playItem, requireParentPin, updateMini } from '../app.js'
import { openVoiceOverlay } from '../lib/voice-ui.js'
import { fallbackCover, wireCoverFallback } from '../lib/cover.js'
import { icon } from '../lib/icons.js'
import { kidTabsHTML, wireKidTabs } from '../lib/nav.js'
import { haptic } from '../lib/haptics.js'

let cache = { items: [], at: 0, libraryId: null }

export async function renderShelf(root) {
  // 只有一种模式了（老板要求取消儿童/成人分类）。保留 kid 常量便于阅读，恒为 true。
  const kid = true
  root.innerHTML = `<div class="empty"><div class="glyph">${icon('loader', 40, 'spin')}</div>正在加载书架…</div>`

  if (!state.libraryId) {
    try {
      const libs = await abs.libraries()
      state.libraries = libs
      state.libraryId = libs[0]?.id
    } catch (e) { }
  }
  if (!state.libraryId) {
    root.innerHTML = `<div class="empty"><div class="glyph">${icon('books', 44)}</div>这个账号没有可用的书库</div>`
    return
  }

  let items = []
  try {
    // 缓存只用于「同一会话内快速返回」，且很短（3 秒）：
    // 原来 60 秒会导致刚听完的书回到书架仍显示旧进度
    if (cache.libraryId === state.libraryId && Date.now() - cache.at < 3000 && cache.items.length) {
      items = cache.items
    } else {
      const d = await abs.getLibraryItems(state.libraryId, { limit: 200, sort: 'media.metadata.title' })
      items = d?.results || []
      cache = { items, at: Date.now(), libraryId: state.libraryId }
    }
  } catch (e) {
    root.innerHTML = `<div class="empty"><div class="glyph">${icon('warning', 44)}</div>${esc(e.message)}</div>`
    return
  }
  state.items = items

  if (!items.length) {
    root.innerHTML = `<div class="empty"><div class="glyph">${icon('books', 44)}</div>书架是空的</div>`
    return
  }

  // 继续听：按「最后播放时间」倒序（最近听的在最前）。
  // ABS 的 /api/me/items-in-progress 不保证顺序（实测同一个库返回顺序稳定但与时间无关），
  // 所以本地按 progressLastUpdate 再排一次；该字段缺失时退回 mediaProgress.lastUpdate。
  let inProgress = []
  let progressMapEarly = {}
  try {
    const me = await abs.me()
    for (const mp of (me?.mediaProgress || [])) {
      const id = mp.libraryItemId || mp.mediaItemId
      if (id) progressMapEarly[id] = mp
    }
  } catch (_) { }
  try {
    const raw = await abs.itemsInProgress()
    inProgress = (raw || [])
      .map(it => {
        const mp = progressMapEarly[it.id]
        const ts = it.progressLastUpdate || mp?.lastUpdate || mp?.finishedAt || 0
        return { it, ts: Number(ts) || 0 }
      })
      .sort((a, b) => b.ts - a.ts)      // 最近听的排最前
      .map(x => x.it)
      .slice(0, 8)
  } catch (_) { }

  const progressMap = progressMapEarly

  const cardHTML = (it, big) => {
    const m = it.media?.metadata || {}
    const title = m.title || '未命名'
    const prog = progressMap[it.id]
    const pct = prog && prog.duration ? Math.min(100, Math.round((prog.currentTime || 0) / prog.duration * 100)) : 0
    const cover = abs.coverUrl(it.id, { width: big ? 420 : 200 })
    const done = prog?.isFinished
    return `
      <div class="book-card" data-id="${it.id}">
        <div class="cover-slot">
          ${fallbackCover({ title, author: m.authorName || m.narratorName, cls: 'cover-ph-card' })}
          <img class="book-cover" data-cover src="${cover}" alt="" loading="lazy">
        </div>
        ${prog && (prog.currentTime > 30) ? `<div class="book-badge">${done ? '已听完' : '听 ' + pct + '%'}</div>` : ''}
        <div class="book-meta">
          <div class="book-title">${esc(title)}</div>
          <div class="book-sub">${esc(m.authorName || m.narratorName || fmtDur(it.media?.duration))}</div>
        </div>
        ${pct > 0 && pct < 100 ? `<div class="book-progress"><i style="width:${pct}%"></i></div>` : ''}
      </div>`
  }

  // 设置入口只留底栏那个（右上角不再放齿轮，避免两个入口重复）
  // 页头：标题 + 收藏入口（老板要求收藏在首页有入口）
  const head = `<div class="page-head">
         <div class="page-title">我的书架</div>
         <button class="icon-btn" id="btnFavEntry" aria-label="我的收藏">${icon('heart', 21)}</button>
       </div>`

  const continueHTML = inProgress.length ? `
    <div class="section-h">继续听 <small>长按可移除</small></div>
    <div class="continue-row">
      ${inProgress.map(it => {
        const m = it.media?.metadata || {}
        const libItemId = it.id
        const prog = progressMap[libItemId]
        const pct = prog && prog.duration ? Math.round((prog.currentTime || 0) / prog.duration * 100) : 0
        return `<div class="continue-card" data-id="${libItemId}" data-continue="1">
          <div class="cover-slot">
            ${fallbackCover({ title: m.title, author: m.authorName || m.narratorName, cls: 'cover-ph-continue' })}
            <img class="continue-cover" data-cover src="${abs.coverUrl(libItemId, { width: 300 })}" alt="">
          </div>
          <div class="continue-meta">
            <div class="continue-title">${esc(m.title || '')}</div>
            <div class="continue-bar"><i style="width:${Math.max(pct, 2)}%"></i></div>
            <div class="continue-pct">已听 ${pct}%</div>
          </div>
        </div>`
      }).join('')}
    </div>` : ''

  // （原来这里有一套"成人模式紧凑列表"分支，随模式分类一起移除了）
  const rowHTML = (it) => {
    const m = it.media?.metadata || {}
    const title = m.title || '未命名'
    const prog = progressMap[it.id]
    const pct = prog && prog.duration ? Math.min(100, Math.round((prog.currentTime || 0) / prog.duration * 100)) : 0
    const done = prog?.isFinished
    const dur = fmtDur(it.media?.duration)
    const who = m.authorName || m.narratorName || ''
    const tail = done ? '已听完' : (pct > 0 ? pct + '%' : icon('play', 15))
    return `
      <div class="list-item" data-id="${it.id}">
        <div class="cover-slot">
          ${fallbackCover({ title, author: who, cls: 'cover-ph-list' })}
          <img class="list-cover" data-cover src="${abs.coverUrl(it.id, { width: 160 })}" alt="" loading="lazy">
        </div>
        <div class="list-main">
          <div class="list-title">${esc(title)}</div>
          <div class="list-sub">${esc(who)}${who && dur ? ' · ' : ''}${esc(dur)}</div>
        </div>
        <div class="list-pct">${tail}</div>
      </div>`
  }

  root.innerHTML = head + continueHTML +
    `<div class="shelf-grid">${items.map(it => cardHTML(it, true)).join('')}</div>`

  root.insertAdjacentHTML('beforeend',
    `<button class="voice-fab" data-voice="1" aria-label="语音搜索">${icon('mic', 28)}</button>`
    + kidTabsHTML('kidhome'))
  wireKidTabs(root, { go, requireParentPin })

  // 收藏入口（首页直达）
  root.querySelector('#btnFavEntry').onclick = () => { haptic.tap(); go('favorites') }

  // 无封面的书用占位封面兜底
  wireCoverFallback(root)

  // 语音
  root.querySelectorAll('[data-voice]').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation()
      openVoiceOverlay({ onSearch: (q) => go('search', { q }) })
    })
  })

  // 点击书籍
  root.querySelectorAll('[data-id]').forEach(el => {
    // 长按 = 从「继续听」里删掉这条记录（只在继续听卡片上生效）
    if (el.dataset.continue === '1') {
      wireLongPress(el, () => confirmRemoveFromContinue(el.dataset.id))
    }
    el.addEventListener('click', async () => {
      if (el._longPressed) { el._longPressed = false; return }   // 长按已处理，别再当点击
      haptic.tap()
      const id = el.dataset.id
      const it = state.items.find(x => x.id === id) || inProgress.find(x => x.id === id)
      if (!it) return
      // 有进度就接着听（卡片上有"听 N%"徽标，从头播会丢进度）；没进度才从 0 开始
      const prog = progressMap[it.id]
      const resumeAt = (prog && !prog.isFinished && prog.currentTime > 5) ? undefined : 0
      try {
        await playItem(it, { startTime: resumeAt })
      } catch (e) { toast(e.message || '打不开这本书') }
    })
  })

  updateMini()
}

/**
 * 长按（600ms）触发。触摸/鼠标都支持。
 * 设 el._longPressed，让随后的 click 不要再触发一次普通点击 —— 否则长按删除后
 * 手指抬起会顺带把这本书打开。
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

/** 二次确认后把这本书从「继续听」移除（ABS 端一起改，不只是本机隐藏） */
async function confirmRemoveFromContinue(itemId) {
  const modal = document.createElement('div')
  modal.className = 'lock'
  modal.innerHTML = `<div class="lock-card">
    <div class="lock-title">从「继续听」移除？</div>
    <div class="lock-sub">这本书的收听进度会被清空，书架里还在。服务器上也会一起改。</div>
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
      await abs.removeFromContinue(itemId)
      haptic.success()
      toast('已从继续听移除')
      cache.at = 0   // 让书架重新拉取
      await go('kidhome')
    } catch (e) { haptic.error(); toast('移除失败：' + e.message) }
  }
}

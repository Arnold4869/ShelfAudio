/** 书架：儿童模式=大卡片网格；成人模式=列表 + 排序 */
import { abs } from '../lib/api.js'
import { state, go, toast, esc, fmtDur, playItem, requireParentPin, updateMini } from '../app.js'
import { openVoiceOverlay } from '../lib/voice-ui.js'

let cache = { items: [], at: 0, libraryId: null }

export async function renderShelf(root, { kid }) {
  root.innerHTML = `<div class="empty"><div class="glyph">⏳</div>正在加载书架…</div>`

  if (!state.libraryId) {
    try {
      const libs = await abs.libraries()
      state.libraries = libs
      state.libraryId = libs[0]?.id
    } catch (e) { }
  }
  if (!state.libraryId) {
    root.innerHTML = `<div class="empty"><div class="glyph">📚</div>这个账号没有可用的书库</div>`
    return
  }

  let items = []
  try {
    if (cache.libraryId === state.libraryId && Date.now() - cache.at < 60000 && cache.items.length) {
      items = cache.items
    } else {
      const d = await abs.getLibraryItems(state.libraryId, { limit: 200, sort: 'media.metadata.title' })
      items = d?.results || []
      cache = { items, at: Date.now(), libraryId: state.libraryId }
    }
  } catch (e) {
    root.innerHTML = `<div class="empty"><div class="glyph">⚠️</div>${esc(e.message)}</div>`
    return
  }
  state.items = items

  if (!items.length) {
    root.innerHTML = `<div class="empty"><div class="glyph">📚</div>书架是空的</div>`
    return
  }

  // 继续听
  let inProgress = []
  try {
    const raw = await abs.itemsInProgress()
    inProgress = (raw || []).map(it => {
      const p = (state.player?.itemId && it.id === state.player.itemId) ? null : null
      return it
    }).slice(0, 8)
  } catch (_) { }

  const progressMap = {}
  try {
    const me = await abs.me()
    for (const mp of (me?.mediaProgress || [])) {
      const id = mp.libraryItemId || mp.mediaItemId
      if (id) progressMap[id] = mp
    }
  } catch (_) { }

  const cardHTML = (it, big) => {
    const m = it.media?.metadata || {}
    const title = m.title || '未命名'
    const prog = progressMap[it.id]
    const pct = prog && prog.duration ? Math.min(100, Math.round((prog.currentTime || 0) / prog.duration * 100)) : 0
    const cover = abs.coverUrl(it.id, { width: big ? 420 : 200 })
    const done = prog?.isFinished
    return `
      <div class="book-card" data-id="${it.id}">
        <img class="book-cover" src="${cover}" alt="" loading="lazy"
             onerror="this.style.display='none';this.nextElementSibling.style.display='grid'">
        <div class="book-cover-fallback" style="display:none">📖</div>
        ${prog && (prog.currentTime > 30) ? `<div class="book-badge">${done ? '已听完' : '听 ' + pct + '%'}</div>` : ''}
        <div class="book-meta">
          <div class="book-title">${esc(title)}</div>
          <div class="book-sub">${esc(m.authorName || m.narratorName || fmtDur(it.media?.duration))}</div>
        </div>
        ${pct > 0 && pct < 100 ? `<div class="book-progress"><i style="width:${pct}%"></i></div>` : ''}
      </div>`
  }

  const head = kid
    ? `<div class="page-head">
         <div class="page-title">我的书架</div>
         <button class="icon-btn" id="btnGear" aria-label="设置">⚙️</button>
       </div>`
    : `<div class="page-head">
         <button class="icon-btn" id="btnBack" aria-label="返回">‹</button>
         <div class="page-title">全部书籍</div>
         <button class="icon-btn" id="btnSearch" aria-label="搜索">🔍</button>
       </div>`

  const continueHTML = inProgress.length ? `
    <div class="section-h">继续听 <small>${inProgress.length} 本</small></div>
    <div class="continue-row">
      ${inProgress.map(it => {
        const m = it.media?.metadata || {}
        const libItemId = it.id
        const prog = progressMap[libItemId]
        const pct = prog && prog.duration ? Math.round((prog.currentTime || 0) / prog.duration * 100) : 0
        return `<div class="continue-card" data-id="${libItemId}" data-continue="1">
          <img class="continue-cover" src="${abs.coverUrl(libItemId, { width: 300 })}" alt="">
          <div class="continue-meta">
            <div class="continue-title">${esc(m.title || '')}</div>
            <div class="continue-bar"><i style="width:${Math.max(pct, 2)}%"></i></div>
            <div class="continue-pct">已听 ${pct}%</div>
          </div>
        </div>`
      }).join('')}
    </div>` : ''

  root.innerHTML = head + continueHTML +
    (kid ? `<div class="shelf-grid">${items.map(it => cardHTML(it, true)).join('')}</div>`
         : `<div class="shelf-grid">${items.map(it => cardHTML(it, false)).join('')}</div>`)

  if (kid) {
    root.insertAdjacentHTML('beforeend', `
      <button class="voice-fab" data-voice="1" aria-label="语音搜索">🎤</button>
      <div class="kid-tabs">
        <button class="kid-tab active" data-nav="kidhome"><span class="ic">📚</span>书架</button>
        <button class="kid-tab" data-nav="search"><span class="ic">🔍</span>找书</button>
        <button class="kid-tab" data-nav="settings"><span class="ic">⚙️</span>设置</button>
      </div>`)
    root.querySelector('[data-nav="search"]').onclick = () => go('search')
    root.querySelector('[data-nav="settings"]').onclick = async () => { if (await requireParentPin()) go('settings') }
  } else {
    root.querySelector('#btnSearch').onclick = () => go('search')
    root.querySelector('#btnBack').onclick = () => go('kidhome')
  }
  if (kid) root.querySelector('#btnGear').onclick = async () => { if (await requireParentPin()) go('settings') }

  // 语音
  root.querySelectorAll('[data-voice]').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation()
      openVoiceOverlay({ onSearch: (q) => go('search', { q }) })
    })
  })

  // 点击书籍
  root.querySelectorAll('[data-id]').forEach(el => {
    el.addEventListener('click', async () => {
      const id = el.dataset.id
      const it = state.items.find(x => x.id === id) || inProgress.find(x => x.id === id)
      if (!it) return
      // 继续听：沿用 ABS 进度；新书：从 0 开始
      const isContinue = el.dataset.continue === '1'
      try {
        await playItem(it, isContinue ? {} : { startTime: 0 })
      } catch (e) { toast(e.message || '打不开这本书') }
    })
  })

  updateMini()
}

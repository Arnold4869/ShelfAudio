/** 搜索页：文字 + 语音（语音走同一入口，识别结果可当指令也可当关键词） */
import { abs } from '../lib/api.js'
import { state, go, toast, esc, fmtDur, playItem, requireParentPin, updateMini } from '../app.js'
import { voiceSupported } from '../lib/voice.js'
import { openVoiceOverlay } from '../lib/voice-ui.js'
import { fallbackCover, wireCoverFallback } from '../lib/cover.js'
import { icon } from '../lib/icons.js'

let lastQuery = ''

export async function renderSearch(root, params = {}) {
  const kid = state.mode !== 'adult'
  const initialQ = params.q || lastQuery

  root.innerHTML = `
    <div class="page-head">
      <button class="icon-btn" id="btnBack" aria-label="返回">${icon('back', 22)}</button>
      <div class="page-title">找书</div>
      ${voiceSupported() ? `<button class="icon-btn" data-voice="1" aria-label="语音">${icon('mic', 21)}</button>` : ''}
    </div>
    <div class="search-bar">
      <input id="q" type="search" placeholder="输入书名，或说“我要听示例故事甲”" value="${esc(lastQuery)}"
             autocapitalize="off" autocorrect="off" enterkeyhint="search" />
      <button class="btn" id="btnGo" style="padding:13px 18px">搜索</button>
    </div>
    <div class="hint" id="hint" style="margin-bottom:14px">
      ${voiceSupported() ? '点右下角话筒，直接说书名或“暂停”“下一集”' : '这台设备不支持语音识别，可以用文字搜索'}
    </div>
    <div id="results"></div>
    ${kid ? `<button class="voice-fab" data-voice="1" aria-label="语音搜索">${icon('mic', 28)}</button>` : ''}
  `

  const $ = s => root.querySelector(s)
  const input = $('#q'), results = $('#results')

  if (kid) {
    root.insertAdjacentHTML('beforeend', `
      <div class="kid-tabs">
        <button class="kid-tab" data-nav="kidhome"><span class="ic">${icon('books', 24)}</span>书架</button>
        <button class="kid-tab active" data-nav="search"><span class="ic">${icon('search', 24)}</span>找书</button>
        <button class="kid-tab" data-nav="settings"><span class="ic">${icon('cog', 24)}</span>设置</button>
      </div>`)
    root.querySelector('[data-nav="kidhome"]').onclick = () => go('kidhome')
    root.querySelector('[data-nav="settings"]').onclick = async () => { if (await requireParentPin()) go('settings') }
  }
  $('#btnBack').onclick = () => go(kid ? 'kidhome' : 'shelf')

  const renderList = (items, q) => {
    if (!items.length) {
      results.innerHTML = `<div class="empty"><div class="glyph">${icon('search', 44)}</div>没找到${q ? '「' + esc(q) + '」' : ''}相关的书</div>`
      return
    }
    results.innerHTML = items.map(it => {
      const m = it.media?.metadata || {}
      return `<div class="list-item" data-id="${it.id}">
        <div class="cover-slot">
          ${fallbackCover({ title: m.title, author: m.authorName || m.narratorName, cls: 'cover-ph-list' })}
          <img class="list-cover" data-cover src="${abs.coverUrl(it.id, { width: 160 })}" alt="" loading="lazy">
        </div>
        <div class="list-main">
          <div class="list-title">${esc(m.title || '未命名')}</div>
          <div class="list-sub">${esc(m.authorName || m.narratorName || '')} · ${fmtDur(it.media?.duration)}</div>
        </div>
        <div class="list-pct">${icon('play', 15)}</div>
      </div>`
    }).join('')
    wireCoverFallback(results)
    results.querySelectorAll('[data-id]').forEach(el => {
      el.onclick = async () => {
        const it = items.find(x => x.id === el.dataset.id)
        // 不传 startTime → playItem 会查服务器上的进度，听过就接着听
        try { await playItem(it) } catch (e) { toast(e.message || '打开失败') }
      }
    })
  }

  const doSearch = async (q) => {
    q = (q || '').trim()
    if (!q) return
    lastQuery = q
    results.innerHTML = `<div class="empty"><div class="glyph">${icon('loader', 40, 'spin')}</div>搜索中…</div>`
    try {
      if (!state.libraries.length) state.libraries = await abs.libraries()
      let items = await abs.searchAll(state.libraries, q)
      if (!items.length) {
        // 兜底：本地标题子串匹配（ABS 搜索对中文分词有时不给力）
        const all = state.items.length ? state.items : (await abs.getLibraryItems(state.libraryId, { limit: 300 }))?.results || []
        items = all.filter(it => (it.media?.metadata?.title || '').toLowerCase().includes(q.toLowerCase()))
      }
      renderList(items, q)
    } catch (e) {
      results.innerHTML = `<div class="empty"><div class="glyph">${icon('warning', 44)}</div>${esc(e.message)}</div>`
    }
  }

  $('#btnGo').onclick = () => doSearch(input.value)
  input.addEventListener('keydown', e => { if (e.key === 'Enter') { input.blur(); doSearch(input.value) } })

  // 语音搜索浮层
  document.querySelectorAll('[data-voice]').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation()
      if (!voiceSupported()) { toast('这台设备不支持语音识别'); return }
      openVoiceOverlay({ onSearch: doSearch })
    })
  })

  if (initialQ) { input.value = initialQ; doSearch(initialQ) }
  updateMini()
}

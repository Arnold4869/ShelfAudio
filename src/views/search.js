/** 搜索页：文字 + 语音（语音走同一入口，识别结果可当指令也可当关键词） */
import { abs } from '../lib/api.js'
import { state, go, toast, esc, fmtDur, playItem, requireParentPin, updateMini } from '../app.js'
import { listen, parseCommand, voiceSupported } from '../lib/voice.js'
import { openVoiceOverlay } from '../lib/voice-ui.js'

let lastQuery = ''

export async function renderSearch(root, params = {}) {
  const kid = state.mode !== 'adult'
  const initialQ = params.q || lastQuery

  root.innerHTML = `
    <div class="page-head">
      <button class="icon-btn" id="btnBack" aria-label="返回">‹</button>
      <div class="page-title">找书</div>
      ${voiceSupported() ? `<button class="icon-btn" data-voice="1" aria-label="语音">🎤</button>` : ''}
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
    <button class="voice-fab" data-voice="1" aria-label="语音搜索">🎤</button>
  `

  const $ = s => root.querySelector(s)
  const input = $('#q'), results = $('#results')

  if (kid) {
    root.insertAdjacentHTML('beforeend', `
      <div class="kid-tabs">
        <button class="kid-tab" data-nav="kidhome"><span class="ic">📚</span>书架</button>
        <button class="kid-tab active" data-nav="search"><span class="ic">🔍</span>找书</button>
        <button class="kid-tab" data-nav="settings"><span class="ic">⚙️</span>设置</button>
      </div>`)
    root.querySelector('[data-nav="kidhome"]').onclick = () => go('kidhome')
    root.querySelector('[data-nav="settings"]').onclick = async () => { if (await requireParentPin()) go('settings') }
  }
  $('#btnBack').onclick = () => go(kid ? 'kidhome' : 'shelf')

  const renderList = (items, q) => {
    if (!items.length) {
      results.innerHTML = `<div class="empty"><div class="glyph">🔍</div>没找到${q ? '「' + esc(q) + '」' : ''}相关的书</div>`
      return
    }
    results.innerHTML = items.map(it => {
      const m = it.media?.metadata || {}
      return `<div class="list-item" data-id="${it.id}">
        <img class="list-cover" src="${abs.coverUrl(it.id, { width: 160 })}" alt="" loading="lazy"
             onerror="this.style.visibility='hidden'">
        <div class="list-main">
          <div class="list-title">${esc(m.title || '未命名')}</div>
          <div class="list-sub">${esc(m.authorName || m.narratorName || '')} · ${fmtDur(it.media?.duration)}</div>
        </div>
        <div class="list-pct">▶</div>
      </div>`
    }).join('')
    results.querySelectorAll('[data-id]').forEach(el => {
      el.onclick = async () => {
        const it = items.find(x => x.id === el.dataset.id)
        try { await playItem(it, { startTime: 0 }) } catch (e) { toast(e.message || '打开失败') }
      }
    })
  }

  const doSearch = async (q) => {
    q = (q || '').trim()
    if (!q) return
    lastQuery = q
    results.innerHTML = `<div class="empty"><div class="glyph">⏳</div>搜索中…</div>`
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
      results.innerHTML = `<div class="empty"><div class="glyph">⚠️</div>${esc(e.message)}</div>`
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

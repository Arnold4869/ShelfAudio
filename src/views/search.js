/** 搜索页：文字 + 语音（语音走同一入口，识别结果可当指令也可当关键词） */
import { hub as abs } from '../lib/servers.js'   // 多源门面：按 id 前缀分派 ABS / Navidrome
import { voiceHidden, uiPrefsReady } from '../lib/ui-prefs.js'
import { state, go, toast, esc, fmtDur, playItem, requireParentPin, updateMini } from '../app.js'
import { voiceSupported } from '../lib/voice.js'
import { openVoiceOverlay } from '../lib/voice-ui.js'
import { fallbackCover, wireCoverFallback } from '../lib/cover.js'
import { icon } from '../lib/icons.js'
import { kidTabsHTML, wireKidTabs } from '../lib/nav.js'
import { haptic } from '../lib/haptics.js'

let lastQuery = ''

export async function renderSearch(root, params = {}) {
  await uiPrefsReady()   // 确保「语音按钮隐藏」偏好已读，按钮显隐不闪
  const kid = true   // 只有一种模式（老板要求取消儿童/成人分类）
  const initialQ = params.q || lastQuery

  root.innerHTML = `
    <div class="page-head">
      <button class="icon-btn" id="btnBack" aria-label="返回">${icon('back', 22)}</button>
      <div class="page-title">找书</div>
    </div>
    <!-- 语音按钮放进输入框内部（右上角那个位置太远，用户反馈"放搜索框里更合适"） -->
    <div class="search-bar">
      <div class="search-field">
        <input id="q" type="search" placeholder="输入书名，或说“我要听示例故事甲”" value="${esc(lastQuery)}"
               autocapitalize="off" autocorrect="off" enterkeyhint="search" />
        ${(voiceSupported() && !voiceHidden()) ? `<button class="search-mic" data-voice="1" aria-label="语音搜索">${icon('mic', 20)}</button>` : ''}
      </div>
      <button class="btn" id="btnGo" style="padding:13px 18px">搜索</button>
    </div>
    <div id="results"></div>
    ${(kid && !voiceHidden()) ? `<button class="voice-fab" data-voice="1" aria-label="语音搜索">${icon('mic', 28)}</button>` : ''}
  `

  const $ = s => root.querySelector(s)
  const input = $('#q'), results = $('#results')

  if (kid) {
    root.insertAdjacentHTML('beforeend', kidTabsHTML('search'))
    wireKidTabs(root, { go, requireParentPin })
  }
  $('#btnBack').onclick = () => go('kidhome')

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

  // 没输入关键词时不要留一大片空白：显示可浏览的书籍列表（主流播放器的做法）
  const showBrowse = async () => {
    try {
      let all = state.items.length ? state.items
        : (await abs.getLibraryItems(state.libraryId, { limit: 300 }))?.results || []
      if (!all.length) return
      results.innerHTML = `<div class="section-h">全部书籍 <small>${all.length} 本</small></div>`
        + all.map(it => {
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
          haptic.tap()
          const it = all.find(x => x.id === el.dataset.id)
          try { await playItem(it) } catch (e) { toast(e.message || '打开失败') }
        }
      })
    } catch (_) { /* 拉不到就保持空白，不打扰用户 */ }
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

  $('#btnGo').onclick = () => { haptic.tap(); doSearch(input.value) }
  input.addEventListener('keydown', e => { if (e.key === 'Enter') { input.blur(); haptic.tap(); doSearch(input.value) } })

  // 语音搜索浮层
  document.querySelectorAll('[data-voice]').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation()
      haptic.select()
      if (!voiceSupported()) { toast('这台设备不支持语音识别'); return }
      openVoiceOverlay({ onSearch: doSearch })
    })
  })

  if (initialQ) { input.value = initialQ; doSearch(initialQ) }
  else await showBrowse()

  updateMini()
}

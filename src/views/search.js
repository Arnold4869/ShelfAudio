/** 搜索页：文字 + 语音（语音走同一入口，识别结果可当指令也可当关键词） */
import { hub, hub as abs } from '../lib/servers.js'   // 多源门面：按 id 前缀分派 ABS / Navidrome
import { voiceHidden, uiPrefsReady } from '../lib/ui-prefs.js'
import { goBack, state, go, toast, esc, fmtDur, playItem, requireParentPin, updateMini } from '../app.js'
import { voiceSupported } from '../lib/voice.js'
import { openVoiceOverlay } from '../lib/voice-ui.js'
import { fallbackCover, wireCoverFallback } from '../lib/cover.js'
import { icon } from '../lib/icons.js'
import { kidTabsHTML, wireKidTabs } from '../lib/nav.js'
import { t } from '../lib/terms.js'
import { wireArtistLinks, artistLink, artistIdOf } from '../lib/artist-links.js'

/** 点列表条目：ND 专辑进详情页自己选歌；ABS 书保持原行为（直接续听） */
async function openOrPlay(it, { resumeAt } = {}) {
  if (String(it.id).startsWith('nd:')) { await go('album', { id: it.id }); return }
  try { await playItem(it, resumeAt === undefined ? {} : { startTime: resumeAt }) }
  catch (e) { toast(e.message || t('openFail')) }
}

import { haptic } from '../lib/haptics.js'

let lastQuery = ''
// 数量+单位（本/张，按源定）
const countN = n => `${n} ${t('books')}`

export async function renderSearch(root, params = {}) {
  await uiPrefsReady()   // 确保「语音按钮隐藏」偏好已读，按钮显隐不闪
  const kid = true   // 只有一种模式（老板要求取消儿童/成人分类）
  const initialQ = params.q || lastQuery

  root.innerHTML = `
    <div class="page-head">
      <button class="icon-btn" id="btnBack" aria-label="返回">${icon('back', 22)}</button>
      <div class="page-title">搜索</div>
    </div>
    <!-- 语音按钮放进输入框内部（右上角那个位置太远，用户反馈"放搜索框里更合适"） -->
    <div class="search-bar">
      <div class="search-field">
        <input id="q" type="search" placeholder="${hub.active === 'nd' ? '输入专辑、歌手或歌曲名' : '输入书名，或说“我要听示例故事甲”'}" value="${esc(lastQuery)}"
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
  $('#btnBack').onclick = () => goBack('kidhome')

  // 专辑行（带封面）。ND 专辑的作者行可点进歌手页（老板 2026-09-19 全局可点）
  const albumRow = it => {
    const m = it.media?.metadata || {}
    const aid = artistIdOf(it)
    return `<div class="list-item" data-id="${it.id}">
      <div class="cover-slot">
        ${fallbackCover({ title: m.title, author: m.authorName || m.narratorName, cls: 'cover-ph-list' })}
        <img class="list-cover" data-cover src="${abs.coverUrl(it.id, { width: 160 })}" alt="" loading="lazy">
      </div>
      <div class="list-main">
        <div class="list-title">${esc(m.title || '未命名')}</div>
        <div class="list-sub">${artistLink(m.authorName || m.narratorName, aid)}${it.media?.duration ? ' · ' + fmtDur(it.media.duration) : ''}</div>
      </div>
      <div class="list-pct">${icon('forward', 16)}</div>
    </div>`
  }

  // 歌曲行（无封面小图，点它 = 进所在专辑并从这首开始播）。
  // 歌手名可点 → 歌手页（老板 2026-09-19：所有出现演唱者的地方都可点）。
  // ND 歌曲带 artistId；ABS 书没有歌手概念 → 永远走不到 artistLink。
  const songRow = sg => `<div class="list-item song-item" data-song="${esc(sg.id)}" data-album="${esc(sg.albumId || '')}">
      <div class="list-main">
        <div class="list-title">${esc(sg.title || '未命名')}</div>
        <div class="list-sub">${artistLink(sg.artist, sg.artistId)}${sg.album ? (sg.artist ? ' · ' : '') + esc(sg.album) : ''}${sg.duration ? ' · ' + fmtDur(sg.duration) : ''}</div>
      </div>
      <div class="list-pct">${icon('play', 15)}</div>
    </div>`

  /** 歌手行：直接进歌手页（以前是拿名字重新搜一遍 —— 老板 2026-09-19 要看他的全部作品页） */
  const artistRow = ar => `<div class="list-item" data-artist-go="${esc(ar.id)}">
      <div class="list-main">
        <div class="list-title">${esc(ar.name)}</div>
        <div class="list-sub">歌手</div>
      </div>
      <div class="list-pct">${icon('person', 15)}</div>
    </div>`

  // 歌手行的点击委托在 renderGrouped 里绑一次（这段 HTML 重建后要重绑）

  /** 分组渲染：专辑 / 歌手 / 歌曲 各一段（老板要求不要混在一起）
   *  歌曲组在 ND 下支持多选（勾选 / 全选）→ 添加到歌单（老板 2026-09-14）。 */
  const renderGrouped = (g, q) => {
    const totalN = (g.albums?.length || 0) + (g.artists?.length || 0) + (g.songs?.length || 0)
    if (!totalN) {
      results.innerHTML = `<div class="empty"><div class="glyph">${icon('search', 44)}</div>${t('noResult', q)}</div>`
      return
    }
    const isNd = hub.active === 'nd'
    const songs = g.songs || []
    const sec = (title, n, html) => n ? `<div class="section-h">${title} <small>${n}</small></div>
      <div class="settings-group" style="padding:4px 0">${html}</div>` : ''
    // 歌曲组头部带「选择 / 全选」入口（仅在 ND 且确实有歌曲结果时）
    const songHead = (isNd && songs.length)
      ? `<div class="section-h">歌曲 <small>${songs.length}</small>
           <button class="pick-toggle" id="pickToggle">选择</button>
         </div>
         <div class="pick-bar" id="pickBar" hidden>
           <button class="pick-all" id="pickAll">${icon('checked', 19)} 全选</button>
           <span id="pickCount">已选 0 首</span>
           <button class="btn" id="pickAdd" style="padding:8px 14px;font-size:14px">添加到歌单</button>
         </div>`
      : `<div class="section-h">歌曲 <small>${songs.length}</small></div>`
    results.innerHTML =
        sec('专辑', g.albums?.length || 0, (g.albums || []).map(albumRow).join(''))
      + sec('歌手', g.artists?.length || 0, (g.artists || []).map(artistRow).join(''))
      + ((songs.length || (isNd && songs.length === 0)) ? songHead : '')
      + (songs.length ? `<div class="settings-group" style="padding:4px 0">${songs.map(songRow).join('')}</div>` : '')
    wireCoverFallback(results)

    // ---- 多选模式（老板：搜索结果选中添加到歌单，也能全选添加）----
    if (isNd && songs.length) {
      // ⚠️ 专辑行/歌手行的点击**不能**因为歌曲多选而丢：它们不属于多选范围。
      // （曾经把两组 handler 写进 if/else 分支，导致 ND 有歌曲结果时点专辑没反应。）
      results.querySelectorAll('.list-item[data-id]').forEach(el => {
        el.onclick = async () => {
          haptic.tap()
          const it = (g.albums || []).find(x => x.id === el.dataset.id)
          if (it) await openOrPlay(it)
        }
      })
      const picked = new Set()
      const toggleBtn = results.querySelector('#pickToggle')
      const bar = results.querySelector('#pickBar')
      const countEl = results.querySelector('#pickCount')
      const allBtn = results.querySelector('#pickAll')
      let picking = false

      const paintPick = () => {
        results.querySelectorAll('.list-item[data-song]').forEach(el => {
          const on = picked.has(el.dataset.song)
          el.classList.toggle('picked', on)
          const box = el.querySelector('.pick-box')
          if (box) box.innerHTML = icon(on ? 'checked' : 'unchecked', 21)
        })
        countEl.textContent = `已选 ${picked.size} 首`
        const allOn = picked.size === songs.length && songs.length > 0
        allBtn.classList.toggle('on', allOn)
      }
      const setPicking = (on) => {
        picking = on
        bar.hidden = !on
        toggleBtn.textContent = on ? '取消' : '选择'
        results.querySelectorAll('.list-item[data-song]').forEach(el => {
          el.classList.toggle('pickable', on)
          let box = el.querySelector('.pick-box')
          if (on && !box) {
            el.insertAdjacentHTML('afterbegin', `<div class="pick-box">${icon('unchecked', 21)}</div>`)
          } else if (!on && box) {
            box.remove()
          }
        })
        if (!on) { picked.clear() }
        paintPick()
      }

      toggleBtn.onclick = () => { haptic.tap(); setPicking(!picking) }
      allBtn.onclick = () => {
        haptic.select()
        if (picked.size === songs.length) picked.clear()
        else songs.forEach(s => picked.add(s.id))
        paintPick()
      }
      results.querySelector('#pickAdd').onclick = async () => {
        if (!picked.size) { toast('先选几首'); return }
        haptic.tap()
        const list = songs.filter(s => picked.has(s.id)).map(s => ({ id: s.id, title: s.title }))
        const { openAddToPlaylist } = await import('../lib/playlist-ui.js')
        await openAddToPlaylist(list)
      }
      // 选择态下点整行 = 勾选/取消；非选择态 = 原来的播放行为
      results.querySelectorAll('.list-item[data-song]').forEach(el => {
        el.onclick = async e => {
          if (picking) {
            e.stopImmediatePropagation?.()
            haptic.select()
            const id = el.dataset.song
            if (picked.has(id)) picked.delete(id); else picked.add(id)
            paintPick()
            return
          }
          haptic.tap()
          const sg = songs.find(x => x.id === el.dataset.song)
          const albumId = sg?.albumId || el.dataset.album
          if (!albumId) { toast('找不到这首歌所在的专辑'); return }
          await go('album', { id: albumId, songId: sg?.songId || String(el.dataset.song).replace(/^nd:/, '') })
        }
      })
    } else {
      // 专辑：进详情页自己选歌
      results.querySelectorAll('.list-item[data-id]').forEach(el => {
        el.onclick = async () => {
          haptic.tap()
          const it = (g.albums || []).find(x => x.id === el.dataset.id)
          if (it) await openOrPlay(it)
        }
      })
      // 歌曲：进所在专辑，并从这首开始播（老板「我自己选个单曲播放」）
      results.querySelectorAll('.list-item[data-song]').forEach(el => {
        el.onclick = async () => {
          haptic.tap()
          const sg = (g.songs || []).find(x => x.id === el.dataset.song)
          const albumId = sg?.albumId || el.dataset.album
          if (!albumId) { toast('找不到这首歌所在的专辑'); return }
          await go('album', { id: albumId, songId: sg?.songId || String(el.dataset.song).replace(/^nd:/, '') })
        }
      })
    }
    // 歌手：进歌手页看他的全部作品（老板 2026-09-19 改：以前是拿名字重新搜一遍）
    results.querySelectorAll('.list-item[data-artist-go]').forEach(el => {
      el.onclick = () => {
        haptic.tap()
        const id = el.dataset.artistGo
        if (!id) return
        go('artist', { id })
      }
    })
    // 歌曲行里的歌手名（可点 → 歌手页）。捕获阶段拦截，不会连带触发行点击。
    wireArtistLinks(results)
  }

  const renderList = (items, q) => {
    if (!items.length) {
      results.innerHTML = `<div class="empty"><div class="glyph">${icon('search', 44)}</div>${t('noResult', q)}</div>`
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
          <div class="list-sub">${artistLink(m.authorName || m.narratorName, artistIdOf(it))} · ${fmtDur(it.media?.duration)}</div>
        </div>
        <div class="list-pct">${icon('play', 15)}</div>
      </div>`
    }).join('')
    wireCoverFallback(results)
    results.querySelectorAll('[data-id]').forEach(el => {
      el.onclick = async () => {
        haptic.tap()
        const it = items.find(x => x.id === el.dataset.id)
        if (!it) return
        await openOrPlay(it)
      }
    })
  }

  // 没输入关键词时不要留一大片空白：显示可浏览的书籍列表（主流播放器的做法）
  const showBrowse = async () => {
    try {
      let all = state.items.length ? state.items
        : (await abs.getLibraryItems(state.libraryId, { limit: 2000 }))?.results || []
      if (!all.length) return
      results.innerHTML = `<div class="section-h">${t('all')} <small>${countN(all.length)}</small></div>`
        + all.map(it => {
          const m = it.media?.metadata || {}
          return `<div class="list-item" data-id="${it.id}">
            <div class="cover-slot">
              ${fallbackCover({ title: m.title, author: m.authorName || m.narratorName, cls: 'cover-ph-list' })}
              <img class="list-cover" data-cover src="${abs.coverUrl(it.id, { width: 160 })}" alt="" loading="lazy">
            </div>
            <div class="list-main">
              <div class="list-title">${esc(m.title || '未命名')}</div>
              <div class="list-sub">${artistLink(m.authorName || m.narratorName, artistIdOf(it))} · ${fmtDur(it.media?.duration)}</div>
            </div>
            <div class="list-pct">${icon('play', 15)}</div>
          </div>`
        }).join('')
      wireCoverFallback(results)
      results.querySelectorAll('[data-id]').forEach(el => {
        el.onclick = async () => {
          haptic.tap()
          const it = all.find(x => x.id === el.dataset.id)
          if (!it) return
          await openOrPlay(it)
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
      // ND：分类搜索（专辑/歌手/歌曲分开显示，老板 2026-09-14）
      if (hub.active === 'nd') {
        const g = await abs.search3(state.libraryId, q)
        renderGrouped(g, q)
        return
      }
      let items = await abs.searchAll(state.libraries, q)
      if (!items.length) {
        // 兜底：本地标题子串匹配（ABS 搜索对中文分词有时不给力）
        const all = state.items.length ? state.items : (await abs.getLibraryItems(state.libraryId, { limit: 2000 }))?.results || []
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

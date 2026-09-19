/**
 * 歌单页（老板 2026-09-14，方案 A）：
 *  首页三入口「历史记录 / 我的收藏 / 歌单」→ 本页歌单列表 → 点歌单看曲目（歌单详情子页）。
 *
 * 仅 ND 提供数据（Subsonic playlist）；ABS 激活时本页显示空态
 * （ABS 的对应物是收藏夹，已有「我的收藏」页，不做双份）。
 */
import { hub } from '../lib/servers.js'
import { state, go, goBack, toast, esc, fmtDur, playItem, updateMini } from '../app.js'
import { icon } from '../lib/icons.js'
import { haptic } from '../lib/haptics.js'
import { fallbackCover, wireCoverFallback } from '../lib/cover.js'
import { openAddToPlaylist, openNewPlaylistDialog } from '../lib/playlist-ui.js'
import { artistLink } from '../lib/artist-links.js'

export async function renderPlaylists(root) {
  root.innerHTML = `
    <div class="page-head">
      <button class="icon-btn" id="btnBack" aria-label="返回">${icon('back', 22)}</button>
      <div class="page-title">歌单</div>
      <button class="icon-btn" id="btnNew" aria-label="新建歌单">${icon('playlist', 22)}</button>
    </div>
    <div id="plBody"><div class="empty"><div class="glyph">${icon('loader', 40, 'spin')}</div>加载中…</div></div>`

  root.querySelector('#btnBack').onclick = () => { haptic.tap(); goBack('kidhome') }
  root.querySelector('#btnNew').onclick = () => { haptic.tap(); openNewPlaylistDialog({}, { onDone: () => renderPlaylists(root) }) }

  const body = root.querySelector('#plBody')

  if (hub.active !== 'nd') {
    body.innerHTML = `<div class="empty"><div class="glyph">${icon('playlist', 44)}</div>歌单功能在音乐库（Navidrome）下可用</div>`
    return
  }

  let pls = []
  try {
    pls = await hub.getPlaylists()
  } catch (e) {
    body.innerHTML = `<div class="empty"><div class="glyph">${icon('warning', 44)}</div>${esc(e.message)}</div>`
    return
  }

  if (!pls.length) {
    body.innerHTML = `<div class="empty"><div class="glyph">${icon('playlist', 44)}</div>还没有歌单<div style="margin-top:16px"><button class="btn" id="emptyNew">新建歌单</button></div></div>`
    body.querySelector('#emptyNew').onclick = () => { haptic.tap(); openNewPlaylistDialog([], { onDone: () => renderPlaylists(root) }) }
    return
  }

  body.innerHTML = `<div class="settings-group" style="padding:4px 0">
    ${pls.map(p => `<div class="list-item" data-pl="${p.id}">
      <div class="cover-slot">
        ${fallbackCover({ title: p.name, cls: 'cover-ph-list' })}
        <img class="list-cover" data-cover src="${hub.nd.coverUrl(p._ndPlaylistId, { width: 160 })}" alt="" loading="lazy">
      </div>
      <div class="list-main">
        <div class="list-title">${esc(p.name)}</div>
        <div class="list-sub">${p.songCount} 首${p.duration ? ' · ' + fmtDur(p.duration) : ''}</div>
      </div>
      <div class="list-pct">${icon('forward', 16)}</div>
    </div>`).join('')}
  </div>`
  wireCoverFallback(body)

  body.querySelectorAll('[data-pl]').forEach(el => {
    el.onclick = () => { haptic.tap(); go('playlistDetail', { id: el.dataset.pl }) }
  })

  updateMini()
}

/** 歌单详情：曲目列表 + 播放全部 + 加歌 + 删歌 */
export async function renderPlaylistDetail(root, params = {}) {
  const pid = params.id
  if (!pid) { await goBack('kidhome'); return }
  root.innerHTML = `<div class="empty"><div class="glyph">${icon('loader', 40, 'spin')}</div>加载中…</div>`

  let pl
  try {
    pl = await hub.getPlaylist(pid)
  } catch (e) {
    root.innerHTML = `
      <div class="page-head">
        <button class="icon-btn" id="btnBack" aria-label="返回">${icon('back', 22)}</button>
        <div class="page-title">歌单</div>
      </div>
      <div class="empty"><div class="glyph">${icon('warning', 44)}</div>${esc(e.message)}</div>`
    root.querySelector('#btnBack').onclick = () => goBack('playlists')
    return
  }

  const songs = pl.songs || []
  root.innerHTML = `
    <div class="page-head">
      <button class="icon-btn" id="btnBack" aria-label="返回">${icon('back', 22)}</button>
      <div class="page-title" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(pl.name)}</div>
      <button class="icon-btn" id="btnMore" aria-label="更多">${icon('more', 22)}</button>
    </div>
    <div class="album-hero" style="margin-bottom:6px">
      <div class="album-meta" style="flex:1">
        <div class="album-sub">${songs.length} 首${pl.duration ? ' · ' + fmtDur(pl.duration) : ''}</div>
        <div style="display:flex;gap:10px;margin-top:14px">
          <button class="btn" id="playAll" style="padding:11px 20px">${icon('play', 16)} 播放全部</button>
          <button class="btn ghost" id="addSongs" style="padding:11px 16px">${icon('playlist', 16)} 加歌</button>
        </div>
      </div>
    </div>
    <div id="plSongs"></div>`

  const box = root.querySelector('#plSongs')
  if (!songs.length) {
    box.innerHTML = `<div class="empty"><div class="glyph">${icon('playlist', 44)}</div>歌单还是空的，点上面的「加歌」添加</div>`
  } else {
    box.innerHTML = `<div class="settings-group" style="padding:4px 0">
      ${songs.map((s, i) => `<div class="list-item" data-idx="${i}" data-songid="${esc(s.songId)}">
        <div class="list-main">
          <div class="list-title">${esc(s.title || `第 ${i + 1} 首`)}</div>
          <div class="list-sub">${artistLink(s.artist, s.artistId)}${s.album ? (s.artist ? ' · ' : '') + esc(s.album) : ''}${s.duration ? ' · ' + fmtDur(s.duration) : ''}</div>
        </div>
        <div class="list-pct">${icon('play', 15)}</div>
      </div>`).join('')}
    </div>`
  }

  root.querySelector('#btnBack').onclick = () => { haptic.tap(); goBack('playlists') }

  /** 播放歌单里的第 i 首：歌单曲目跨专辑，先查它所在专辑拿到全书时间轴，
   *  再按 startOffset 定位到那一首（复用专辑详情页同一套机制）。
   *  后续歌接着放由播放器队列负责（同专辑内自然接续）。 */
  const playFrom = async (i) => {
    const s = songs[i]
    if (!s) return
    if (!s.albumId) { toast('这首歌缺专辑信息，播不了'); return }
    try {
      const album = await hub.getItem(s.albumId)
      const chs = album?.media?.chapters || []
      const idx = chs.findIndex(ch => ch?._nd?.songId === s.songId)
      const start = idx >= 0 ? (chs[idx].start || 0) : 0
      await playItem(album, { startTime: start })
    } catch (e) { toast(e.message || '播放失败') }
  }
  root.querySelector('#playAll').onclick = () => { haptic.tap(); playFrom(0) }
  box.querySelectorAll('[data-idx]').forEach(el => {
    el.onclick = () => { haptic.tap(); playFrom(Number(el.dataset.idx)) }
  })
  root.querySelector('#addSongs').onclick = () => { haptic.tap(); toast('在搜索页选中歌曲后添加到这个歌单'); go('search') }

  // ⋯ 菜单：删除歌单
  root.querySelector('#btnMore').onclick = () => {
    haptic.tap()
    const modal = document.createElement('div')
    modal.className = 'lock'
    modal.innerHTML = `<div class="lock-card">
      <div class="lock-title">${esc(pl.name)}</div>
      <button class="sheet-item" data-act="del">
        <span class="sheet-ic">${icon('trash', 20)}</span>
        <span class="sheet-label">删除歌单</span>
      </button>
    </div>`
    document.body.appendChild(modal)
    modal.addEventListener('click', async e => {
      const b = e.target.closest('[data-act]')
      if (!b) { if (e.target === modal) modal.remove(); return }
      modal.remove()
      if (b.dataset.act !== 'del') return
      // 二次确认
      const confirm = document.createElement('div')
      confirm.className = 'lock'
      confirm.innerHTML = `<div class="lock-card">
        <div class="lock-title">删除歌单？</div>
        <div class="lock-sub">「${esc(pl.name)}」会被删掉，歌曲本身不受影响。</div>
        <div class="lock-actions">
          <button class="btn ghost" id="dlCancel">取消</button>
          <button class="btn danger" id="dlOk">删除</button>
        </div>
      </div>`
      document.body.appendChild(confirm)
      confirm.querySelector('#dlCancel').onclick = () => confirm.remove()
      confirm.addEventListener('click', e => { if (e.target === confirm) confirm.remove() })
      confirm.querySelector('#dlOk').onclick = async () => {
        confirm.remove()
        try {
          await hub.deletePlaylist(pid)
          haptic.success()
          toast('已删除歌单')
          await go('playlists', {}, { replace: true })
        } catch (e) { haptic.error(); toast('删除失败：' + e.message) }
      }
    })
  }

  updateMini()
}

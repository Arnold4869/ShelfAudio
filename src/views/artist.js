/**
 * 歌手页（Navidrome，老板 2026-09-17）
 *
 * 老板原话：正常的播放器点歌手名字，会显示他的所有的作品。
 * 入口：ND 播放页标题区的歌手行（第二行）→ go('artist', { id })
 * 内容：歌手头像 + 名下全部专辑（getArtist 原生返回）+ 全部歌曲
 *      （search3 按名搜 + artistId 过滤，实测 174/174 全对上）。
 * 点歌 → 进所在专辑定位播放（复用 album 路由的 songId 机制，跨专辑也能播）。
 * 点专辑 → 专辑详情页。
 * ABS 没有歌手概念：路由层保证不会带着 ABS id 进来（hub.getArtist 返回 null）。
 */
import { hub, hub as abs } from '../lib/servers.js'
import { go, goBack, toast, esc, fmtDur } from '../app.js'
import { icon } from '../lib/icons.js'
import { haptic } from '../lib/haptics.js'
import { fallbackCover, wireCoverFallback } from '../lib/cover.js'

/** 歌手头像：ND 没抓到真实照片时（实测全库都是默认星图）用首字圆形占位兜底 */
function avatarHTML(name, url) {
  const ch = [...(String(name).trim() || '?')][0]
  return `<div class="artist-avatar">
    ${url ? `<img src="${url}" alt="" loading="lazy" onerror="this.remove()">` : ''}
    <span class="artist-avatar-ph">${esc(ch)}</span>
  </div>`
}

export async function renderArtist(root, params = {}) {
  const id = params.id
  if (!id) { await goBack('kidhome'); return }

  root.innerHTML = `<div class="empty"><div class="glyph">${icon('loader', 40, 'spin')}</div>正在加载…</div>`

  let art = null
  try {
    art = await hub.getArtist(id)
  } catch (e) {
    root.innerHTML = `<div class="page-head">
        <button class="icon-btn" id="btnBack" aria-label="返回">${icon('back', 22)}</button>
        <div class="page-title">歌手</div>
      </div>
      <div class="empty"><div class="glyph">${icon('warning', 44)}</div>${esc(e.message || '打不开这个歌手')}</div>`
    root.querySelector('#btnBack').onclick = () => { haptic.tap(); goBack('kidhome') }
    return
  }
  if (!art) { await goBack('kidhome'); return }   // 非 ND 源（防御：正常路由不会走到）

  const name = art.name || '未知歌手'
  const albums = art.albums || []
  const songs = art.songs || []

  // 歌名可能带引号/尖括号，data-album 属性走 esc 转义
  root.innerHTML = `
    <div class="page-head">
      <button class="icon-btn" id="btnBack" aria-label="返回">${icon('back', 22)}</button>
      <div class="page-title">歌手</div>
    </div>

    <div class="artist-hero">
      ${avatarHTML(name, hub.artistImageUrl(id, { width: 300 }))}
      <div class="artist-hero-meta">
        <div class="artist-hero-name">${esc(name)}</div>
        <div class="artist-hero-sub">${albums.length} 张专辑${songs.length ? ' · ' + songs.length + ' 首歌' : ''}</div>
      </div>
    </div>

    ${albums.length ? `<div class="section-h">专辑 <small>${albums.length}</small></div>
    <div class="shelf-grid">${albums.map(it => {
      const m = it.media?.metadata || {}
      return `<div class="book-card" data-album="${esc(it.id)}">
        <div class="cover-slot">
          ${fallbackCover({ title: m.title || '', author: m.authorName || '', cls: 'cover-ph-card' })}
          <img class="book-cover" data-cover src="${abs.coverUrl(it.id, { width: 420 })}" alt="" loading="lazy">
        </div>
        <div class="book-meta">
          <div class="book-title">${esc(m.title || '未命名')}</div>
          <div class="book-sub">${esc(m.authorName || '')}</div>
        </div>
      </div>`
    }).join('')}</div>` : ''}

    ${songs.length ? `<div class="section-h">歌曲 <small>${songs.length}</small></div>
    <div class="settings-group" style="padding:4px 0">
      ${songs.map(s => `<div class="list-item song-item" data-song="${esc(s.songId)}" data-album="${esc(s.albumId)}">
        <div class="list-main">
          <div class="list-title">${esc(s.title || '未命名')}</div>
          <div class="list-sub">${esc(s.album || '')}${s.album && s.duration ? ' · ' : ''}${s.duration ? fmtDur(s.duration) : ''}</div>
        </div>
        <div class="list-pct">${icon('play', 15)}</div>
      </div>`).join('')}
    </div>` : ''}

    ${!albums.length && !songs.length ? `<div class="empty"><div class="glyph">${icon('empty', 44)}</div>还没有作品</div>` : ''}
  `

  wireCoverFallback(root)

  root.querySelector('#btnBack').onclick = () => { haptic.tap(); goBack('kidhome') }

  root.querySelectorAll('[data-album]').forEach(el => {
    if (!el.dataset.album) return
    el.onclick = () => { haptic.tap(); go('album', { id: el.dataset.album }) }
  })
  // 歌曲行：进所在专辑并从这首开始播（复用 album 页的 songId 定位机制）。
  // 注意先 closest('.list-item') 再判 albumId —— 卡片和歌曲行都有 data-album，
  // 这里只对 .list-item 生效（上面专辑卡已经绑过 go('album')）。
  root.querySelectorAll('.list-item[data-song]').forEach(el => {
    el.onclick = async () => {
      haptic.tap()
      const albumId = el.dataset.album
      const songId = el.dataset.song
      if (!albumId) { toast('这首歌拿不到专辑信息'); return }
      await go('album', { id: albumId, songId })
    }
  })
}

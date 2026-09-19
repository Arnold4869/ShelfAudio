/**
 * 歌手页（Navidrome，老板 2026-09-17 建 / 2026-09-19 改版）
 *
 * 老板原话：正常的播放器点歌手名字，会显示他的所有的作品。
 * 入口：所有出现演唱者的地方（播放页歌手行、搜索歌手行/歌曲行的歌手、
 *      专辑页歌手、歌单详情歌曲行、歌手页自身）→ go('artist', { id })
 *
 * 【2026-09-19 改版（老板口述）】
 *  「点击名字进入后，只显示专辑或列表，可以在右上角点击切换」
 *  → 进页默认只显示**一段**（专辑），右上角按钮切成歌曲列表；不再两段全铺。
 *    切过之后的选择在本次会话内记住（换歌手页保持上次的视图，符合直觉）。
 *
 * 【同轮修复的真 bug】
 *  歌手页点歌 404：getArtist() 返回的 song.albumId 没带 nd: 前缀 →
 *  被 sourceOfId 判成 ABS → 拿裸 ND id 去查有声书服务器 → 404。
 *  数据层已修（navidrome.js），本页再兜一层：点歌前补前缀。
 */
import { hub, hub as abs } from '../lib/servers.js'
import { go, goBack, toast, esc, fmtDur } from '../app.js'
import { icon } from '../lib/icons.js'
import { haptic } from '../lib/haptics.js'
import { fallbackCover, wireCoverFallback } from '../lib/cover.js'
import { wireArtistLinks, artistLink, artistIdOf } from '../lib/artist-links.js'

/** 当前视图：'albums' | 'songs'。会话内记住（老板要的\"右上角切换\"） */
let view = 'albums'

/** 歌手头像：ND 没抓到真实照片时（实测全库都是默认星图）用首字圆形占位兜底 */
function avatarHTML(name, url) {
  const ch = [...(String(name).trim() || '?')][0]
  return `<div class="artist-avatar">
    ${url ? `<img src="${url}" alt="" loading="lazy" onerror="this.remove()">` : ''}
    <span class="artist-avatar-ph">${esc(ch)}</span>
  </div>`
}

/** ND id 统一补前缀（裸 id 会被当 ABS → 404，见文件头注释） */
const ndAlbumId = v => {
  const s = String(v || '')
  if (!s) return ''
  return s.startsWith('nd:') ? s : 'nd:' + s
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

  // 两段都空时没有可切的视图
  if (!albums.length && view === 'albums') view = 'songs'
  else if (!songs.length && view === 'songs') view = 'albums'

  const albumHTML = () => albums.length
    ? `<div class="shelf-grid">${albums.map(it => {
        const m = it.media?.metadata || {}
        return `<div class="book-card" data-album="${esc(it.id)}">
          <div class="cover-slot">
            ${fallbackCover({ title: m.title || '', author: m.authorName || '', cls: 'cover-ph-card' })}
            <img class="book-cover" data-cover src="${abs.coverUrl(it.id, { width: 420 })}" alt="" loading="lazy">
          </div>
          <div class="book-meta">
            <div class="book-title">${esc(m.title || '未命名')}</div>
            <div class="book-sub">${artistLink(m.authorName || '', artistIdOf(it))}</div>
          </div>
        </div>`
      }).join('')}</div>`
    : `<div class="empty" style="margin-top:30px"><div class="glyph">${icon('empty', 44)}</div>还没有专辑</div>`

  const songHTML = () => songs.length
    ? `<div class="settings-group" style="padding:4px 0">
      ${songs.map(s => `<div class="list-item song-item" data-song="${esc(s.songId)}" data-album="${esc(ndAlbumId(s.albumId))}">
        <div class="list-main">
          <div class="list-title">${esc(s.title || '未命名')}</div>
          <div class="list-sub">${esc(s.album || '')}${s.album && s.duration ? ' · ' : ''}${s.duration ? fmtDur(s.duration) : ''}</div>
        </div>
        <div class="list-pct">${icon('play', 15)}</div>
      </div>`).join('')}
    </div>`
    : `<div class="empty" style="margin-top:30px"><div class="glyph">${icon('empty', 44)}</div>还没有歌曲</div>`

  root.innerHTML = `
    <div class="page-head">
      <button class="icon-btn" id="btnBack" aria-label="返回">${icon('back', 22)}</button>
      <div class="page-title">歌手</div>
      <button class="icon-btn" id="btnView" aria-label="切换专辑/歌曲视图" title="${view === 'albums' ? '切到歌曲' : '切到专辑'}">${icon('list', 22)}</button>
    </div>

    <div class="artist-hero">
      ${avatarHTML(name, hub.artistImageUrl(id, { width: 300 }))}
      <div class="artist-hero-meta">
        <div class="artist-hero-name">${esc(name)}</div>
        <div class="artist-hero-sub">${albums.length} 张专辑${songs.length ? ' · ' + songs.length + ' 首歌' : ''}</div>
      </div>
    </div>

    <div class="section-h" id="artistSec">${view === 'albums'
      ? `专辑 <small>${albums.length}</small>`
      : `歌曲 <small>${songs.length}</small>`}</div>
    <div id="artistBody">${view === 'albums' ? albumHTML() : songHTML()}</div>
  `

  const body = root.querySelector('#artistBody')
  const secEl = root.querySelector('#artistSec')
  const btnView = root.querySelector('#btnView')

  const paint = (v) => {
    view = v
    secEl.innerHTML = v === 'albums' ? `专辑 <small>${albums.length}</small>` : `歌曲 <small>${songs.length}</small>`
    body.innerHTML = v === 'albums' ? albumHTML() : songHTML()
    btnView.title = v === 'albums' ? '切到歌曲' : '切到专辑'
    btnView.setAttribute('aria-label', v === 'albums' ? '切到歌曲' : '切到专辑')
    wireBody()
  }

  /** 当前显示的那一段绑事件（切换后要重绑，DOM 被重建了） */
  const wireBody = () => {
    wireCoverFallback(body)
    body.querySelectorAll('.book-card[data-album]').forEach(el => {
      if (!el.dataset.album) return
      el.onclick = () => { haptic.tap(); go('album', { id: el.dataset.album }) }
    })
    // 歌曲行：进所在专辑并从这首开始播（复用 album 页的 songId 定位机制）。
    body.querySelectorAll('.list-item[data-song]').forEach(el => {
      el.onclick = async () => {
        haptic.tap()
        const albumId = el.dataset.album
        const songId = el.dataset.song
        if (!albumId) { toast('这首歌拿不到专辑信息'); return }
        await go('album', { id: albumId, songId })
      }
    })
  }

  wireBody()

  root.querySelector('#btnBack').onclick = () => { haptic.tap(); goBack('kidhome') }
  btnView.onclick = () => {
    haptic.select()
    // 两段都有才允许切；只有一段时按钮点了没意义 → 直接给结果反馈
    if (!albums.length || !songs.length) {
      toast(view === 'albums' ? (albums.length ? '这个歌手只有专辑' : '这个歌手只有歌曲') : (songs.length ? '这个歌手只有歌曲' : '这个歌手只有专辑'))
      return
    }
    paint(view === 'albums' ? 'songs' : 'albums')
  }

  // 歌手页里也可能出现歌手名（如后续扩展），统一走委托
  wireArtistLinks(root)
}

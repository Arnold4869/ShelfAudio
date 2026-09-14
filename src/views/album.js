/**
 * 专辑详情页（Navidrome）
 *
 * 老板 2026-09-14：
 *  「点击列表页的专辑，然后它直接播放，好像是整个专辑。正常应该是点进专辑，
 *   我自己选个单曲播放」
 *
 * 所以 ND 的专辑不再"点了就整张连播"：点进本页看歌曲列表，点哪首从哪首开始播。
 * 后续歌接着放是自然的（播放器本来就是整张的轨道序列）——
 * 老板要的是"我自己选"，不是"只听一首"。
 *
 * ABS 的书不走这里（ABS 那边点书=开始/续听整本，是原有行为，老板没让改）。
 */
import { hub, hub as abs } from '../lib/servers.js'
import { state, go, goBack, toast, playItem, updateMini, fmtDur } from '../app.js'
import { icon } from '../lib/icons.js'
import { haptic } from '../lib/haptics.js'
import { fallbackCover, wireCoverFallback } from '../lib/cover.js'
import { t } from '../lib/terms.js'

export async function renderAlbum(root, params = {}) {
  const id = params.id
  if (!id) { await goBack('kidhome'); return }

  root.innerHTML = `<div class="empty"><div class="glyph">${icon('loader', 40, 'spin')}</div>正在加载…</div>`

  let item = null
  try {
    item = await abs.getItem(id)
  } catch (e) {
    root.innerHTML = `<div class="page-head">
        <button class="icon-btn" id="btnBack" aria-label="返回">${icon('back', 22)}</button>
        <div class="page-title">专辑</div>
      </div>
      <div class="empty"><div class="glyph">${icon('warning', 44)}</div>${e.message || '打不开这张专辑'}</div>`
    root.querySelector('#btnBack').onclick = () => { haptic.tap(); goBack('kidhome') }
    return
  }

  const m = item.media?.metadata || {}
  const title = m.title || item.title || '未命名'
  const author = m.authorName || m.narratorName || ''
  const songs = item.media?.chapters || []
  const cover = abs.coverUrl(id, { width: 600 })

  root.innerHTML = `
    <div class="page-head">
      <button class="icon-btn" id="btnBack" aria-label="返回">${icon('back', 22)}</button>
      <div class="page-title">专辑</div>
    </div>

    <div class="album-hero">
      <div class="album-cover">
        ${fallbackCover({ title, author, cls: 'cover-ph-hero' })}
        <img data-cover src="${cover}" alt="" loading="lazy">
      </div>
      <div class="album-meta">
        <div class="album-title">${escH(title)}</div>
        ${author ? `<div class="album-artist">${escH(author)}</div>` : ''}
        <div class="album-sub">${songs.length} 首${item.media?.duration ? ' · ' + fmtDur(item.media.duration) : ''}</div>
        <button class="btn" id="playAll" style="margin-top:14px;padding:11px 20px">${icon('play', 16)} 播放全部</button>
      </div>
    </div>

    <div class="section-h">歌曲 <small>${songs.length} 首</small></div>
    <div class="settings-group" style="padding:4px 0">
      ${songs.map((ch, i) => `<div class="list-item" data-idx="${i}">
        <div class="list-main">
          <div class="list-title">${escH(ch.title || `第 ${i + 1} 首`)}</div>
          <div class="list-sub">${ch.duration ? fmtDur(ch.duration) : ''}</div>
        </div>
        <div class="list-pct">${icon('play', 15)}</div>
      </div>`).join('')}
    </div>
  `

  wireCoverFallback(root)

  const byIndex = i => ({ item, index: i })
  const playFrom = async (i) => {
    const start = songs[i]?.start || 0
    // 用 startTime 指定从第 i 首开始：播放器按 startOffset 换算到对应音轨
    // （整张仍在队列里，听完这首会自然往下走 —— 老板要的是"自己选"，不是"只听一首"）
    try { await playItem(item, { startTime: start }) }
    catch (e) { toast(e.message || t('openFail')) }
  }

  root.querySelectorAll('.list-item[data-idx]').forEach(el => {
    el.onclick = () => { haptic.tap(); playFrom(Number(el.dataset.idx)) }
  })
  root.querySelector('#playAll').onclick = () => { haptic.tap(); playFrom(0) }
  root.querySelector('#btnBack').onclick = () => { haptic.tap(); goBack('kidhome') }

  // 从搜索页点了某首歌进来：直接从那首开始播（老板「我自己选个单曲播放」）
  if (params.songId) {
    const i = songs.findIndex(ch => (ch?._nd?.songId === params.songId) || (ch?._nd?.id === params.songId))
    if (i >= 0) await playFrom(i)
  }

  updateMini()
}

function escH(s) {
  return String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))
}

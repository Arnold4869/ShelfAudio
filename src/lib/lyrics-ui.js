/**
 * 歌词页（老板 2026-09-14）：
 *  「正常我需要点击它的封面，会切换到歌词那个界面。需要随着歌声，一直动态显示
 *   当前的歌词，也会向下显示之前的歌词或之后的，就那种常见的音乐播放的歌词页面」
 *
 * 实现：全屏浮层（.lock 全屏变体）+ 歌词行列表。
 *  - 数据：hub.getLyrics(当前歌曲 songId) → { synced, lines:[{start(秒), value}] }
 *  - 高亮：监听 sa:time（每秒触发），二分找当前行；滚动定位用 scrollIntoView 的
 *    block:'center' 手工换算（容器 scrollTo，避免页面整体滚）。
 *  - 仅 ND 提供；ABS 无歌词接口，入口不渲染。
 */
import { hub } from './servers.js'
import { state, esc } from '../app.js'
import { icon } from './icons.js'
import { haptic } from './haptics.js'

/** 当前应该高亮的行下标（最后一个 start <= t 的行） */
function lineAt(lines, t) {
  let lo = 0, hi = lines.length - 1, ans = -1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (lines[mid].start <= t) { ans = mid; lo = mid + 1 }
    else hi = mid - 1
  }
  return ans
}

export function openLyricsPage() {
  const c = state.current, p = state.player
  if (!c || !p) return
  const tr = c.tracks[p.trackIndex]
  // ⚠️ 必须补 nd: 前缀：hub.getLyrics 按 id 前缀分派源（裸 songId 会被判成 ABS → 返回 null）。
  // 这个 bug 就是回归测试抓出来的（歌词页一直空）。
  const rawSongId = tr?._nd?.songId || String(tr?.contentUrl || '').match(/[?&]id=([^&]+)/)?.[1]
  const songId = rawSongId ? 'nd:' + String(rawSongId).replace(/^nd:/, '') : ''
  if (!songId) return

  const modal = document.createElement('div')
  modal.className = 'lock lyrics-lock'
  modal.innerHTML = `
    <div class="lyrics-page">
      <div class="lyrics-head">
        <button class="icon-btn" id="lyrBack" aria-label="返回">${icon('back', 22)}</button>
        <div class="lyrics-title">${esc(tr?.title || c.title || '')}</div>
        <div style="width:40px"></div>
      </div>
      <div class="lyrics-body" id="lyrBody">
        <div class="lyrics-loading"><div class="glyph">${icon('loader', 40, 'spin')}</div>加载歌词…</div>
      </div>
    </div>`
  document.body.appendChild(modal)

  const close = () => {
    window.removeEventListener('sa:time', onTime)
    window.removeEventListener('sa:track', onTrack)
    modal.remove()
  }
  modal.querySelector('#lyrBack').onclick = () => { haptic.tap(); close() }
  modal.addEventListener('click', e => { if (e.target === modal) close() })

  const body = modal.querySelector('#lyrBody')
  let lines = null
  let synced = false
  let curLine = -1
  let rowEls = []

  const paint = () => {
    if (!lines) return
    const t = p.position().currentTime - (c.tracks[p.trackIndex]?.startOffset || 0)
    const idx = synced ? lineAt(lines, t) : -1
    if (idx === curLine) return
    curLine = idx
    rowEls.forEach((el, i) => el.classList.toggle('on', i === idx))
    if (idx >= 0 && rowEls[idx]) {
      // 歌词滚动：只滚歌词容器，不牵动页面
      const el = rowEls[idx]
      const target = el.offsetTop - body.clientHeight / 2 + el.clientHeight / 2
      try { body.scrollTo({ top: Math.max(0, target), behavior: 'smooth' }) } catch (_) { body.scrollTop = Math.max(0, target) }
    }
  }

  const onTime = () => { if (lines && synced) paint() }
  // 换歌（切到下一首）→ 重拉歌词
  const onTrack = () => {
    if (!document.body.contains(modal)) return
    const nt = c.tracks[p.trackIndex]
    const raw = nt?._nd?.songId || String(nt?.contentUrl || '').match(/[?&]id=([^&]+)/)?.[1]
    const nid = raw ? 'nd:' + String(raw).replace(/^nd:/, '') : ''
    if (nid && nid !== songId) {
      modal.remove()
      openLyricsPage()
    }
  }
  window.addEventListener('sa:time', onTime)
  window.addEventListener('sa:track', onTrack)

  // 拉歌词
  ;(async () => {
    let lyr = null
    try { lyr = await hub.getLyrics(songId) } catch (_) {}
    if (!lyr || !lyr.lines?.length) {
      body.innerHTML = `<div class="lyrics-empty"><div class="glyph">${icon('lyrics', 44)}</div>这首歌没有歌词</div>`
      return
    }
    lines = lyr.lines
    synced = !!lyr.synced
    body.innerHTML = lines.map(l => `<div class="lyrics-line${synced ? '' : ' static'}">${esc(l.value) || '&nbsp;'}</div>`).join('')
    rowEls = [...body.querySelectorAll('.lyrics-line')]
    if (!synced) {
      // 纯文本歌词：不高亮不滚动，铺开即可
      body.classList.add('nonsync')
      return
    }
    curLine = -1
    paint()
  })()
}

/**
 * 歌单 UI 公共件（老板 2026-09-14）
 *
 * 需求原话：
 *  「需要歌曲内添加到歌单的功能，在搜索那也可以在搜索结果时选中添加到歌单，也能全选添加」
 *
 * 提供两个能力：
 *   openAddToPlaylist(songs)  —— 弹「选择歌单」浮层（含新建歌单），把 songs 加进去
 *   openNewPlaylistDialog(...) —— 只建新歌单
 *
 * songs: [{ id: 'nd:<songId>', title }] —— id 必须带 nd: 前缀（App 内部统一 id 口径）
 */
import { hub } from './servers.js'
import { esc, toast } from '../app.js'
import { icon } from './icons.js'
import { haptic } from './haptics.js'
import { fmtDur } from '../app.js'

/**
 * 弹出歌单选择器，把 songs 加进所选歌单。
 * @param {Array<{id:string,title?:string}>} songs 要加入的歌曲（id 形如 nd:<songId>）
 * @param {object} [opts]
 * @param {Function} [opts.onDone] 加完后的回调（刷新列表用）
 */
export async function openAddToPlaylist(songs, opts = {}) {
  const list = (songs || []).filter(s => s && s.id)
  if (!list.length) return
  const songIds = list.map(s => String(s.id).replace(/^nd:/, ''))

  const modal = document.createElement('div')
  modal.className = 'lock'
  modal.innerHTML = `<div class="lock-card">
    <div class="lock-title">添加到歌单</div>
    <div class="lock-sub">${list.length === 1 ? esc(list[0].title || '') : `已选 ${list.length} 首`}</div>
    <div id="plList" style="max-height:46vh;overflow:auto;margin:6px 0"><div class="lyrics-loading"><div class="glyph">${icon('loader', 30, 'spin')}</div>加载中…</div></div>
    <button class="sheet-item" id="plNew">
      <span class="sheet-ic">${icon('playlist', 20)}</span>
      <span class="sheet-label">新建歌单…</span>
    </button>
    <div class="lock-actions"><button class="btn ghost" id="plCancel">取消</button></div>
  </div>`
  document.body.appendChild(modal)
  const close = () => modal.remove()
  modal.querySelector('#plCancel').onclick = () => { haptic.tap(); close() }
  modal.addEventListener('click', e => { if (e.target === modal) close() })

  const box = modal.querySelector('#plList')
  const render = (pls) => {
    if (!pls.length) {
      box.innerHTML = `<div class="empty" style="padding:14px 0"><div class="glyph">${icon('playlist', 34)}</div>还没有歌单，点下面新建一个</div>`
      return
    }
    box.innerHTML = pls.map(p => `<div class="list-item" data-pl="${p.id}">
        <div class="list-main">
          <div class="list-title">${esc(p.name)}</div>
          <div class="list-sub">${p.songCount} 首${p.duration ? ' · ' + fmtDur(p.duration) : ''}</div>
        </div>
        <div class="list-pct">${icon('forward', 15)}</div>
      </div>`).join('')
    box.querySelectorAll('[data-pl]').forEach(el => {
      el.onclick = async () => {
        haptic.select()
        const pid = el.dataset.pl
        close()
        try {
          await hub.addSongsToPlaylist(pid, songIds)
          haptic.success()
          toast(`已添加 ${songIds.length} 首`)
          opts.onDone?.()
        } catch (e) { haptic.error(); toast('添加失败：' + e.message) }
      }
    })
  }

  modal.querySelector('#plNew').onclick = () => {
    haptic.tap()
    close()
    openNewPlaylistDialog(songIds, opts)
  }

  try {
    const pls = await hub.getPlaylists()
    render(pls || [])
  } catch (e) {
    box.innerHTML = `<div class="empty" style="padding:14px 0">${esc(e.message)}</div>`
  }
}

/**
 * 新建歌单（可带初始曲目）。建完可选「加入后立即打开」。
 * @param {string[]} songIds ND songId 数组（不带前缀）
 */
export function openNewPlaylistDialog(songIds = [], opts = {}) {
  const modal = document.createElement('div')
  modal.className = 'lock'
  modal.innerHTML = `<div class="lock-card">
    <div class="lock-title">新建歌单</div>
    <div class="lock-sub">${songIds.length ? `会同时加入 ${songIds.length} 首` : '给歌单起个名字'}</div>
    <input class="lock-input" id="plName" type="text" placeholder="歌单名称" maxlength="40" autocapitalize="off" autocorrect="off" style="text-align:left;letter-spacing:normal;font-size:17px" />
    <div class="lock-actions">
      <button class="btn ghost" id="npCancel">取消</button>
      <button class="btn" id="npOk">创建</button>
    </div>
  </div>`
  document.body.appendChild(modal)
  const input = modal.querySelector('#plName')
  setTimeout(() => input.focus(), 80)
  const close = () => modal.remove()
  modal.querySelector('#npCancel').onclick = () => { haptic.tap(); close() }
  modal.addEventListener('click', e => { if (e.target === modal) close() })

  const submit = async () => {
    const name = input.value.trim()
    if (!name) { toast('请填歌单名称'); input.focus(); return }
    close()
    try {
      await hub.createPlaylist(name, songIds)
      haptic.success()
      toast(`已创建「${name}」${songIds.length ? '，加入 ' + songIds.length + ' 首' : ''}`)
      opts.onDone?.()
    } catch (e) { haptic.error(); toast('创建失败：' + e.message) }
  }
  modal.querySelector('#npOk').onclick = submit
  input.onkeydown = e => { if (e.key === 'Enter') submit() }
}

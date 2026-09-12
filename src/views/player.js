/** 播放页：儿童模式=大圆按钮极简；成人模式=附加章节列表、倍速、睡眠定时、收藏 */
import { abs } from '../lib/api.js'
import { state, go, toast, esc, fmtTime, updateMini, requireParentPin } from '../app.js'
import { store, CONFIG_KEYS } from '../lib/store.js'
import { fallbackCover, wireCoverFallback } from '../lib/cover.js'

let sleepTimer = null
let sleepAt = 0
let adultTab = 'chapters'
let chaptersOpen = false   // 章节面板是否展开（儿童模式默认收起，点「选集」才展开）

export function getSleepRemaining() {
  if (!sleepAt) return 0
  return Math.max(0, Math.round((sleepAt - Date.now()) / 1000))
}

export async function renderPlayer(root) {
  const c = state.current
  const p = state.player
  if (!c || !p) {
    root.innerHTML = `<div class="empty"><div class="glyph">🎧</div>还没有在播放的书<div style="margin-top:18px"><button class="btn" id="toShelf">去书架</button></div></div>`
    root.querySelector('#toShelf').onclick = () => go(state.mode === 'adult' ? 'shelf' : 'kidhome')
    return
  }

  const kid = state.mode !== 'adult'
  const meta = c.item.media?.metadata || {}
  const chapters = c.chapters || []
  // 成人模式沿用「进来就能看到章节列表」；儿童模式收起，点 📑 选集 才展开
  chaptersOpen = !kid

  const shell = () => `
    <div class="page-head">
      <button class="icon-btn" id="btnBack" aria-label="返回">‹</button>
      <div class="page-title" style="font-size:20px">${kid ? '正在听' : esc(c.title)}</div>
      <button class="icon-btn" id="btnMore" aria-label="更多">⋯</button>
    </div>

    <div class="player-page">
      <div class="player-cover-wrap">
        <div class="cover-slot">
          ${fallbackCover({ title: c.title, author: c.author, cls: 'cover-ph-player' })}
          <img class="player-cover" id="pCover" data-cover src="${c.cover}" alt="">
        </div>
      </div>
      <div class="player-title" id="pTitle">${esc(c.title)}</div>
      <div class="player-chapter" id="pChapter"></div>

      <div class="seek-wrap">
        <div class="seek-bar" id="seekBar">
          <div class="seek-fill" id="seekFill"><div class="seek-knob"></div></div>
        </div>
        <div class="seek-times">
          <span id="tCur">0:00</span>
          <span id="tDur">0:00</span>
        </div>
      </div>

      <div class="player-controls">
        <button class="ctrl side" id="btnR15" aria-label="后退15秒">⟲<span style="font-size:11px;display:block">15</span></button>
        <button class="ctrl mid" id="btnPrev" aria-label="上一集">⏮</button>
        <button class="ctrl big" id="btnPlay" aria-label="播放/暂停">▶</button>
        <button class="ctrl mid" id="btnNext" aria-label="下一集">⏭</button>
        <button class="ctrl side" id="btnF15" aria-label="前进15秒">⟳<span style="font-size:11px;display:block">15</span></button>
      </div>

      <div class="player-tools">
        ${kid
          ? `<button class="tool-chip" id="btnRate">1.0×</button>
             <button class="tool-chip" id="btnSleep">⏰ 定时</button>
             <button class="tool-chip" id="btnChapters">📑 选集</button>`
          : `<button class="tool-chip" id="btnRate">1.0×</button>
             <button class="tool-chip" id="btnSleep">⏰ 定时</button>
             <button class="tool-chip" id="btnFav">♡ 收藏</button>
             <button class="tool-chip" id="btnInfo">ⓘ 信息</button>`}
      </div>

      <div id="extra"></div>
    </div>`

  root.innerHTML = shell()

  const $ = s => root.querySelector(s)
  const seekFill = $('#seekFill'), seekBar = $('#seekBar')

  function paintProgress() {
    const { currentTime, duration } = p.position()
    const pct = duration ? Math.min(100, (currentTime / duration) * 100) : 0
    seekFill.style.width = pct + '%'
    $('#tCur').textContent = fmtTime(currentTime)
    $('#tDur').textContent = fmtTime(duration)
    const ch = chapters[p.trackIndex]
    $('#pChapter').textContent = ch?.title || c.tracks[p.trackIndex]?.title || `第 ${p.trackIndex + 1} / ${c.tracks.length} 集`
  }
  function paintState() {
    $('#btnPlay').textContent = p.playing ? '❚❚' : '▶'
    $('#btnRate').textContent = (p.rate || 1).toFixed(1).replace(/\.0$/, '.0') + '×'
  }

  paintProgress(); paintState()

  // ---- 事件 ----
  const onTime = () => { if (document.body.dataset.view === 'player') { paintProgress(); updateMini() } }
  const onState = () => { paintState(); updateMini() }
  const onTrack = () => { paintProgress(); renderExtra() }
  window.addEventListener('sa:time', onTime)
  window.addEventListener('sa:state', onState)
  window.addEventListener('sa:track', onTrack)
  // 离开页面时解绑，防止重复监听
  root._cleanup = () => {
    window.removeEventListener('sa:time', onTime)
    window.removeEventListener('sa:state', onState)
    window.removeEventListener('sa:track', onTrack)
    window.removeEventListener('mousemove', moveDrag)
    window.removeEventListener('mouseup', endDrag)
  }

  $('#btnBack').onclick = () => go(kid ? 'kidhome' : 'shelf')
  $('#btnPlay').onclick = () => p.toggle()
  $('#btnPrev').onclick = () => p.prevTrack()
  $('#btnNext').onclick = () => p.nextTrack()
  $('#btnR15').onclick = () => p.seek(Math.max(0, p.position().currentTime - 15))
  $('#btnF15').onclick = () => p.seek(p.position().currentTime + 15)

  // 拖动进度条
  let dragging = false
  const seekFromEvent = e => {
    const rect = seekBar.getBoundingClientRect()
    const x = (e.touches?.[0]?.clientX ?? e.clientX) - rect.left
    const ratio = Math.max(0, Math.min(1, x / rect.width))
    seekFill.style.width = (ratio * 100) + '%'
    $('#tCur').textContent = fmtTime(ratio * (p.duration || 0))
    return ratio
  }
  const startDrag = e => { dragging = true; seekFromEvent(e) }
  const moveDrag = e => { if (dragging) { seekFromEvent(e); e.preventDefault?.() } }
  const endDrag = e => {
    if (!dragging) return
    dragging = false
    const ratio = seekFromEvent(e.changedTouches ? { clientX: e.changedTouches[0].clientX } : e)
    p.seek(ratio * (p.duration || 0))
  }
  seekBar.addEventListener('touchstart', startDrag, { passive: true })
  seekBar.addEventListener('touchmove', moveDrag, { passive: false })
  seekBar.addEventListener('touchend', endDrag)
  seekBar.addEventListener('mousedown', startDrag)
  window.addEventListener('mousemove', moveDrag)
  window.addEventListener('mouseup', endDrag)

  // ---- 倍速 ----
  const rates = [0.75, 1, 1.25, 1.5, 2]
  $('#btnRate').onclick = async () => {
    const cur = p.rate || 1
    const i = rates.indexOf(cur)
    const next = rates[(i + 1) % rates.length]
    await p.setRate(next)
    $('#btnRate').textContent = next.toFixed(2).replace(/0$/, '') + '×'
    await store.set(CONFIG_KEYS.playbackRate, String(next))
    toast('播放速度 ' + next + '×')
    if (!kid && adultTab === 'info') renderExtra()
  }

  // ---- 睡眠定时 ----
  $('#btnSleep').onclick = () => {
    const opts = [15, 30, 45, 60, 0]
    const labels = ['15 分钟', '30 分钟', '45 分钟', '60 分钟', '关闭定时']
    const modal = document.createElement('div')
    modal.className = 'lock'
    modal.innerHTML = `<div class="lock-card">
      <div class="lock-title">睡眠定时</div>
      <div class="lock-sub">${getSleepRemaining() ? '剩余 ' + Math.ceil(getSleepRemaining() / 60) + ' 分钟' : '到时间自动暂停'}</div>
      ${opts.map((m, i) => `<button class="btn block ghost" style="margin-bottom:9px" data-m="${m}">${labels[i]}</button>`).join('')}
    </div>`
    document.body.appendChild(modal)
    modal.addEventListener('click', async e => {
      const b = e.target.closest('[data-m]')
      if (!b && e.target !== modal) return
      if (b) {
        const m = parseInt(b.dataset.m, 10)
        setSleepTimer(m)
      }
      modal.remove()
    })
  }

  // ---- 选集 / 成人附加页 ----
  $('#btnMore').onclick = async () => {
    // 儿童模式下这个按钮通往设置，必须过家长锁，否则孩子能直接点出去
    if (kid) {
      if (await requireParentPin()) go('settings')
      return
    }
    adultTab = adultTab === 'chapters' ? 'info' : 'chapters'
    chaptersOpen = true
    renderExtra()
  }
  if ($('#btnChapters')) {
    const paintChapterBtn = () => { $('#btnChapters').textContent = chaptersOpen ? '📑 收起' : '📑 选集' }
    paintChapterBtn()
    $('#btnChapters').onclick = () => {
      chaptersOpen = !chaptersOpen
      adultTab = 'chapters'
      renderExtra()
      paintChapterBtn()
      if (chaptersOpen) $('#extra')?.scrollIntoView({ behavior: 'smooth', block: 'start' })
      else scrollPlayerIntoView()
    }
  }
  if ($('#btnInfo')) $('#btnInfo').onclick = () => { adultTab = 'info'; chaptersOpen = true; renderExtra() }
  if ($('#btnFav')) $('#btnFav').onclick = async () => {
    try {
      const cols = await abs.collections()
      const col = cols[0]
      if (!col) { toast('ABS 里还没有收藏夹'); return }
      await abs.addToCollection(col.id, c.item.id)
      toast('已加入「' + col.name + '」')
    } catch (e) { toast('收藏失败：' + e.message) }
  }

  /** 把播放区滚回视野中央：选完章节后用户应看到封面+播放按钮，而不是页面底部的列表 */
  function scrollPlayerIntoView() {
    const target = root.querySelector('.player-cover-wrap') || root.querySelector('.player-controls')
    if (!target) return
    // 等 DOM 更新完再滚，否则刚被清空的列表会让高度突变
    requestAnimationFrame(() => {
      try { target.scrollIntoView({ behavior: 'smooth', block: 'center' }) } catch (_) {}
    })
  }

  function renderExtra() {
    const box = $('#extra')
    // 收起时清空。注意：儿童模式也要能渲染章节，
    // 之前这里 `if (kid) return` 导致儿童模式点「选集」永远没反应。
    if (!chaptersOpen) { box.innerHTML = ''; return }

    if (adultTab === 'chapters' || kid) {
      box.innerHTML = `
        <div class="section-h" style="margin-top:22px">章节 <small>共 ${chapters.length} 集</small></div>
        <div class="${kid ? 'chapters kid-chapters' : 'chapters'}">
        ${chapters.map((ch, i) => `
          <div class="chapter-item ${i === p.trackIndex ? 'active' : ''}" data-ch="${i}">
            <div class="chapter-idx">${i + 1}</div>
            <div class="chapter-title">${esc(ch.title || '第 ' + (i + 1) + ' 集')}</div>
            <div class="chapter-dur">${fmtTime((ch.end || 0) - (ch.start || 0))}</div>
          </div>`).join('')}
        </div>`
      box.querySelectorAll('[data-ch]').forEach(el => {
        el.onclick = async () => {
          const i = parseInt(el.dataset.ch, 10)
          // 正在播时换集：播放器内部会停掉旧音轨再播新的（见 _keepOnly）
          await p.seek(chapters[i].start || 0)
          // 选完就收尾：收起章节列表并滚回播放控件，
          // 否则画面停在页面底部的章节区，看起来像"点了没返回"。
          if (kid) {
            chaptersOpen = false
            renderExtra()
          } else {
            renderExtra()
          }
          scrollPlayerIntoView()
        }
      })
    } else {
      const m = c.item.media || {}
      const md = m.metadata || {}
      box.innerHTML = `
        <div class="section-h" style="margin-top:22px">书籍信息</div>
        <div class="settings-group" style="padding:16px 18px;line-height:1.9;font-size:14px">
          <div><span style="color:var(--text-dim)">书名：</span>${esc(md.title || '')}</div>
          <div><span style="color:var(--text-dim)">作者：</span>${esc(md.authorName || '未知')}</div>
          <div><span style="color:var(--text-dim)">演播：</span>${esc(md.narratorName || '未知')}</div>
          <div><span style="color:var(--text-dim)">时长：</span>${fmtTime(c.duration)}</div>
          <div><span style="color:var(--text-dim)">集数：</span>${c.tracks.length}</div>
          <div><span style="color:var(--text-dim)">倍速：</span>${(p.rate || 1)}×</div>
        </div>
        ${md.description ? `<div class="settings-group" style="padding:16px 18px;font-size:14px;line-height:1.8;color:var(--text-dim)">${esc(String(md.description).replace(/<[^>]+>/g, '').slice(0, 600))}</div>` : ''}`
    }
  }
  renderExtra()

  // 无封面的书用占位封面兜底
  wireCoverFallback(root)

  // 播放速度恢复
  const savedRate = parseFloat(await store.get(CONFIG_KEYS.playbackRate, '1')) || 1
  if (savedRate !== 1 && p.rate !== savedRate) { await p.setRate(savedRate); paintState() }
}

export function setSleepTimer(minutes) {
  if (sleepTimer) { clearTimeout(sleepTimer); sleepTimer = null }
  sleepAt = 0
  if (!minutes) { toast('已关闭睡眠定时'); return }
  sleepAt = Date.now() + minutes * 60000
  sleepTimer = setTimeout(() => {
    state.player?.pause()
    toast('睡眠定时到，已暂停')
    sleepTimer = null; sleepAt = 0
  }, minutes * 60000)
  toast('已设定 ' + minutes + ' 分钟后暂停')
}

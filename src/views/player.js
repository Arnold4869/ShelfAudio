/** 播放页：儿童模式=大圆按钮极简；成人模式=附加章节列表、倍速、睡眠定时、收藏 */
import { abs } from '../lib/api.js'
import { state, go, toast, esc, fmtTime, updateMini, requireParentPin } from '../app.js'
import { store, CONFIG_KEYS } from '../lib/store.js'
import { haptic } from '../lib/haptics.js'
import { fallbackCover, wireCoverFallback } from '../lib/cover.js'
import { icon } from '../lib/icons.js'

let sleepTimer = null
let sleepAt = 0
let adultTab = 'chapters'
let chaptersOpen = false   // 章节面板是否展开（儿童模式默认收起，点「选集」才展开）
// 进度条口径：'track' = 当前这一集（默认）；'book' = 整部作品。
// 之前写死了整本（ABS 的 currentTime 是全书累计秒），用户看着"进度条是整个作品的"很别扭。
let progressScope = 'track'

/** 当前进度条的取值区间：[起点(全书秒), 终点(全书秒), 显示用当前秒, 显示用总秒] */
function scopeRange() {
  const c = state.current, p = state.player
  const t = c.tracks[p.trackIndex]
  const off = t?.startOffset || 0
  const trackDur = t?.duration || 0
  if (progressScope === 'book' || !trackDur) {
    return { from: 0, to: p.duration || 0, cur: p.position().currentTime, dur: p.duration || 0 }
  }
  const cur = Math.max(0, Math.min(p.position().currentTime - off, trackDur))
  return { from: off, to: off + trackDur, cur, dur: trackDur }
}

export function getSleepRemaining() {
  if (!sleepAt) return 0
  return Math.max(0, Math.round((sleepAt - Date.now()) / 1000))
}

export async function renderPlayer(root) {
  const c = state.current
  const p = state.player
  if (!c || !p) {
    root.innerHTML = `<div class="empty"><div class="glyph">${icon('headphones', 48)}</div>还没有在播放的书<div style="margin-top:18px"><button class="btn" id="toShelf">去书架</button></div></div>`
    root.querySelector('#toShelf').onclick = () => go(state.mode === 'adult' ? 'shelf' : 'kidhome')
    return
  }

  const kid = state.mode !== 'adult'
  // 进度条口径（默认单集）
  progressScope = (await store.get(CONFIG_KEYS.progressScope, 'track')) === 'book' ? 'book' : 'track'
  const meta = c.item.media?.metadata || {}
  const chapters = c.chapters || []
  // 成人模式沿用「进来就能看到章节列表」；儿童模式收起，点 📑 选集 才展开
  chaptersOpen = !kid

  // 这本书是否已在某个收藏夹里（决定心形是实心还是空心）
  let favState = { on: false, collections: [], itemId: c.item.id }
  try {
    const cols = await abs.collections()
    favState.collections = cols || []
    favState.on = (cols || []).some(col => (col.books || []).some(b => b.id === c.item.id))
  } catch (_) { }

  const shell = () => `
    <div class="page-head">
      <button class="icon-btn" id="btnBack" aria-label="返回">${icon('back', 22)}</button>
      <div class="page-title" style="font-size:20px">${kid ? '正在听' : esc(c.title)}</div>
      <button class="icon-btn" id="btnMore" aria-label="更多">${icon('more', 22)}</button>
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
          <span id="pWhole" class="seek-whole" style="display:none"></span>
          <span id="tDur">0:00</span>
        </div>
      </div>

      <div class="player-tools fav-row">
        <button class="tool-chip ${favState.on ? 'on' : ''}" id="btnFavTop">
          ${icon('heart', 18)} <span id="favLabel">${favState.on ? '已收藏' : '收藏'}</span>
        </button>
        <button class="tool-chip" id="btnBookmark">${icon('bookmark', 18)} 加书签</button>
      </div>

      <div class="player-controls">
        <button class="ctrl side" id="btnR15" aria-label="后退15秒">${icon('back15', 30)}<span class="ctrl-num">15</span></button>
        <button class="ctrl mid" id="btnPrev" aria-label="上一集">${icon('prev', 34)}</button>
        <button class="ctrl big" id="btnPlay" aria-label="播放/暂停">${icon('play', 46)}</button>
        <button class="ctrl mid" id="btnNext" aria-label="下一集">${icon('next', 34)}</button>
        <button class="ctrl side" id="btnF15" aria-label="前进15秒">${icon('forward15', 30)}<span class="ctrl-num">15</span></button>
      </div>

      <div class="player-tools">
        ${kid
          ? `<button class="tool-chip" id="btnRate">1.0×</button>
             <button class="tool-chip" id="btnSleep">${icon('timer', 18)} 定时</button>
             <button class="tool-chip" id="btnChapters">${icon('list', 18)} 选集</button>`
          : `<button class="tool-chip" id="btnRate">1.0×</button>
             <button class="tool-chip" id="btnSleep">${icon('timer', 18)} 定时</button>
             <button class="tool-chip" id="btnChaptersA">${icon('list', 18)} 章节</button>`}
      </div>

      <div id="extra"></div>
    </div>`

  root.innerHTML = shell()

  const $ = s => root.querySelector(s)
  const seekFill = $('#seekFill'), seekBar = $('#seekBar')

  function paintProgress() {
    // 按所选口径取区间（默认单集，见 scopeRange）
    const R = scopeRange()
    const pct = R.dur ? Math.min(100, (R.cur / R.dur) * 100) : 0
    seekFill.style.width = pct + '%'
    $('#tCur').textContent = fmtTime(R.cur)
    $('#tDur').textContent = fmtTime(R.dur)
    // 单集口径下补一行「整部作品 x%」，不然用户不知道整本还剩多少
    const whole = $('#pWhole')
    if (whole) {
      if (progressScope === 'track' && p.duration) {
        whole.textContent = '整部作品 ' + Math.round((p.position().currentTime / p.duration) * 100) + '%'
        whole.style.display = ''
      } else whole.style.display = 'none'
    }
    const ch = chapters[p.trackIndex]
    $('#pChapter').textContent = ch?.title || c.tracks[p.trackIndex]?.title || `第 ${p.trackIndex + 1} / ${c.tracks.length} 集`
  }
  function paintState() {
    // 必须用 innerHTML：textContent 会把上面注入的 SVG 抹掉，播放键会变空白
    $('#btnPlay').innerHTML = icon(p.playing ? 'pause' : 'play', 46)
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

  $('#btnBack').onclick = () => { haptic.tap(); go(kid ? 'kidhome' : 'shelf') }
  $('#btnPlay').onclick = () => { haptic.tap(); p.toggle() }
  $('#btnPrev').onclick = () => { haptic.tap(); p.prevTrack() }
  $('#btnNext').onclick = () => { haptic.tap(); p.nextTrack() }
  $('#btnR15').onclick = () => { haptic.tap(); p.seek(Math.max(0, p.position().currentTime - 15)) }
  $('#btnF15').onclick = () => { haptic.tap(); p.seek(p.position().currentTime + 15) }
  $('#btnFavTop').onclick = () => { haptic.tap(); toggleFav() }
  $('#btnBookmark').onclick = () => { haptic.tap(); addBookmark() }

  // 拖动进度条
  let dragging = false
  let R2 = scopeRange()   // 拖动期间冻结区间，避免中途重算导致跳变
  const seekFromEvent = e => {
    const rect = seekBar.getBoundingClientRect()
    const x = (e.touches?.[0]?.clientX ?? e.clientX) - rect.left
    const ratio = Math.max(0, Math.min(1, x / rect.width))
    seekFill.style.width = (ratio * 100) + '%'
    $('#tCur').textContent = fmtTime(ratio * R2.dur)
    return ratio
  }
  const startDrag = e => { dragging = true; R2 = scopeRange(); seekFromEvent(e) }
  const moveDrag = e => { if (dragging) { seekFromEvent(e); e.preventDefault?.() } }
  const endDrag = e => {
    if (!dragging) return
    dragging = false
    const ratio = seekFromEvent(e.changedTouches ? { clientX: e.changedTouches[0].clientX } : e)
    // 按区间映射回全书时间：单集口径下只在本集范围内跳
    p.seek(R2.from + ratio * R2.dur)
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
    haptic.select()
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
    haptic.tap()
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
  // 右上角三个点：打开「当前这一集」的操作菜单。
  // 之前儿童模式下它直接跳设置页（还得输家长密码），语义完全不对 ——
  // 三个点在所有播放器里都是"针对当前内容的操作"。
  $('#btnMore').onclick = () => { haptic.tap(); openEpisodeMenu() }

  /** 当前集的操作菜单（收藏 / 书签 / 选集 / 倍速 / 定时 / 书籍信息） */
  function openEpisodeMenu() {
    const ch = chapters[p.trackIndex]
    const t = c.tracks[p.trackIndex]
    const curCh = ch?.title || t?.title || `第 ${p.trackIndex + 1} 集`
    const modal = document.createElement('div')
    modal.className = 'lock'
    modal.innerHTML = `<div class="lock-card">
      <div class="lock-title">${esc(curCh)}</div>
      <div class="lock-sub">第 ${p.trackIndex + 1} / ${c.tracks.length} 集${t?.duration ? ' · ' + fmtTime(t.duration) : ''}</div>
      <button class="sheet-item" data-act="fav">
        <span class="sheet-ic">${icon('heart', 20)}</span>
        <span class="sheet-label">${favState.on ? '取消收藏' : '收藏这本书'}</span>
      </button>
      <button class="sheet-item" data-act="bookmark">
        <span class="sheet-ic">${icon('bookmark', 20)}</span>
        <span class="sheet-label">在当前位置加书签</span>
      </button>
      <button class="sheet-item" data-act="chapters">
        <span class="sheet-ic">${icon('list', 20)}</span>
        <span class="sheet-label">选集</span>
      </button>
      <button class="sheet-item" data-act="rate">
        <span class="sheet-ic">${icon('play', 20)}</span>
        <span class="sheet-label">播放速度（当前 ${(p.rate || 1)}×）</span>
      </button>
      <button class="sheet-item" data-act="sleep">
        <span class="sheet-ic">${icon('timer', 20)}</span>
        <span class="sheet-label">睡眠定时</span>
      </button>
      <button class="sheet-item" data-act="info">
        <span class="sheet-ic">${icon('info', 20)}</span>
        <span class="sheet-label">书籍信息</span>
      </button>
    </div>`
    document.body.appendChild(modal)
    modal.addEventListener('click', async e => {
      const b = e.target.closest('[data-act]')
      if (!b) { if (e.target === modal) modal.remove(); return }
      const act = b.dataset.act
      haptic.select()
      modal.remove()
      if (act === 'fav') await toggleFav()
      else if (act === 'bookmark') await addBookmark()
      else if (act === 'chapters') { chaptersOpen = true; adultTab = 'chapters'; renderExtra(); $('#extra')?.scrollIntoView({ behavior: 'smooth', block: 'start' }) }
      else if (act === 'rate') $('#btnRate').click()
      else if (act === 'sleep') $('#btnSleep').click()
      else if (act === 'info') { adultTab = 'info'; chaptersOpen = true; renderExtra(); $('#extra')?.scrollIntoView({ behavior: 'smooth', block: 'start' }) }
    })
  }

  /** 收藏 / 取消收藏（切换状态，心形跟着变） */
  async function toggleFav() {
    try {
      let cols = favState.collections
      if (!cols.length) {
        cols = await abs.collections()
        favState.collections = cols
      }
      let col = cols.find(x => (x.books || []).some(b => b.id === c.item.id))
      if (!col) col = cols[0]
      if (!col) { toast('ABS 里还没有收藏夹，先去服务器建一个'); return }
      if (favState.on) {
        await abs.removeFromCollection(col.id, c.item.id)
        favState.on = false
        haptic.success()
        toast('已取消收藏')
      } else {
        await abs.addToCollection(col.id, c.item.id)
        favState.on = true
        haptic.success()
        toast('已收藏到「' + col.name + '」')
      }
      paintFav()
    } catch (e) { haptic.error(); toast('收藏失败：' + e.message) }
  }

  function paintFav() {
    const b = $('#btnFavTop')
    if (!b) return
    b.classList.toggle('on', favState.on)
    $('#favLabel').textContent = favState.on ? '已收藏' : '收藏'
  }

  /** 在当前位置加书签（ABS 原生书签，跟 App 内其它客户端同步） */
  async function addBookmark() {
    try {
      const at = Math.floor(p.position().currentTime)
      const ch = chapters[p.trackIndex]
      await abs.post(`/api/me/item/${c.item.id}/bookmark`, {
        time: at,
        title: (ch?.title ? ch.title + ' ' : '') + fmtTime(at),
      })
      haptic.success()
      toast('已加书签 ' + fmtTime(at))
    } catch (e) { haptic.error(); toast('加书签失败：' + e.message) }
  }
  if ($('#btnChapters')) {
    // 同样必须用 innerHTML，否则图标被抹掉
    const paintChapterBtn = () => {
      $('#btnChapters').innerHTML = icon('list', 18) + (chaptersOpen ? ' 收起' : ' 选集')
    }
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
  // 成人模式的「章节」按钮（原来这里是 btnInfo / btnFav，已合并进收藏行与三个点菜单）
  if ($('#btnChaptersA')) {
    $('#btnChaptersA').onclick = () => { haptic.tap(); adultTab = 'chapters'; chaptersOpen = true; renderExtra(); $('#extra')?.scrollIntoView({ behavior: 'smooth', block: 'start' }) }
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
          haptic.select()
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

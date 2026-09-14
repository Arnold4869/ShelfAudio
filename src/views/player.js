/** 播放页：大圆按钮极简 + 收藏；ND 去掉倍速/选集/±15秒（老板 2026-09-14），内容操作收进右上角三个点 */
import { hub as abs, sourceOfId } from '../lib/servers.js'
import { goBack, state, go, toast, esc, fmtTime, updateMini } from '../app.js'
import { store, CONFIG_KEYS } from '../lib/store.js'
import { haptic } from '../lib/haptics.js'
import { isCached, downloadBook, removeBook } from '../lib/offline.js'
import { hasLocal, addLocal, removeLocal } from '../lib/favs.js'
import { fallbackCover, wireCoverFallback } from '../lib/cover.js'
import { icon } from '../lib/icons.js'
import { t } from '../lib/terms.js'
import { openLyricsPage } from '../lib/lyrics-ui.js'

let sleepTimer = null
let sleepAt = 0
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
    root.innerHTML = `<div class="empty"><div class="glyph">${icon('headphones', 48)}</div>${t('notPlaying')}<div style="margin-top:18px"><button class="btn" id="toShelf">${t('goShelf')}</button></div></div>`
    root.querySelector('#toShelf').onclick = () => go('kidhome')
    return
  }

  // 只有一种模式了（原来分儿童/成人两套界面，老板要求取消分类）。
  // 保留 kid 变量只是为了让下面已有的分支保持可读，值恒为 true。
  const kid = true
  // 进度条口径（默认单集）
  progressScope = (await store.get(CONFIG_KEYS.progressScope, 'track')) === 'book' ? 'book' : 'track'
  const meta = c.item.media?.metadata || {}
  const chapters = c.chapters || []

  // 收藏/缓存状态：**不在渲染前 await**！
  // 之前这里串行等 collections()（网络请求）+ hasLocal + isCached 才画页面，
  // 外网反代下一个来回几百毫秒到几秒，播放页就"卡一下才出来"。
  // 现在页面先渲染，这三个状态查完再补（paintFav / 菜单文案是动态的，不依赖时序）。
  const isNdItem = sourceOfId(c.item.id) === 'nd'
  let favState = { on: false, local: false, collections: [], itemId: c.item.id }
  let cachedNow = false
  Promise.all([
    // ND 的收藏是 star（无收藏夹），ABS 走 collections
    (isNdItem
      ? abs.isStarred(c.item.id).then(yes => { if (yes) favState.on = true })
      : abs.collections().then(cols => {
          favState.collections = cols || []
          if ((cols || []).some(col => (col.books || []).some(b => b.id === c.item.id))) favState.on = true
        })
    ).catch(() => {}),
    hasLocal(c.item.id).then(yes => {
      if (yes && !favState.on) { favState.on = true; favState.local = true }
    }).catch(() => {}),
    isCached(c.item.id, c.tracks?.length).then(yes => { cachedNow = !!yes }).catch(() => {}),
  ]).then(() => { try { paintFav() } catch (_) { } })

  const shell = () => `
    <div class="page-head">
      <button class="icon-btn" id="btnBack" aria-label="返回">${icon('back', 22)}</button>
      <div class="page-title" style="font-size:20px">正在听</div>
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
      </div>

      <div class="player-controls">
        ${isNdItem
          /* ND（音乐库，老板 2026-09-14 反馈）：中间两个换成「播放模式 / 歌词」，
             去掉 ±15 秒；倍速、选集也都不要了（改回专辑页选单曲）。 */
          ? `<button class="ctrl side" id="btnMode" aria-label="播放模式">${icon('repeat-order', 26)}</button>
             <button class="ctrl mid" id="btnPrev" aria-label="上一首">${icon('prev', 34)}</button>
             <button class="ctrl big" id="btnPlay" aria-label="播放/暂停">${icon('play', 46)}</button>
             <button class="ctrl mid" id="btnNext" aria-label="下一首">${icon('next', 34)}</button>
             <button class="ctrl side" id="btnLyrics" aria-label="歌词">${icon('lyrics', 26)}</button>`
          /* ABS（有声书）：保持原样 —— 书是多章节，选集和倍速都是必需的（老板：ABS 先不动） */
          : `<button class="ctrl side" id="btnR15" aria-label="后退15秒">${icon('back15', 30)}<span class="ctrl-num">15</span></button>
             <button class="ctrl mid" id="btnPrev" aria-label="上一集">${icon('prev', 34)}</button>
             <button class="ctrl big" id="btnPlay" aria-label="播放/暂停">${icon('play', 46)}</button>
             <button class="ctrl mid" id="btnNext" aria-label="下一集">${icon('next', 34)}</button>
             <button class="ctrl side" id="btnF15" aria-label="前进15秒">${icon('forward15', 30)}<span class="ctrl-num">15</span></button>`}
      </div>

      <div class="player-tools">
        ${isNdItem
          /* ND：倍速/选集/定时 都不在页面上（定时已收进右上角 ⋯ 菜单，老板 2026-09-14）。
             整行留空即可 —— 不渲染空行会更好看，所以直接不要这一行。 */
          ? ''
          : `<button class="tool-chip" id="btnRate">1.0×</button>
             <button class="tool-chip" id="btnSleep">${icon('timer', 18)} 定时</button>
             <button class="tool-chip" id="btnChapters">${icon('list', 18)} 选集</button>`}
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
    // 缓冲中显示 loader（自带 .spin 旋转），比"暂停图标"诚实 —— 不然用户
    // 以为"点了没反应"再点一次（小米 8SE 冷启动缓冲要几秒）。
    $('#btnPlay').innerHTML = p.buffering ? icon('loader', 46, 'spin') : icon(p.playing ? 'pause' : 'play', 46)
    // ND 下没有倍速按钮（老板 2026-09-14 去掉）→ 判空，别对 null 赋值
    const rateBtn = $('#btnRate')
    if (rateBtn) rateBtn.textContent = (p.rate || 1).toFixed(1).replace(/\.0$/, '.0') + '×'
  }

  paintProgress(); paintState()

  // ---- 事件 ----
  // 性能（2026-09-13 审计）：sa:time 每秒触发一次。播放页里迷你条本来就是隐藏的，
// updateMini 每秒跑一遍（读 DOM、改 class、算 dock 高度）纯属白做 —— 去掉。
// 迷你条的状态在 onState（播放/暂停切换，低频）时更新就够。
const onTime = () => { if (document.body.dataset.view === 'player') paintProgress() }
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

  $('#btnBack').onclick = () => { haptic.tap(); goBack('kidhome') }
  $('#btnPlay').onclick = () => { haptic.tap(); p.toggle() }
  $('#btnPrev').onclick = () => { haptic.tap(); p.prevTrack() }
  $('#btnNext').onclick = () => { haptic.tap(); p.nextTrack() }
  $('#btnFavTop').onclick = () => { haptic.tap(); toggleFav() }
  //  不要再引用已从模板里删掉的元素：$('#x') 返回 null，给 null 赋 onclick 会抛
  // TypeError，**把它之后的所有初始化全部中断**（三个点菜单就是这么失效的）。
  // （倍速/选集/±15 秒已按老板 2026-09-14 要求移除；定时收进右上角三个点。）

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

  // ---- 播放模式（老板 2026-09-14：单曲循环 / 顺序播放 / 乱序播放）----
  // 只在 ND（音乐库）下暴露 —— ABS 是有声书，老板明确「ABS 先不动」。
  // 三态轮转：顺序 → 单曲循环 → 乱序 → 顺序，模式记忆在本机（换书走同一套）。
  const MODES = [
    { key: 'order', icon: 'repeat-order', label: '顺序播放' },
    { key: 'repeat', icon: 'repeat-one', label: '单曲循环' },
    { key: 'shuffle', icon: 'shuffle', label: '乱序播放' },
  ]
  const btnMode = $('#btnMode')
  if (btnMode) {
    const savedMode = await store.get(CONFIG_KEYS.playMode, 'order')
    p.setPlayMode(savedMode)
    const paintMode = () => {
      const m = MODES.find(x => x.key === p.playMode) || MODES[0]
      // 必须 innerHTML：textContent 会把注入的 SVG 抹掉
      btnMode.innerHTML = icon(m.icon, 26)
      btnMode.classList.toggle('on', p.playMode !== 'order')
      btnMode.setAttribute('aria-label', m.label)
    }
    paintMode()
    btnMode.onclick = async () => {
      haptic.select()
      const i = MODES.findIndex(x => x.key === p.playMode)
      const next = MODES[(i + 1) % MODES.length]
      p.setPlayMode(next.key)
      paintMode()
      await store.set(CONFIG_KEYS.playMode, next.key)
      toast(next.label)
    }
  }

  // ---- 歌词（老板 2026-09-14：点封面切到歌词页，随歌声滚动）----
  // 仅 ND 有歌词数据（ABS 无歌词接口）。点封面或底部歌词按钮都能进。
  const btnLyrics = $('#btnLyrics')
  if (isNdItem) {
    const openLyr = () => { haptic.tap(); openLyricsPage() }
    if (btnLyrics) btnLyrics.onclick = openLyr
    const wrap = root.querySelector('.player-cover-wrap')
    if (wrap) {
      wrap.classList.add('tappable')
      wrap.onclick = openLyr
    }
  } else if (btnLyrics) {
    // ABS：没有歌词数据，按钮隐身（不占位、不误导）
    btnLyrics.style.display = 'none'
  }

  // ---- 睡眠定时（已收进右上角 ⋯ 菜单；老板 2026-09-14）----
  function openSleepDialog() {
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

  // ---- 右上角三个点：当前内容的操作菜单 ----
  // 三个点在所有播放器里都是"针对当前内容的操作"。
  $('#btnMore').onclick = () => { haptic.tap(); openEpisodeMenu() }

  /** 当前集的操作菜单。现有项：缓存 / 定时（老板 2026-09-14 移入）/ 歌单 / 信息 */
  function openEpisodeMenu() {
    const ch = chapters[p.trackIndex]
    const t = c.tracks[p.trackIndex]
    const curCh = ch?.title || t?.title || `第 ${p.trackIndex + 1} 集`
    // ND（音乐库）用「首」，ABS 有声书用「集」——术语别写死
    const unitWord = isNdItem ? '首' : '集'
    const modal = document.createElement('div')
    modal.className = 'lock'
    modal.innerHTML = `<div class="lock-card">
      <div class="lock-title">${esc(curCh)}</div>
      <div class="lock-sub">第 ${p.trackIndex + 1} / ${c.tracks.length} ${unitWord}${t?.duration ? ' · ' + fmtTime(t.duration) : ''}</div>
      ${isNdItem ? `<button class="sheet-item" data-act="playlist">
        <span class="sheet-ic">${icon('playlist', 20)}</span>
        <span class="sheet-label">添加到歌单</span>
      </button>` : ''}
      <button class="sheet-item" data-act="sleep">
        <span class="sheet-ic">${icon('timer', 20)}</span>
        <span class="sheet-label">睡眠定时${getSleepRemaining() ? '（剩余 ' + Math.ceil(getSleepRemaining() / 60) + ' 分钟）' : ''}</span>
      </button>
      <button class="sheet-item" data-act="download">
        <span class="sheet-ic">${icon('download', 20)}</span>
        <span class="sheet-label">${cachedNow ? '已缓存（点击删除）' : '缓存到本机（离线听）'}</span>
      </button>
      <button class="sheet-item" data-act="info">
        <span class="sheet-ic">${icon('info', 20)}</span>
        <span class="sheet-label">${isNdItem ? '专辑信息' : '书籍信息'}</span>
      </button>
    </div>`
    document.body.appendChild(modal)
    modal.addEventListener('click', async e => {
      const b = e.target.closest('[data-act]')
      if (!b) { if (e.target === modal) modal.remove(); return }
      const act = b.dataset.act
      haptic.select()
      modal.remove()
      if (act === 'download') await toggleDownload()
      else if (act === 'sleep') openSleepDialog()
      else if (act === 'playlist') await addCurrentToPlaylist()
      else if (act === 'info') openInfoSheet()
    })
  }

  /** 把「当前正在听的这首歌」加进歌单（老板 2026-09-14） */
  async function addCurrentToPlaylist() {
    const tr = c.tracks[p.trackIndex]
    const songId = tr?._nd?.songId || String(tr?.contentUrl || '').match(/[?&]id=([^&]+)/)?.[1]
    if (!songId) { haptic.error(); toast('拿不到这首歌的信息'); return }
    const { openAddToPlaylist } = await import('../lib/playlist-ui.js')
    await openAddToPlaylist([{ id: 'nd:' + songId, title: tr?.title || '这首歌' }])
  }

  /** 书籍信息弹窗（原来塞在播放页底部的 renderExtra，改独立窗口） */
  function openInfoSheet() {
    const m = c.item.media || {}
    const md = m.metadata || {}
    const modal = document.createElement('div')
    modal.className = 'lock'
    modal.innerHTML = `<div class="lock-card">
      <div class="lock-title">书籍信息</div>
      <div style="line-height:1.9;font-size:14px;text-align:left">
        <div><span style="color:var(--text-dim)">书名：</span>${esc(md.title || '')}</div>
        <div><span style="color:var(--text-dim)">作者：</span>${esc(md.authorName || '未知')}</div>
        <div><span style="color:var(--text-dim)">演播：</span>${esc(md.narratorName || '未知')}</div>
        <div><span style="color:var(--text-dim)">时长：</span>${fmtTime(c.duration)}</div>
        <div><span style="color:var(--text-dim)">集数：</span>${c.tracks.length}</div>
        <div><span style="color:var(--text-dim)">倍速：</span>${(p.rate || 1)}×</div>
      </div>
      ${md.description ? `<div style="font-size:13px;line-height:1.8;color:var(--text-dim);text-align:left;max-height:180px;overflow:auto">${esc(String(md.description).replace(/<[^>]+>/g, '').slice(0, 600))}</div>` : ''}
      <div class="lock-actions"><button class="btn ghost" id="infoClose">关闭</button></div>
    </div>`
    document.body.appendChild(modal)
    modal.querySelector('#infoClose').onclick = () => modal.remove()
    modal.addEventListener('click', e => { if (e.target === modal) modal.remove() })
  }

  /**
   * 收藏 / 取消收藏（切换状态，心形跟着变）。
   *
   * 写的顺序很关键：ABS 改收藏夹要 **update 权限**，账号没这权限会返回 403
   * （实测用户账号就是这种，纯 "Forbidden"）。所以：
   *   能写服务器 → 写服务器（换设备也在，与其它 ABS 客户端共享）
   *   被拒(403)  → 退到本机收藏，功能照用，并明确告诉用户"只在这台手机"
   * 不静默失败、也不假装同步成功。
   */
  async function toggleFav() {
    try {
      // ---- ND（2026-09-14）：star/unstar，album 级，没有收藏夹概念 ----
      if (sourceOfId(c.item.id) === 'nd') {
        const starred = await abs.isStarred(c.item.id)
        if (starred) {
          await abs.removeFromCollection('nd:starred', c.item.id)
          favState.on = false
          haptic.success()
          toast('已取消收藏')
          paintFav()
        } else {
          await abs.addToCollection('nd:starred', c.item.id)
          favState.on = true
          haptic.success()
          toast('已收藏')
          paintFav()
        }
        return
      }

      // ---- ABS：收藏夹链路（原逻辑）----
      let cols = favState.collections
      if (!cols.length) {
        cols = await abs.collections()
        favState.collections = cols
      }
      let col = cols.find(x => (x.books || []).some(b => b.id === c.item.id)) || cols[0]

      // ---- 取消收藏 ----
      if (favState.on) {
        if (favState.local) {
          await removeLocal(c.item.id)
        } else if (col) {
          await abs.removeFromCollection(col.id, c.item.id)
        }
        favState.on = false
        favState.local = false
        haptic.success()
        toast('已取消收藏')
        paintFav()
        return
      }

      // ---- 添加收藏 ----
      if (!col) {
        // 服务器一个收藏夹都没有 → 试着建一个（ABS 建收藏夹同样需要 update 权限，
        // 没权限会 403，那就落本机兜底）。
        // libraryId 必须是这本书所在的库，不能省 —— ABS 会按它校验归属。
        try {
          const libId = c.item.libraryId || state.libraryId
          if (libId) {
            await abs.post('/api/collections', { name: '我的收藏', libraryId: libId })
            cols = await abs.collections()
            favState.collections = cols
            col = cols?.[0]
          }
        } catch (_) { }
      }

      if (col) {
        try {
          await abs.addToCollection(col.id, c.item.id)
          favState.on = true
          favState.local = false
          haptic.success()
          toast('已收藏到「' + col.name + '」')
          paintFav()
          return
        } catch (e) {
          // 403 等 → 落本机兜底，不要弹"失败"了事
          if (!/403|修改/.test(e.message)) throw e
        }
      }

      await addLocal({ id: c.item.id, title: c.title, author: c.author, duration: c.duration })
      favState.on = true
      favState.local = true
      haptic.success()
      toast('已收藏')
      paintFav()
    } catch (e) { haptic.error(); toast('收藏失败：' + e.message) }
  }

  function paintFav() {
    const b = $('#btnFavTop')
    if (!b) return
    b.classList.toggle('on', favState.on)
    // 本机收藏要让用户能看出来（否则他会以为换设备也在）
    $('#favLabel').textContent = favState.local ? '已收藏·本机' : (favState.on ? '已收藏' : '收藏')
  }

  /**
   * 缓存这本书到本机 / 删除缓存。
   * 老板要求：缓存的操作入口放这里（三个点菜单里），不占播放页的按钮位。
   */
  async function toggleDownload() {
    // 已缓存 → 删除
    if (cachedNow) {
      const modal = document.createElement('div')
      modal.className = 'lock'
      modal.innerHTML = `<div class="lock-card">
        <div class="lock-title">删除缓存？</div>
        <div class="lock-sub">「${esc(c.title)}」的音频会从手机里删掉，之后要联网才能听。</div>
        <div class="lock-actions">
          <button class="btn ghost" id="dcCancel">取消</button>
          <button class="btn danger" id="dcOk">删除</button>
        </div>
      </div>`
      document.body.appendChild(modal)
      modal.querySelector('#dcCancel').onclick = () => modal.remove()
      modal.querySelector('#dcOk').onclick = async () => {
        modal.remove()
        try {
          await removeBook(c.item.id)
          cachedNow = false
          haptic.success()
          toast('已删除缓存')
        } catch (e) { haptic.error(); toast('删除失败：' + e.message) }
      }
      return
    }

    // 未缓存 → 下载，带进度
    const modal = document.createElement('div')
    modal.className = 'lock'
    modal.innerHTML = `<div class="lock-card">
      <div class="lock-title">缓存中</div>
      <div class="lock-sub">${esc(c.title)}</div>
      <div class="dl-bar"><i id="dlFill" style="width:0%"></i></div>
      <div class="dl-pct" id="dlPct">0%</div>
      <div class="lock-actions"><button class="btn ghost" id="dlClose">后台继续</button></div>
    </div>`
    document.body.appendChild(modal)
    let closed = false
    modal.querySelector('#dlClose').onclick = () => { closed = true; modal.remove() }

    try {
      // 音轨要从详情接口按 ino 拼直链 ——
      // /play 给的是 HLS 播放列表（/hls/xxx/output.m3u8），下它拿不到音频。
      // ND（2026-09-14）：详情里 audioFiles[].ino = songId，直链是 /rest/stream?id=<songId>。
      const detail = await abs.getItem(c.item.id)
      const files = detail?.media?.audioFiles || []
      const ndCh = detail?.media?.chapters || []
      const isNd = sourceOfId(c.item.id) === 'nd'
      const tracks = files.map((af, i) => ({
        index: i + 1,
        title: (c.chapters?.[i]?.title) || ndCh[i]?.title || `第${i + 1}集`,
        contentUrl: isNd
          ? `/rest/stream?id=${encodeURIComponent(af.ino)}`
          : `/api/items/${c.item.id}/file/${af.ino}`,
        duration: af.duration || ndCh[i]?.duration || 0,
      }))
      if (!tracks.length) { modal.remove(); haptic.error(); toast(t('noAudio')); return }

      const res = await downloadBook(
        { id: c.item.id, title: c.title, tracks },
        ({ pct, label }) => {
          if (closed) return
          const f = modal.querySelector('#dlFill')
          if (f) f.style.width = pct + '%'
          const t = modal.querySelector('#dlPct')
          if (t) t.textContent = pct + '% · ' + String(label || '').slice(0, 14)
        }
      )
      cachedNow = res.fail === 0
      modal.remove()
      if (res.fail) { haptic.warn(); toast(`缓存完成：${res.ok} 集成功，${res.fail} 集失败`) }
      else { haptic.success(); toast('已缓存 ' + res.ok + ' 集') }
    } catch (e) {
      modal.remove()
      haptic.error()
      toast('缓存失败：' + (e.message || e))
    }
  }
  if ($('#btnChapters')) {
    // 点「选集」= 弹出独立窗口选（老板 2026-09-13 要求），不再在播放页往下拉列表。
    // 理由：下划列表会把播放页撑长、控件被挤出屏幕，选完还得滚回来。
    $('#btnChapters').onclick = () => { haptic.tap(); openChapterSheet() }
  }

  /** 选集弹窗：整屏浮层 + 可滚动列表，当前集高亮并自动滚到可见处 */
  function openChapterSheet() {
    const modal = document.createElement('div')
    modal.className = 'lock sheet-full'
    modal.innerHTML = `<div class="sheet-card">
      <div class="sheet-head">
        <div class="sheet-title">选集 <span class="sheet-count">共 ${chapters.length} 集</span></div>
        <button class="icon-btn" id="chClose" aria-label="关闭">${icon('back', 20)}</button>
      </div>
      <div class="sheet-body"><div id="chList"></div></div>
    </div>`
    document.body.appendChild(modal)

    //  chList（内容层）必须独立于 .sheet-body（滚动层）：
    // 虚拟渲染要在一个「总高 536×行高」的内容容器里绝对定位行，
    // 滚动监听/scrollTop 都属于外面的滚动层。合并成一层会导致
    // list.parentElement 变成不滚动的 .sheet-card，滚动补画永不触发。
    const list = modal.querySelector('#chList')

    // 性能（2026-09-13 审计）：536 集一次性渲染 = 2149 个 DOM 节点 + 28ms 布局
    //（桌面 Chrome 实测；小米 8SE 的老 WebView 会放大 3~5 倍，弹窗打开明显顿）。
    // 改成按需渲染：只画可视区附近 ±PAGE 条，滚动时增量补画。行高固定（CSS 已定），
    // 用一个总高容器 + 绝对定位窗口，滚动条长度始终正确。
    // kid 模式（App 只有 kid）行高 76px，与 CSS .sheet-body .chapter-item 的 height 一致
    const ROW_H = 76
    const PAGE = 30                       // 一次补画 30 条（约一屏半）
    let paintedFrom = -1, paintedTo = -1  // 当前已画的 [from, to) 区间
    const chItem = (i) => {
      const ch = chapters[i]
      return `<div class="chapter-item ${i === p.trackIndex ? 'active' : ''}" data-ch="${i}"
                style="position:absolute;top:${i * ROW_H}px;left:0;right:0">
          <div class="chapter-idx">${i + 1}</div>
          <div class="chapter-title">${esc(ch.title || '第 ' + (i + 1) + ' 集')}</div>
          <div class="chapter-dur">${fmtTime((ch.end || 0) - (ch.start || 0))}</div>
        </div>`
    }
    const paint = (from, to) => {
      // 需要覆盖的范围（clamp + 多画一页余量）
      from = Math.max(0, from - PAGE)
      to = Math.min(chapters.length, to + PAGE)
      if (from === paintedFrom && to === paintedTo) return
      // 在已画区间内就只画缺的部分，不清重来（避免滚动闪烁）
      if (paintedFrom >= 0 && from >= paintedFrom && to <= paintedTo + PAGE * 2) {
        if (from < paintedFrom) list.insertAdjacentHTML('afterbegin',
          chapters.slice(from, paintedFrom).map((_, i) => chItem(from + i)).join(''))
        if (to > paintedTo) list.insertAdjacentHTML('beforeend',
          chapters.slice(paintedTo, to).map((_, i) => chItem(paintedTo + i)).join(''))
      } else {
        list.innerHTML = chapters.slice(from, to).map((_, i) => chItem(from + i)).join('')
      }
      paintedFrom = from; paintedTo = to
    }
    // 总高容器：滚动条长度与完整 536 集一致
    list.style.position = 'relative'
    list.style.height = chapters.length * ROW_H + 'px'

    const visible = () => {
      const st = list.parentElement.scrollTop   // sheet-body 才是滚动容器
      const h = list.parentElement.clientHeight
      const from = Math.max(0, Math.floor(st / ROW_H) - 2)
      const to = Math.min(chapters.length, Math.ceil((st + h) / ROW_H) + 2)
      paint(from, to)
    }
    // 滚动容器是 .sheet-body（list 的父级）。scroll 事件不冒泡到 window，
    // 必须直接绑在容器上；rAF 合帧避免 536 集快速滑动时 paint 风暴。
    list.parentElement.addEventListener('scroll', () => requestAnimationFrame(visible), { passive: true })

    // 首画：定位到当前集附近（打开弹窗就看到当前集，且首画只有 ~60 条）
    const cur = Math.max(0, p.trackIndex)
    const firstFrom = Math.max(0, cur - PAGE)
    const firstTo = Math.min(chapters.length, firstFrom + PAGE * 2)
    paint(firstFrom, firstTo)
    // 打开时把当前集滚到可视区中间（536 集的书，否则要自己翻很久）
    requestAnimationFrame(() => {
      try {
        list.parentElement.scrollTop = Math.max(0, cur * ROW_H - list.parentElement.clientHeight / 2)
        visible()
      } catch (_) {}
    })

    const close = () => modal.remove()
    modal.querySelector('#chClose').onclick = () => { haptic.tap(); close() }
    // 点遮罩关闭
    modal.addEventListener('click', e => { if (e.target === modal) close() })

    // 事件委托：列表长，逐条绑 onclick 会建 536 个闭包；绑在容器上一个就够
    list.addEventListener('click', async e => {
      const el = e.target.closest('[data-ch]')
      if (!el) return
      haptic.select()
      const i = parseInt(el.dataset.ch, 10)
      close()
      // autoPlay：选集是"我要听这一集"的明确意图，暂停态点也要响
      //（老板 2026-09-13：点选一集后不自动播放）。换集时播放器内部会先停旧音轨。
      await p.seek(chapters[i].start || 0, { autoPlay: true })
    })
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

  // 章节列表与书籍信息都是独立弹窗（老板 2026-09-13），
  // 播放页底部不再内联任何长列表 —— 之前会把控件挤出屏幕、选完还要滚回来。
  function renderExtra() {
    const box = $('#extra')
    if (box) box.innerHTML = ''
  }

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

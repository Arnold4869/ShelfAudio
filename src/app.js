/**
 * ShelfAudio 主程序：路由 + 模式切换 + 各视图渲染
 *
 * 界面只有一套（2026-09-12 老板要求取消儿童/成人模式分类）：
 *   大卡片书架 + 语音搜索 + 极简大字播放页；家长相关的操控项收在「家长设置」里（要密码）。
 */
import { abs } from './lib/api.js'
import { store, CONFIG_KEYS } from './lib/store.js'
import { icon } from './lib/icons.js'
import { fallbackCover } from './lib/cover.js'
import { BookPlayer } from './lib/player.js'
import { renderShelf } from './views/shelf.js'
import { renderPlayer } from './views/player.js'
import { renderSearch } from './views/search.js'
import { renderSettings } from './views/settings.js'
import { renderAbout } from './views/about.js'
import { openVoiceOverlay } from './lib/voice-ui.js'
import { startListening, stopListening } from './lib/stats.js'
import { localTrackMap } from './lib/offline.js'
import { initHaptics } from './lib/haptics.js'
import { syncToServer } from './lib/favs.js'

window.__abs = abs   // player.js 需要

// ---------------- 全局状态 ----------------
export const state = {
  mode: 'kid',
  libraries: [],
  libraryId: null,
  player: null,
  current: null,      // { item, tracks, sessionId, title, cover, duration }
  items: [],
  kidPin: '',
}

// ---------------- 工具 ----------------
export function $(sel) { return document.querySelector(sel) }
export function h(html) { const t = document.createElement('template'); t.innerHTML = html.trim(); return t.content.firstElementChild }
export function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])) }

export function fmtTime(sec) {
  sec = Math.max(0, Math.floor(sec || 0))
  const hh = Math.floor(sec / 3600), mm = Math.floor((sec % 3600) / 60), ss = sec % 60
  const p = n => String(n).padStart(2, '0')
  return hh > 0 ? `${hh}:${p(mm)}:${p(ss)}` : `${mm}:${p(ss)}`
}

export function fmtDur(sec) {
  // 先整体四舍五入到分钟再拆分，否则 7199s 会算成「1 小时 60 分」（分钟进位没同步到小时）
  const s = Math.max(0, Math.round(sec || 0))
  if (s < 60) return `${s} 秒`            // 避免出现「0 分钟」
  const totalMin = Math.round(s / 60)
  const hh = Math.floor(totalMin / 60)
  const mm = totalMin % 60
  if (hh > 0) return `${hh} 小时 ${mm} 分`
  return `${mm} 分钟`
}

let toastTimer = null
export function toast(msg, ms = 2200) {
  const el = $('#toast')
  el.textContent = msg
  el.classList.remove('hidden')
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => el.classList.add('hidden'), ms)
}

// ---------------- 路由 ----------------
const routes = {}
export function route(name, fn) { routes[name] = fn }

let currentCleanup = null

export async function go(name, params = {}) {
  const fn = routes[name]
  if (!fn) { console.warn('no route', name); return }

  // 卸载上一个视图的监听，否则每次进播放页都会累加 window 事件监听
  if (typeof currentCleanup === 'function') {
    try { currentCleanup() } catch (_) {}
    currentCleanup = null
  }
  // 离开页面时关掉语音浮层，避免它挂着麦克风
  document.querySelectorAll('.voice-overlay').forEach(e => e.remove())
  try {
    const { forceStopCurrent } = await import('./lib/voice.js')
    await forceStopCurrent()
  } catch (_) {}

  // 旧底栏**先留在 dock 上**，等新页面 render 完用新底栏原地替换 ——
  // 之前是先删掉旧的，新底栏要等 render（可能含网络 await）完才出现，
  // 期间 dock 空一下，切页签时底栏「闪一下」（老板 2026-09-12 报告）。
  const root = $('#view')
  root.innerHTML = ''
  await fn(root, params)
  currentCleanup = typeof root._cleanup === 'function' ? root._cleanup : null
  // 把底栏从 #view 移进底部 dock 容器（和迷你条同一个表面 → 视觉上连成一整块）。
  // 在这一个地方处理，各视图只管往 root 里插 .kid-tabs 即可。
  const tabsEl = root.querySelector('.kid-tabs')
  const dock = $('#dock')
  if (tabsEl && dock) {
    document.querySelectorAll('.kid-tabs').forEach(e => e.remove())
    dock.appendChild(tabsEl)
  }
  document.body.dataset.tabs = tabsEl ? '1' : '0'
  updateMini()
  syncDockHeight()
}

/** 把 dock 的真实高度写进 --dock-h，供内容底部留白与 FAB 定位使用。
 *  之前是手写 calc(--safe-bottom + --mini-h + --tabs-h + ...)，常量一改就错位、
 *  差 1px 就露缝；手动调用又容易漏（迷你条显隐、安全区变化都会改高度）。
 *  所以用 ResizeObserver 盯着它，高度一变就更新，永远准确。 */
function syncDockHeight() {
  const dock = $('#dock')
  if (!dock) return
  const h = dock.getBoundingClientRect().height
  document.documentElement.style.setProperty('--dock-h', h + 'px')
}

function watchDock() {
  const dock = $('#dock')
  if (!dock || dock._saWatched) return
  dock._saWatched = true
  if (typeof ResizeObserver !== 'undefined') {
    new ResizeObserver(syncDockHeight).observe(dock)
  }
  syncDockHeight()
}

// ---------------- 家长锁 ----------------
export function requireParentPin() {
  return new Promise(resolve => {
    if (!state.kidPin) { resolve(true); return }   // 没设密码则不拦
    const lock = $('#lock'), input = $('#lockPin'), err = $('#lockErr')
    input.value = ''
    err.textContent = ''
    lock.classList.remove('hidden')
    setTimeout(() => input.focus(), 80)

    const cleanup = () => {
      lock.classList.add('hidden')
      $('#lockOk').onclick = null; $('#lockCancel').onclick = null
      input.onkeydown = null
    }
    const ok = () => {
      if (input.value === state.kidPin) { cleanup(); resolve(true) }
      else { err.textContent = '密码不对，再试一次'; input.value = ''; input.focus() }
    }
    $('#lockOk').onclick = ok
    $('#lockCancel').onclick = () => { cleanup(); resolve(false) }
    input.onkeydown = e => { if (e.key === 'Enter') ok() }
  })
}

// ---------------- 播放器装配 ----------------
export function initPlayer() {
  if (state.player) return state.player
  const p = new BookPlayer({
    onTime: ({ currentTime, duration, trackIndex }) => {
      window.dispatchEvent(new CustomEvent('sa:time', { detail: { currentTime, duration, trackIndex } }))
    },
    onState: (s) => {
      window.dispatchEvent(new CustomEvent('sa:state', { detail: s }))
      updateMini()
      // 收听时长统计：只在"真的在播"时计时，暂停立刻结算
      // （统计的是听了多久，不是开着 App 多久）
      if (s?.isPlaying) {
        const c = state.current
        if (c) startListening(c.item?.id, c.title).catch(() => {})
      } else {
        stopListening().catch(() => {})
      }
    },
    onTrackChange: (t) => {
      window.dispatchEvent(new CustomEvent('sa:track', { detail: t }))
    },
    onEnd: () => { toast('这本听完啦'); updateMini() },
  })
  state.player = p
  window.__saPlayer = p   // voice.js 在语音结束后需要它恢复播放
  p.init()
  return p
}

// ---------------- 开始播放一本书 ----------------
export async function playItem(item, { startTime } = {}) {
  const player = initPlayer()
  const meta = item.media?.metadata || {}
  toast('正在加载…')

  // 换书前把上一本收尾：关掉旧会话并落盘进度，否则 server 端会话泄漏
  if (state.current && state.current.item?.id !== item.id) {
    try { await player.finish() } catch (_) {}
  }

  // 进度：优先用传入的，其次 ABS 的上次进度
  let start = startTime
  if (start === undefined) {
    const prog = await abs.getProgress(item.id)
    start = prog?.currentTime || 0
    // 已听完的书从头开始
    if (prog?.isFinished) start = 0
  }

  const { sessionId, tracks, duration } = await abs.startPlayback(item.id, Math.floor(start))
  if (!tracks.length) { toast('这本书没有音频文件'); return }

  // 补上带 token 的直链
  const withUrls = tracks.map(t => ({
    ...t,
    url: abs.trackUrl(t.contentUrl),
    headers: abs.authHeaders(),
  }))

  // 章节：列表接口不返回 chapters，只有单本详情有。这里先取详情补上，
  // 拿不到就用音轨自身信息合成（ABS 里一个音轨通常就是一集，startOffset 即章节起点）
  let chapters = item.media?.chapters || []
  if (!chapters.length) {
    try {
      const detail = await abs.getItem(item.id)
      chapters = detail?.media?.chapters || []
    } catch (_) {}
  }
  if (!chapters.length) {
    chapters = withUrls.map(t => ({
      title: t.title || `第 ${t.index} 集`,
      start: t.startOffset || 0,
      end: (t.startOffset || 0) + (t.duration || 0),
    }))
  }
  const title = meta.title || '未命名'

  state.current = {
    item,
    sessionId,
    tracks: withUrls,
    chapters,
    duration,
    title,
    cover: abs.coverUrl(item.id, { width: 400 }),
    author: meta.authorName || meta.author || '',
    startAt: start,
  }

  // 有离线缓存的集优先用本地文件（无网也能听；没缓存的集自动回落在线上）
  let localMap = {}
  try { localMap = await localTrackMap(item.id) } catch (_) {}

  await player.load({
    itemId: item.id,
    tracks: withUrls,
    sessionId,
    duration,
    startBookTime: start,
    localMap,
    notification: {
      title,
      artist: meta.authorName || meta.author || '听书',
      album: meta.seriesName || '',
      artworkUrl: abs.coverUrl(item.id, { width: 400 }),
    },
  })
  await player.play()
  await go('player')
}

/** 播放完成后 / 切书时的收尾 */
export async function stopCurrent() {
  await stopListening().catch(() => {})
  if (!state.player) return
  await state.player.stop({ silent: true })
  await state.player.finish()
  state.current = null
  updateMini()
}

// ---------------- 迷你条 ----------------
function updateMini() {
  const mini = $('#mini'), c = state.current, p = state.player
  // data-mini 让 CSS 知道"迷你条显示了"，据此调整内容底部留白
  const hide = () => {
    document.body.dataset.mini = '0'
    mini.classList.add('hidden')
    syncDockHeight()
  }
  if (!c || !p) { hide(); return }
  if (document.body.dataset.view === 'player') { hide(); return }

  mini.classList.remove('hidden')
  document.body.dataset.mini = '1'
  // 封面：无刮削的书 cover 为空，<img src=""> 会显示"破图"图标。
  // 所以先铺一张占位封面，真封面加载成功再盖上去（和书架/搜索页同一套做法）。
  const slot = $('#miniCoverSlot')
  const cov = $('#miniCover')
  if (slot) {
    const old = slot.querySelector('.cover-ph')
    if (old) old.remove()
    slot.insertAdjacentHTML('afterbegin',
      fallbackCover({ title: c.title, cls: 'cover-ph-mini' }))
    cov.onload = () => { cov.style.opacity = '1' }
    cov.onerror = () => { cov.removeAttribute('src'); cov.style.opacity = '0' }
    cov.style.opacity = '0'
    if (c.cover) cov.src = c.cover
  }
  $('#miniTitle').textContent = c.title
  const t = c.tracks[p.trackIndex]
  const chapter = c.chapters[p.trackIndex]?.title || t?.title || ''
  $('#miniSub').textContent = p.playing ? '正在播放 · ' + chapter : '已暂停 · ' + chapter
  $('#miniToggle').innerHTML = icon(p.playing ? 'pause' : 'play', 17)
  syncDockHeight()
}

export { updateMini }

// ---------------- 启动 ----------------
async function boot() {
  // 恢复配置
  const server = await store.get(CONFIG_KEYS.server)
  const token = await store.get(CONFIG_KEYS.token)
  // 不再分儿童/成人模式（老板要求取消）；state.mode 保留但恒为 'kid'，
  // 老用户本地存的 mode 值不再读取，避免他们被卡在"成人模式"界面。
  state.mode = 'kid'
  state.kidPin = (await store.get(CONFIG_KEYS.kidPin, '')) || ''

  if (server && token) {
    abs.configure(server, token)
    try {
      const libs = await abs.libraries()
      state.libraries = libs
      state.libraryId = libs[0]?.id || null
      initPlayer()
      await go('kidhome')
      // 本机收藏补齐到服务器：用户若在 ABS 后台补了 update 权限，
      // 之前只能存本机的收藏会自动同步过去（失败就算了，不打扰用户）
      syncToServer(abs).catch(() => {})
    } catch (e) {
      console.warn('恢复会话失败，回登录页', e)
      await go('login')
    }
  } else {
    await go('login')
  }

  // 闪屏至少在屏幕上待一会儿，避免闪一下就跳走
  setTimeout(() => $('#boot')?.classList.add('hidden'), 420)
}

// ---------------- 视图注册 ----------------
route('login', async (root) => {
  const { renderLogin } = await import('./views/login.js')
  document.body.dataset.view = 'login'
  await renderLogin(root)
})

route('kidhome', async (root) => {
  document.body.dataset.view = 'kidhome'
  await renderShelf(root)
})

route('player', async (root) => {
  document.body.dataset.view = 'player'
  await renderPlayer(root)
})

route('search', async (root, params) => {
  document.body.dataset.view = 'search'
  // ⚠️ 必须把 params 传下去！原来写成 renderSearch(root)，
  // 导致语音说完书名跳过来时 params.q 丢失 → 第一次不搜索、要说第二次才出结果。
  await renderSearch(root, params)
})

route('settings', async (root) => {
  document.body.dataset.view = 'settings'
  await renderSettings(root)
})

// 收听统计（家长用，入口在设置页）
route('stats', async (root, params) => {
  document.body.dataset.view = 'stats'
  const { renderStats } = await import('./views/stats.js')
  await renderStats(root, params)
})

// 关于页：版本/权限/服务器信息
route('about', async (root) => {
  document.body.dataset.view = 'about'
  await renderAbout(root)
})

// 家长设置（需要家长密码）：进度口径、触感、统计、服务器
route('parents', async (root) => {
  document.body.dataset.view = 'parents'
  const { renderParent } = await import('./views/parents.js')
  await renderParent(root)
})

// 我的收藏（心形按钮加的收藏在这里看）
route('favorites', async (root) => {
  document.body.dataset.view = 'favorites'
  const { renderFavorites } = await import('./views/favorites.js')
  await renderFavorites(root)
})

// 离线缓存管理
route('cache', async (root) => {
  document.body.dataset.view = 'cache'
  const { renderCache } = await import('./views/cache.js')
  await renderCache(root)
})

// ---------------- 全局事件 ----------------
window.addEventListener('DOMContentLoaded', () => {
  initHaptics().catch(() => {})
  // dock 高度自动同步（内容留白与 FAB 都依赖 --dock-h）
  watchDock()
  window.addEventListener('resize', syncDockHeight)
  window.addEventListener('orientationchange', syncDockHeight)

  // 静态图标：迷你条三个按钮 + 启动闪屏（index.html 里只留空容器，图标由这里注入）
  $('#miniPrev').innerHTML = icon('prev', 19)
  $('#miniNext').innerHTML = icon('next', 19)
  $('#miniToggle').innerHTML = icon('play', 17)
  const bg = $('#bootGlyph')
  if (bg) bg.innerHTML = icon('headphones', 66)

  // 迷你条交互
  $('#miniToggle').addEventListener('click', e => { e.stopPropagation(); state.player?.toggle() })
  $('#miniPrev').addEventListener('click', e => { e.stopPropagation(); state.player?.prevTrack() })
  $('#miniNext').addEventListener('click', e => { e.stopPropagation(); state.player?.nextTrack() })
  $('#mini').addEventListener('click', () => go('player'))

  // 语音（页面内各自绑定更精确的 handler；这里是兜底）
  document.addEventListener('click', e => {
    const btn = e.target.closest('[data-voice]')
    if (!btn || btn._saBound) return
    btn._saBound = true
    openVoiceOverlay({ onSearch: (q) => go('search', { q }) })
  })

  boot()
})

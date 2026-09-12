/**
 * ShelfAudio 主程序：路由 + 模式切换 + 各视图渲染
 *
 * 两种模式：
 *  - kid   儿童模式：大卡片书架 + 语音搜索 + 极简大字播放页 + 家长锁保护
 *  - adult 成人模式：列表 + 搜索 + 章节/倍速/睡眠定时/收藏夹/继续听
 */
import { abs } from './lib/api.js'
import { store, CONFIG_KEYS } from './lib/store.js'
import { BookPlayer } from './lib/player.js'
import { renderShelf } from './views/shelf.js'
import { renderPlayer } from './views/player.js'
import { renderSearch } from './views/search.js'
import { renderSettings } from './views/settings.js'
import { openVoiceOverlay } from './lib/voice-ui.js'

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

  document.querySelectorAll('.kid-tabs').forEach(e => e.remove())
  const root = $('#view')
  root.innerHTML = ''
  await fn(root, params)
  currentCleanup = typeof root._cleanup === 'function' ? root._cleanup : null
  updateMini()
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
    },
    onTrackChange: (t) => {
      window.dispatchEvent(new CustomEvent('sa:track', { detail: t }))
    },
    onEnd: () => { toast('这本听完啦 🎉'); updateMini() },
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

  await player.load({
    itemId: item.id,
    tracks: withUrls,
    sessionId,
    duration,
    startBookTime: start,
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
  if (!state.player) return
  await state.player.stop({ silent: true })
  await state.player.finish()
  state.current = null
  updateMini()
}

// ---------------- 迷你条 ----------------
function updateMini() {
  const mini = $('#mini'), c = state.current, p = state.player
  // data-mini 让 CSS 知道"迷你条显示了"，据此把儿童模式底栏抬起来（否则被盖住点不到）
  const liftOff = () => { document.body.dataset.mini = '0' }
  if (!c || !p) { mini.classList.add('hidden'); liftOff(); return }
  if (document.body.dataset.view === 'player') { mini.classList.add('hidden'); liftOff(); return }

  mini.classList.remove('hidden')
  document.body.dataset.mini = '1'
  const cov = $('#miniCover')
  cov.src = c.cover || ''
  $('#miniTitle').textContent = c.title
  const t = c.tracks[p.trackIndex]
  const chapter = c.chapters[p.trackIndex]?.title || t?.title || ''
  $('#miniSub').textContent = p.playing ? '正在播放 · ' + chapter : '已暂停 · ' + chapter
  $('#miniToggle').textContent = p.playing ? '❚❚' : '▶'
}

export { updateMini }

// ---------------- 启动 ----------------
async function boot() {
  // 恢复配置
  const server = await store.get(CONFIG_KEYS.server)
  const token = await store.get(CONFIG_KEYS.token)
  const mode = await store.get(CONFIG_KEYS.mode, 'kid')
  state.mode = mode === 'adult' ? 'adult' : 'kid'
  state.kidPin = (await store.get(CONFIG_KEYS.kidPin, '')) || ''

  if (server && token) {
    abs.configure(server, token)
    try {
      const libs = await abs.libraries()
      state.libraries = libs
      state.libraryId = libs[0]?.id || null
      initPlayer()
      await go(state.mode === 'adult' ? 'shelf' : 'kidhome')
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
  await renderShelf(root, { kid: true })
})

route('shelf', async (root) => {
  document.body.dataset.view = 'shelf'
  await renderShelf(root, { kid: false })
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

// ---------------- 全局事件 ----------------
window.addEventListener('DOMContentLoaded', () => {
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

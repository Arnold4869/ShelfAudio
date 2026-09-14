/**
 * ShelfAudio 主程序：路由 + 模式切换 + 各视图渲染
 *
 * 界面只有一套（2026-09-12 老板要求取消儿童/成人模式分类）：
 *   大卡片书架 + 语音搜索 + 极简大字播放页；家长相关的操控项收在「家长设置」里（要密码）。
 */
import { hub, ndId } from './lib/servers.js'
import { AbsApi } from './lib/api.js'
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
import { playbackBlockedReason, volumeCap } from './lib/parental.js'
import { localTrackUriLazy } from './lib/offline.js'
import { recordContinue, removeContinueLocal } from './lib/continue-local.js'
import { initHaptics } from './lib/haptics.js'
import { syncToServer } from './lib/favs.js'

window.__abs = hub   // player.js 需要（多源门面，按 sessionId 前缀分派）

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

// ---------------- 视图历史栈 ----------------
// 为什么需要（老板 2026-09-14 报「首页进收藏，返回没回首页」）：
// 之前每个页面的返回键都**硬编码目标**（收藏页写死 go('settings')），
// 从书架进去也回设置页，从设置进去也回设置页 —— 入口不同、返回不同，写死必错。
// 现在记录真实的访问顺序，返回 = 回上一页；入口随便变都对。
const TAB_VIEWS = new Set(['kidhome', 'search', 'settings'])
let viewStack = []   // [{ name, params }]，栈顶 = 当前页

/** 当前视图名（调试/测试用） */
export function currentView() {
  return viewStack.length ? viewStack[viewStack.length - 1].name : ''
}

/** 历史栈快照（测试断言用，别在业务里依赖） */
export function viewHistory() {
  return viewStack.map(v => v.name)
}

function rememberView(name, params, opts) {
  if (opts.replace) {
    // 原地替换（返回时用）：栈深度不变
    if (viewStack.length) viewStack[viewStack.length - 1] = { name, params }
    else viewStack = [{ name, params }]
    return
  }
  if (TAB_VIEWS.has(name)) {
    // 页签是「根」：切页签等于另起一条路径，清空历史
    viewStack = [{ name, params }]
    return
  }
  const top = viewStack[viewStack.length - 1]
  if (top && top.name === name) {
    // 同页换参数（如统计页切日期）不算新页面，否则历史会被灌满
    viewStack[viewStack.length - 1] = { name, params }
    return
  }
  viewStack.push({ name, params })
}

/**
 * 返回上一页。没有历史（或历史只有当前页）时回 fallback。
 * @param {string} fallback 兜底视图名
 */
export async function goBack(fallback = 'kidhome') {
  if (viewStack.length > 1) {
    viewStack.pop()
    const prev = viewStack[viewStack.length - 1]
    await go(prev.name, prev.params, { replace: true })
    return
  }
  await go(fallback, {}, { replace: true })
}

export async function go(name, params = {}, opts = {}) {
  const fn = routes[name]
  if (!fn) { console.warn('no route', name); return }
  rememberView(name, params, opts)

  // 卸载上一个视图的监听，否则每次进播放页都会累加 window 事件监听
  if (typeof currentCleanup === 'function') {
    try { currentCleanup() } catch (_) {}
    currentCleanup = null
  }
  // 离开页面时关掉语音浮层，避免它挂着麦克风。
  // 性能（2026-09-13 审计）：动态 import + 桥调用每次切页都跑。语音浮层没打开时
  // （绝大多数切页），两个都白做 —— 浮层存在才需要清理。
  if (document.querySelector('.voice-overlay')) {
    document.querySelectorAll('.voice-overlay').forEach(e => e.remove())
    try {
      const { forceStopCurrent } = await import('./lib/voice.js')
      await forceStopCurrent()
    } catch (_) {}
  }

  // 旧底栏**先留在 dock 上**，等新页面 render 完再处理 ——
  // 之前是先删掉旧的，新底栏要等 render（可能含网络 await）完才出现，
  // 期间 dock 空一下，切页签时底栏「闪一下」（老板 2026-09-12 报告）。
  const root = $('#view')
  root.innerHTML = ''
  await fn(root, params)
  currentCleanup = typeof root._cleanup === 'function' ? root._cleanup : null
  // 把底栏从 #view 移进底部 dock 容器（和迷你条同一个表面 → 视觉上连成一整块）。
  // ⚠️ 新视图**没有**底栏时（如全屏播放页）必须把旧底栏删掉 ——
  // 只写 `if (tabsEl)` 会留下上一个页面（书架/搜索/设置）的底栏，
  // 播放页因此凭空多出一条底栏，把「倍速/定时/选集」压住只露上半截
  // （老板 2026-09-13 实机反馈）。播放页是全屏播放器，本身不需要底栏。
  const tabsEl = root.querySelector('.kid-tabs')
  const dock = $('#dock')
  if (dock) {
    document.querySelectorAll('.kid-tabs').forEach(e => e.remove())
    if (tabsEl) dock.appendChild(tabsEl)
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
  // 性能（2026-09-13 审计）：写 CSS 自定义属性会让整棵树的样式失效并触发重算。
  // 这个函数在播放中由 updateMini 每秒调用一次，值其实几乎不变 ——
  // 值相同就跳过，省掉每秒一次的全树样式重算。
  if (h === _lastDockH) return
  _lastDockH = h
  document.documentElement.style.setProperty('--dock-h', h + 'px')
}
let _lastDockH = -1

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

// ---------------- 家长管控：播放中的到点自停 ----------------
let _guardTimer = null
function _armGuardTimer() {
  // 每 60 秒复查一次：不在时段内 / 当天额度用完 → 柔和暂停 + 提示。
  // 为什么不用精确 setTimeout 到结束点：后台 JS 定时器会被挂起（锁屏听书场景），
  // 60s 轮询 + tick 里记录的真实收听秒数（暂停时不计时）组合起来误差 ≤ 1 分钟。
  if (_guardTimer) return
  _guardTimer = setInterval(async () => {
    const p = state.player
    if (!p?.playing) return
    try {
      const blocked = await playbackBlockedReason()
      if (blocked) {
        await p.pause()
        toast(blocked)
      }
    } catch (_) {}
  }, 60000)
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
        if (c) {
          startListening(c.item?.id, c.title).catch(() => {})
          _armGuardTimer()   // 家长管控：播放中定期复查（到点/超时自动停）
        }
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
  // 家长管控闸门（老板 2026-09-13）：不在允许时段 / 当天时长用完 → 直接拦下，
  // 连"加载中"都不显示，避免孩子以为坏了反复点。播放中途到点由 onState 里那个
  // 定时检查负责（见 initPlayer 的 guard 定时器）。
  const blocked = await playbackBlockedReason()
  if (blocked) {
    toast(blocked)
    throw new Error(blocked)
  }
  const player = initPlayer()
  const meta = item.media?.metadata || {}
  const sameBook = state.current?.item?.id === item.id && !!player.tracks?.length

  // 同一本书已经在播（或暂停）→ 直接回播放页，**不要**重建会话重播。
  // 老板 2026-09-13：「没缓存的，我刚听的，退出，进历史记录再点它，
  // 卡着播放两次一样感觉，播了 2 秒然后又从头播放」—— 根因就是这个重建：
  // 旧音频还在响（那 2 秒），新会话建好后从（被归零的）位置重新开播 →
  // 听感上就是"播了一次又从头播一次"。
  // 例外：显式传了 startTime（如"已听完需重头听"）时才真的重载。
  if (sameBook && startTime === undefined) {
    toast('继续播放')
    await go('player')
    return
  }

  // 换书前把上一本收尾：关掉旧会话并落盘进度，否则 server 端会话泄漏
  if (state.current && state.current.item?.id !== item.id) {
    try { await player.finish() } catch (_) {}
    // ⚠️ 立刻停掉旧音频：以前只 close 会话，旧音轨会一直响到新书 load 完成
    //（网络 1~3 秒），用户听到"两段声音叠着/先后响" —— 就是那个"卡着"的观感。
    try { await player.stop({ silent: true }) } catch (_) {}
    state.current = null
    updateMini()
  }

  // 进度：优先用传入的，其次 ABS 的上次进度
  let start = startTime
  if (start === undefined) {
    const prog = await hub.getProgress(item.id)
    start = prog?.currentTime || 0
    // 已听完的书从头开始
    if (prog?.isFinished) start = 0
  }

  const { sessionId, tracks, duration } = await hub.startPlayback(item.id, Math.floor(start))
  if (!tracks.length) { toast('这本书没有音频文件'); return }

  // 补上带 token 的直链
  const withUrls = tracks.map(t => ({
    ...t,
    url: hub.trackUrl(t.contentUrl, item.id),
    headers: hub.authHeaders(item.id),
  }))

  // 章节：列表接口不返回 chapters，只有单本详情有。这里先取详情补上，
  // 拿不到就用音轨自身信息合成（ABS 里一个音轨通常就是一集，startOffset 即章节起点）
  let chapters = item.media?.chapters || []
  if (!chapters.length) {
    try {
      const detail = await hub.getItem(item.id)
      chapters = detail?.media?.chapters || []
    } catch (_) {}
  }
  if (!chapters.length) {
    // 章节标题的单位按源取（ND=首，ABS=集）。曾经这里调了一个不存在的
    // chapterUnit() → ReferenceError → playItem 整个中断（0.7.2 引入，审计抓到）。
    const unit = (String(item.id || '').startsWith('nd:')) ? '首' : '集'
    chapters = withUrls.map(t => ({
      title: t.title || `第 ${t.index} ${unit}`,
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
    cover: hub.coverUrl(item.id, { width: 400 }),
    author: meta.authorName || meta.author || '',
    startAt: start,
  }

  // 离线缓存：按集懒查（只查当前要播的那一集）。
  // 老板 2026-09-13 报「全缓存的书点历史记录没反应」——
  // 旧写法把整本书每一集都 stat+getUri 各一次，536 集 = 1072 次原生桥调用，
  // 真机 0.5~3 秒纯等待、期间界面上什么都没发生。播放器换集时按需再查。
  const localResolver = (idx) => localTrackUriLazy(item.id, idx)

  // 第一时间补记「继续听」（老板 2026-09-13：播放就该立刻出现在列表最上面，
  // 不能等服务端 items-in-progress 慢慢更新）。
  // 放在 load 之前记，load 失败时在下面 catch 里撤销 —— 只留真正播起来的。
  try {
    await recordContinue({
      id: item.id,
      title,
      author: meta.authorName || meta.author || '',
      duration: item.media?.duration || duration || 0,
    })
  } catch (_) {}

  try {
    await player.load({
      itemId: item.id,
      tracks: withUrls,
      sessionId,
      duration,
      startBookTime: start,
      localResolver,
      notification: {
        title,
        artist: meta.authorName || meta.author || '听书',
        album: meta.seriesName || '',
        artworkUrl: hub.coverUrl(item.id, { width: 400 }),
      },
    })
    await player.play()
  } catch (e) {
    // load/play 失败不能把用户晾在播放页显示"正在播放"却没声音 ——
    // 把状态复位，给出可见的错误提示（"继续听第一本加载不出来"的可见兜底）。
    console.warn('播放加载失败', e)
    try { await player.stop({ silent: true }) } catch (_) {}
    try { await removeContinueLocal(item.id) } catch (_) {}   // 撤回补记，别留假记录
    state.current = null
    updateMini()
    throw new Error('加载失败，请再点一次试试')
  }
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
    // 性能（2026-09-13 审计）：原来无条件 remove + insertAdjacentHTML 重建占位封面，
    // 而 updateMini 在每次播放/暂停/缓冲状态变化时都会跑 —— 白建 DOM，
    // 还会让封面图重复解码闪一下。只在"换了一本书"时重建。
    const sig = c.item?.id || c.title || ''
    if (slot._saCoverSig !== sig) {
      slot._saCoverSig = sig
      const old = slot.querySelector('.cover-ph')
      if (old) old.remove()
      slot.insertAdjacentHTML('afterbegin',
        fallbackCover({ title: c.title, cls: 'cover-ph-mini' }))
      cov.onload = () => { cov.style.opacity = '1' }
      cov.onerror = () => { cov.removeAttribute('src'); cov.style.opacity = '0' }
      cov.style.opacity = '0'
      if (c.cover) cov.src = c.cover
    }
  }
  // 文本只在真的变了才写（写 textContent 会失效该节点的渲染缓存）
  const titleEl = $('#miniTitle')
  if (titleEl.textContent !== c.title) titleEl.textContent = c.title
  const t = c.tracks[p.trackIndex]
  const chapter = c.chapters[p.trackIndex]?.title || t?.title || ''
  const sub = p.playing ? '正在播放 · ' + chapter : '已暂停 · ' + chapter
  const subEl = $('#miniSub')
  if (subEl.textContent !== sub) subEl.textContent = sub
  // 图标是 innerHTML 重建（解析 + 重绘），只在播放态翻转时换
  const toggle = $('#miniToggle')
  const wantIcon = p.playing ? 'pause' : 'play'
  if (toggle._saIcon !== wantIcon) {
    toggle._saIcon = wantIcon
    toggle.innerHTML = icon(wantIcon, 17)
  }
  syncDockHeight()
}

/**
 * 切换源后让各页拿到正确的"当前库"。
 * state.libraryId 是全局单值 —— 切到另一台服务器时必须重置，
 * 否则书架还拿着上一台的库 id 去请求新服务器（404/空列表）。
 */
async function resetForSourceSwitch() {
  state.libraryId = null
  state.items = []
  try {
    state.libraries = await hub.libraries()
    state.libraryId = state.libraries[0]?.id || null
  } catch (_) {
    state.libraries = []
  }
}

export { updateMini, resetForSourceSwitch }

// ---------------- 启动 ----------------
async function boot() {
  // 不再分儿童/成人模式（老板要求取消）；state.mode 保留但恒为 'kid'，
  // 老用户本地存的 mode 值不再读取，避免他们被卡在"成人模式"界面。
  state.mode = 'kid'
  state.kidPin = (await store.get(CONFIG_KEYS.kidPin, '')) || ''

  // 通知静默设置要在启动时重放一次（老板 2026-09-13）：
  // Android 的通知渠道级别只有在 App 主动调用时才更新，重装/清数据后
  // 渠道会回到默认 LOW —— 不重放的话"我明明关了通知怎么又出现了"。
  try {
    if ((await store.get(CONFIG_KEYS.quietNotification, '0')) === '1') {
      const { setNotificationMode } = await import('./lib/notification-prefs.js')
      setNotificationMode('quiet').catch(() => {})
    }
  } catch (_) {}

  // 多源恢复（老板 2026-09-14）：ABS / Navidrome 各自独立登录态，
  // 任何一个登录了就能进主界面；都登录了可以右上角切换。
  const avail = await hub.restore()
  if (avail.length) {
    try {
      state.libraries = await hub.libraries()
      state.libraryId = state.libraries[0]?.id || null
      state.sources = avail
      initPlayer()
      await go('kidhome')
      // 本机收藏补齐到 ABS 服务器：用户若在 ABS 后台补了 update 权限，
      // 之前只能存本机的收藏会自动同步过去（失败就算了，不打扰用户）
      syncToServer(hub.abs).catch(() => {})
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
  // 密码防护放在 route 层（老板 2026-09-13：只有家长设置要密码，其它设置项不要）。
  // 为什么不能只拦入口按钮：统计页的「返回」也 go('parents')，只拦按钮会被绕过。
  // _parentUnlockedAt：本次解锁的有效期（进入后 10 分钟内不再重复要密码，
  // 否则在家长设置里点每一项都要输一次；离开 App 由进程结束自然失效）。
  if (state.kidPin && !(Date.now() - (state._parentUnlockedAt || 0) < 600000)) {
    if (!(await requireParentPin())) return
    state._parentUnlockedAt = Date.now()
  }
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

// 专辑详情（Navidrome）：点专辑不直接连播，进来看歌曲列表自己选（老板 2026-09-14）
route('album', async (root, params) => {
  document.body.dataset.view = 'album'
  const { renderAlbum } = await import('./views/album.js')
  await renderAlbum(root, params)
})

// 历史记录（完整收听历史；首页只露 3 条预览，入口按钮进来）
route('history', async (root) => {
  document.body.dataset.view = 'history'
  const { renderHistory } = await import('./views/history.js')
  await renderHistory(root)
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
  // 显示偏好（语音按钮显隐等）：要赶在第一个视图渲染前生效，boot 阶段异步读一次。
  // 极端时序下（偏好还没读完就渲染）按钮会先显示、读到后再隐藏 —— 可接受，
  // 因为绝大多数情况 Preferences 读取得比书架接口快。
  import('./lib/ui-prefs.js').then(m => m.loadUiPrefs()).catch(() => {})
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

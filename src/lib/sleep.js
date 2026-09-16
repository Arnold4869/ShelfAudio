/**
 * 睡眠定时状态模块（从 views/player.js 抽出来，2026-09-16）
 *
 * 为什么抽：定时是模块级状态（离开播放页到点仍要暂停），且 voice-ui 也要调；
 * 原来全部塞在 player.js 里。这次加「按章节定时」，逻辑多了近一倍，独立成模块。
 *
 * 两种定时（老板 2026-09-16）：
 *   time   —— 倒计时到点（原来是唯一模式，全部沿用：三路径触发 + 持久化恢复）
 *   tracks —— 听完 N 集/首后暂停。剩余量持久化（WebView 被杀后恢复仍生效）。
 *
 * tracks 模式的三条触发路径与 time 模式不同（没有"时钟"概念）：
 *   ① player 的 sa:track 事件（换集 = 消耗一次）——主路径
 *   ② 启动恢复（restore）
 * 注意 **不能** 用 sa:time 心跳判定 tracks 到点（那是由播放位置推的秒数，
 * 到 0 的瞬间也就是 complete 事件本身，重复处理反而容易双跳）。
 *
 * 到点动作与 time 模式完全一致：暂停 + toast + 震动（firePause）。
 */
import { store, CONFIG_KEYS } from './store.js'
import { haptic } from './haptics.js'
import { toast } from '../app.js'

let timeTimer = null      // setTimeout 句柄（time 模式）
let sleepAt = 0           // time 模式：到点的绝对时间戳（ms）
let sleepWatched = false  // 心跳/可见性兜底只注册一次
let tracksLeft = 0        // tracks 模式：还需播完几集（0 = 未设定）
/**
 * 「有定时正在生效」标记 —— 幂等护栏必须用它，**不能**看 sleepAt/tracksLeft。
 *
 * 为什么（2026-09-16 测试抓出的真 bug）：tracks 模式到点时，
 * onTrackCompleted() 先把 tracksLeft 减到 0，再调 firePause()；
 * 如果 firePause 用 `tracksLeft > 0` 判断"有没有定时"，那一刻已经是 0
 * → 直接 return → **不弹提示、不震动、不暂停**（只剩递减在跑）。
 * 所以用一个独立的 armed 标记：设定时点亮、firePause 里熄灭。
 */
let armed = false

// ---------- 到点动作（幂等，两种模式共用） ----------

/**
 * 到点执行：暂停播放。
 *
 * silent=true 用于「App 冷启动时发现定时早就过期」：用户并没有在听
 *（甚至过了好几天），不该弹提示、不该震动 —— 只静默清零。
 *
 * 幂等：先清状态再动作，setTimeout / 心跳 / complete 三条路径同时到点只生效一次。
 */
export async function firePause({ silent = false } = {}) {
  if (!armed) return
  armed = false
  sleepAt = 0
  tracksLeft = 0
  if (timeTimer) { clearTimeout(timeTimer); timeTimer = null }
  try { await store.set(CONFIG_KEYS.sleepAt, '0') } catch (_) {}
  try { await store.set(CONFIG_KEYS.sleepTracks, '0') } catch (_) {}
  if (silent) return
  try { haptic.warn?.() } catch (_) {}
  const { state } = await import('../app.js')
  try { Promise.resolve(state.player?.pause()).catch(() => {}) } catch (_) {}
  toast('睡眠定时到，已暂停')
}

function checkTimeDeadline() {
  if (sleepAt && Date.now() >= sleepAt) firePause()
}

/**
 * 注册兜底心跳（模块级，只注册一次；与播放页的 _cleanup 无关，切页面不丢）。
 *
 * 为什么不能只靠 setTimeout：锁屏/切后台时 WebView 的 JS 定时器会被系统挂起，
 * 而"听着睡着"恰恰是睡眠定时最核心的场景。用播放器持续发出的 sa:time 当心跳、
 * visibilitychange/focus 回前台时立刻结算兜底。
 */
function watchTimeDeadline() {
  if (sleepWatched) return
  sleepWatched = true
  window.addEventListener('sa:time', checkTimeDeadline)
  const onVisible = () => { if (document.visibilityState === 'visible') checkTimeDeadline() }
  document.addEventListener('visibilitychange', onVisible)
  window.addEventListener('focus', onVisible)
}

// ---------- 设定接口 ----------

/** 设定时间定时（minutes=0 表示关闭全部定时）。voice-ui 传分钟进来走这里。 */
export function setSleepTimer(minutes) {
  clearSleepTimer()
  if (!minutes) { toast('已关闭睡眠定时'); return }
  watchTimeDeadline()
  armed = true
  sleepAt = Date.now() + minutes * 60000
  // 持久化到 store：锁屏久了 WebView 可能被系统整个回收重建，恢复后定时仍在
  try { store.set(CONFIG_KEYS.sleepAt, String(sleepAt)) } catch (_) {}
  timeTimer = setTimeout(() => firePause(), minutes * 60000)
  toast('已设定 ' + minutes + ' 分钟后暂停')
}

/** 设定章节定时：听完 remain 集/首后暂停（remain 必须 ≥1） */
export function setSleepTracks(remain, unit = '集') {
  clearSleepTimer()
  if (!remain || remain < 1) { toast('已关闭睡眠定时'); return }
  armed = true
  tracksLeft = remain
  try { store.set(CONFIG_KEYS.sleepTracks, String(remain)) } catch (_) {}
  toast(`听完这 ${remain} ${unit}后暂停`)
}

/** 关闭全部定时（不弹 toast 的静默版，供内部/测试用） */
export function clearSleepTimer() {
  if (timeTimer) { clearTimeout(timeTimer); timeTimer = null }
  armed = false
  sleepAt = 0
  tracksLeft = 0
  try { store.set(CONFIG_KEYS.sleepAt, '0') } catch (_) {}
  try { store.set(CONFIG_KEYS.sleepTracks, '0') } catch (_) {}
}

// ---------- 查询 ----------

/** 当前激活的定时种类：'time' | 'tracks' | null（没设） */
export function sleepKind() {
  if (sleepAt) return 'time'
  if (tracksLeft > 0) return 'tracks'
  return null
}

/**
 * time 模式剩余秒数（未设定返回 0）。
 * 保留原名 getSleepRemaining：voice-ui 与旧测试都引用它。
 */
export function getSleepRemaining() {
  if (!sleepAt) return 0
  return Math.max(0, Math.round((sleepAt - Date.now()) / 1000))
}

/** tracks 模式剩余集数（未设定返回 0） */
export function getSleepTracksLeft() {
  return tracksLeft
}

/**
 * 整本书/整张专辑播完时的静默清理（第 4 轮审计补，2026-09-16）。
 *
 * 为什么需要：按章节定时的剩余计数是**跟人**的（模块级），但"还剩 3 集"
 * 只对**当前这本书**有意义 —— 书听完了播放本来就停了，这时残留的计数会
 * 跟着用户去看的下一本书，表现为"在新书刚听 1 集就被莫名暂停"。
 *
 * 只清 tracks 模式（时间定时是绝对时钟，跨书依然有效，不该被清）。
 * 静默：不弹 toast、不暂停（此时本来就没在播）。
 */
export function clearTrackSleepOnBookEnd() {
  if (tracksLeft <= 0) return
  tracksLeft = 0
  // 时间定时还活着时 armed 不能熄（firePause 的幂等护栏看它）
  if (!sleepAt) armed = false
  try { store.set(CONFIG_KEYS.sleepTracks, '0') } catch (_) {}
}

// ---------- 生命周期钩子 ----------

/** 启动时恢复（WebView 被系统回收重建后仍生效） */
export async function restoreSleepTimer() {
  try {
    const savedAt = parseInt(await store.get(CONFIG_KEYS.sleepAt, '0'), 10) || 0
    const savedTracks = parseInt(await store.get(CONFIG_KEYS.sleepTracks, '0'), 10) || 0
    if (savedAt) {
      if (savedAt <= Date.now()) {
        // 冷启动发现早就过期：不弹提示不震动（此时用户没在听），静默清零
        armed = true
        sleepAt = savedAt
        await firePause({ silent: true })
        return
      }
      armed = true
      sleepAt = savedAt
      watchTimeDeadline()
      timeTimer = setTimeout(() => firePause(), Math.max(0, savedAt - Date.now()))
    } else if (savedTracks > 0) {
      armed = true
      tracksLeft = savedTracks
    }
  } catch (_) {}
}

/**
 * 一集播完时由播放页（或 player 的 onTrackChange）调用：tracks 模式消耗一次。
 * 返回 true 表示已到点并触发了暂停。
 */
export function onTrackCompleted() {
  if (tracksLeft <= 0) return false
  tracksLeft -= 1
  try { store.set(CONFIG_KEYS.sleepTracks, String(tracksLeft)) } catch (_) {}
  if (tracksLeft <= 0) {
    firePause()
    return true
  }
  return false
}

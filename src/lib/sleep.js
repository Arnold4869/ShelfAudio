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
 *   ① app.js 注入 BookPlayer 的 onBeforeAdvance（player._onTrackEnd 里本集播完、
 *      推进下一集**之前**调用）——唯一真实消耗路径
 *   ② 启动恢复（restore）
 *   （sa:track 事件只被播放页 paintProgress / 歌词页监听，与本模块无关 ——
 *    2026-10-12 审计修正：旧注释曾把 sa:track 写成主路径，误导排查方向。）
 * 注意 **不能** 用 sa:time 心跳判定 tracks 到点（那是由播放位置推的秒数，
 * 到 0 的瞬间也就是 complete 事件本身，重复处理反而容易双跳）。
 *
 * 计数跟书不跟人（2026-10-12 审计修，P1）：落盘形状是 JSON { remain, unit, itemId }，
 * itemId 是设定时正在听的那本书/专辑。onTrackCompleted(itemId) 发现换书/换源时
 * 按「换书即作废」静默清零 —— 否则 ND 里设的「3 首」会串到有声书侧变成强停 3 集。
 * 兼容：旧版本存的是纯数字串（无 unit/itemId），读回时按老语义继续倒计数。
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
let tracksUnit = ''       // tracks 模式：单位（'集' | '首'，设定时的源决定，随计数落盘）
let tracksItemId = null   // tracks 模式：为哪本书/专辑设定（换书/换源即作废）
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
  tracksUnit = ''
  tracksItemId = null
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
export async function setSleepTimer(minutes) {
  clearSleepTimer()
  if (!minutes) { toast('已关闭睡眠定时'); return }
  watchTimeDeadline()
  sleepAt = Date.now() + minutes * 60000
  // 持久化到 store：锁屏久了 WebView 可能被系统整个回收重建，恢复后定时仍在
  // 2026-10-10 审计修：之前不 await —— 设完立刻被杀进程的话 sleepAt 没落盘，
  // 重启后 restoreSleepTimer 恢复不到，用户设的定时凭空消失。先落盘再起定时器。
  try { await store.set(CONFIG_KEYS.sleepAt, String(sleepAt)) } catch (_) {}
  armed = true
  timeTimer = setTimeout(() => firePause(), minutes * 60000)
  toast('已设定 ' + minutes + ' 分钟后暂停')
}

/** 设定章节定时：听完 remain 集/首后暂停（remain 必须 ≥1）。
 *  unit 随设定时的源（ND=首 / ABS=集）落盘，播放页读它而不是按当前源现算；
 *  itemId 绑定设定时正在听的那本书（换书/换源即作废）。 */
export async function setSleepTracks(remain, unit = '集', itemId = null) {
  clearSleepTimer()
  if (!remain || remain < 1) { toast('已关闭睡眠定时'); return }
  tracksLeft = remain
  tracksUnit = unit || '集'
  tracksItemId = itemId || null
  try {
    await store.set(CONFIG_KEYS.sleepTracks,
      JSON.stringify({ remain, unit: tracksUnit, itemId: tracksItemId }))
  } catch (_) {}
  armed = true
  toast(`听完这 ${remain} ${unit}后暂停`)
}

/** 关闭全部定时（不弹 toast 的静默版，供内部/测试用） */
export function clearSleepTimer() {
  if (timeTimer) { clearTimeout(timeTimer); timeTimer = null }
  armed = false
  sleepAt = 0
  tracksLeft = 0
  tracksUnit = ''
  tracksItemId = null
  // 故意不 await（关闭定时不该被一次慢写卡住）；store.set 自带兜底，这里再显式
  // 挂 .catch 让「失败也无所谓」是看得见的约定（2026-10-12 审计修）。
  store.set(CONFIG_KEYS.sleepAt, '0').catch(() => {})
  store.set(CONFIG_KEYS.sleepTracks, '0').catch(() => {})
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

/** tracks 模式落盘的单位（'集' | '首'；未设定返回 ''）。
 *  播放页的 sleepUnit 读它而不是按当前源现算 —— 否则 ND 设的「3 首」
 *  切到 ABS 会显示成「3 集」（2026-10-12 审计修）。 */
export function getSleepTracksUnit() {
  return tracksLeft > 0 ? tracksUnit : ''
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
  tracksUnit = ''
  tracksItemId = null
  // 时间定时还活着时 armed 不能熄（firePause 的幂等护栏看它）
  if (!sleepAt) armed = false
  // 同上：故意不 await，显式 .catch 标记「失败也无所谓」
  store.set(CONFIG_KEYS.sleepTracks, '0').catch(() => {})
}

// ---------- 生命周期钩子 ----------

/** 启动时恢复（WebView 被系统回收重建后仍生效） */
export async function restoreSleepTimer() {
  try {
    const savedAt = parseInt(await store.get(CONFIG_KEYS.sleepAt, '0'), 10) || 0
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
      return
    }
    // tracks 模式：新格式 JSON { remain, unit, itemId }；旧格式纯数字串兼容读回
    //（老数据没有 unit/itemId → 无来源校验，按老语义继续倒计数）。
    let savedTracks = 0, savedUnit = '', savedItemId = null
    const raw = await store.get(CONFIG_KEYS.sleepTracks, '0')
    try {
      const parsed = JSON.parse(raw)
      if (parsed && typeof parsed === 'object') {
        savedTracks = parseInt(parsed.remain, 10) || 0
        savedUnit = typeof parsed.unit === 'string' ? parsed.unit : ''
        savedItemId = typeof parsed.itemId === 'string' && parsed.itemId ? parsed.itemId : null
      } else {
        savedTracks = parseInt(parsed, 10) || 0
      }
    } catch (_) {
      savedTracks = parseInt(raw, 10) || 0
    }
    if (savedTracks > 0) {
      armed = true
      tracksLeft = savedTracks
      tracksUnit = savedUnit
      tracksItemId = savedItemId
    }
  } catch (_) {}
}

/**
 * 一集/一首播完时由 BookPlayer 的 onBeforeAdvance 钩子（app.js 注入）调用：
 * tracks 模式消耗一次。返回 true 表示已到点并触发了暂停。
 *
 * itemId 校验（2026-10-12 审计修，P1）：计数是「为某本书设定的」。传入的 itemId
 * 与落盘的不一致 = 用户已经换了书/换源 → 按「换书即作废」静默清零，不消耗、不暂停。
 * 任一侧为空（旧数据 / 未绑定）时不校验，保持老行为。
 */
export function onTrackCompleted(itemId = null) {
  if (tracksLeft <= 0) return false
  if (tracksItemId && itemId && tracksItemId !== itemId) {
    clearTrackSleepOnBookEnd()   // 静默作废：不消耗、不 toast、不暂停
    return false
  }
  tracksLeft -= 1
  if (tracksLeft <= 0) {
    // 到点：firePause 会把 sleepTracks 落成 '0'，这里不再抢写一次 JSON
    firePause()
    return true
  }
  // 故意不 await（消耗路径在播放器换集的关键路径上）；显式 .catch 标记
  // 「写失败也无所谓，内存计数为准」（store.set 内部本就有兜底）。
  store.set(CONFIG_KEYS.sleepTracks,
    JSON.stringify({ remain: tracksLeft, unit: tracksUnit, itemId: tracksItemId })).catch(() => {})
  return false
}

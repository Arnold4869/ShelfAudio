/**
 * 使用时间管控与音量上限（家长功能，老板 2026-09-15）
 *
 * 需求原话（意译整理）：
 *  - 「全局设置音量不超过推荐音量」→ volumeCap：无论孩子按多大音量，App 内播放音量
 *    不会超过家长设定的上限（App 内音量，不碰系统音量 —— 系统音量是孩子自己按的，
 *    App 侧做乘法封顶）。
 *  - 「控制每天什么时候可以听…上学时间，也就是工作日几点到几点，周末几点到几点；
 *    到设定的时间停止使用，或听的时间超过之后就不能使用」→ 两层限制：
 *      ① 时段窗：工作日（周一~五）/ 周末（周六日）各自的允许时间段；
 *      ② 每日时长：当天累计收听（复用收听统计 listeningLog 的真实数据）超过上限即停。
 *
 * 到点怎么办：不搞「播放中突然拔掉」的突兀体验 —— 播放器收到 blocked()
 * 状态变化时柔和暂停并给出提示，想再播会直接被拦下（toast 说明原因）。
 * 家长密码在家长设置里，孩子自己解不开。
 */
import { store, CONFIG_KEYS } from './store.js'

// ---------- 时段 ----------

/** 周几：0=周日 … 6=周六。工作日=1~5，周末=0,6 */
function isWeekend(d = new Date()) {
  const w = d.getDay()
  return w === 0 || w === 6
}

/** 'HH:MM' → 当天分钟数；非法返回 null */
function parseHM(s) {
  if (typeof s !== 'string' || !/^\d{1,2}:\d{2}$/.test(s.trim())) return null
  const [h, m] = s.trim().split(':').map(Number)
  if (h > 23 || m > 59) return null
  return h * 60 + m
}

function nowMinutes(d = new Date()) {
  return d.getHours() * 60 + d.getMinutes()
}

/**
 * 当前时间是否在允许时段内。
 * 支持「跨午夜」窗（如 20:00-07:00，晚上听到睡前的场景）。
 * 未启用 / 未配置 → 允许。
 */
export async function withinTimeWindow(d = new Date()) {
  if ((await store.get(CONFIG_KEYS.timeLimitEnabled, '0')) !== '1') return true
  const weekend = isWeekend(d)
  const fromS = await store.get(weekend ? CONFIG_KEYS.timeWeekendFrom : CONFIG_KEYS.timeWeekdayFrom, '')
  const toS = await store.get(weekend ? CONFIG_KEYS.timeWeekendTo : CONFIG_KEYS.timeWeekdayTo, '')
  const from = parseHM(fromS), to = parseHM(toS)
  if (from == null || to == null) return true   // 没配时段 = 不限时段
  const now = nowMinutes(d)
  if (from === to) return true                  // 零长度窗 = 不限
  if (from < to) return now >= from && now < to
  return now >= from || now < to                // 跨午夜
}

/** 给孩子看的提示文案（家长设置里也会用到） */
export async function timeWindowLabel() {
  const wdFrom = await store.get(CONFIG_KEYS.timeWeekdayFrom, '')
  const wdTo = await store.get(CONFIG_KEYS.timeWeekdayTo, '')
  const weFrom = await store.get(CONFIG_KEYS.timeWeekendFrom, '')
  const weTo = await store.get(CONFIG_KEYS.timeWeekendTo, '')
  if (!wdFrom && !weFrom) return '未设置'
  const f = (a, b) => (a && b ? `${a}–${b}` : '未设置')
  return `周一至周五 ${f(wdFrom, wdTo)} · 周末 ${f(weFrom, weTo)}`
}

// ---------- 每日时长 ----------

/** 当天已听秒数（直接复用收听统计的真实记录，不用孩子能篡改的另一份） */
export async function listenedSecondsToday() {
  const { dayRecords } = await import('./stats.js')
  const recs = await dayRecords()
  return recs.reduce((s, r) => s + (r.sec || 0), 0)
}

/** 每日上限分钟数（0 = 不限） */
export async function dailyLimitMinutes() {
  const v = Number(await store.get(CONFIG_KEYS.timeDailyMinutes, '0'))
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : 0
}

/**
 * 今天是否还能听（时长维度）。
 * @returns {allowed: boolean, remainingSec: number} remainingSec=Infinity 表示不限
 */
export async function dailyQuota() {
  const limit = await dailyLimitMinutes()
  if (!limit) return { allowed: true, remainingSec: Infinity }
  const used = await listenedSecondsToday()
  const remain = limit * 60 - used
  return { allowed: remain > 0, remainingSec: Math.max(0, remain) }
}

/**
 * 综合闸门：现在允许开始播放吗？
 * @returns {null | string} null=允许；否则是给孩子看的阻止原因
 */
export async function playbackBlockedReason(now = new Date()) {
  if (!(await withinTimeWindow(now))) {
    const weekend = isWeekend(now)
    const label = weekend ? '周末' : '周一至周五'
    const from = await store.get(weekend ? CONFIG_KEYS.timeWeekendFrom : CONFIG_KEYS.timeWeekdayFrom, '')
    const to = await store.get(weekend ? CONFIG_KEYS.timeWeekendTo : CONFIG_KEYS.timeWeekdayTo, '')
    return `现在不在收听时间（${label} ${from || '…'}–${to || '…'}），到点再来吧`
  }
  const q = await dailyQuota()
  if (!q.allowed) return '今天的收听时间用完啦，明天再来吧'
  return null
}

// ---------- 音量上限 ----------

/**
 * 全局音量上限（0.1~1，1=不限制）。
 * 播放器每次设置音量都会先过这一道：effective = min(用户想要的, cap)。
 */
export async function volumeCap() {
  const v = Number(await store.get(CONFIG_KEYS.volumeCap, '1'))
  return Number.isFinite(v) && v >= 0.1 && v <= 1 ? v : 1
}

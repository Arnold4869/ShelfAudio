/**
 * 使用时间管控与音量上限（家长功能，老板 2026-09-13 起）
 *
 * 需求原话（意译整理）：
 *  - 「全局设置音量不超过推荐音量」→ volumeCap：无论孩子按多大音量，App 内播放音量
 *    不会超过家长设定的上限（App 内音量，不碰系统音量）。
 *  - 「控制每天什么时候可以听…上学时间，也就是工作日几点到几点，周末几点到几点；
 *    到设定的时间停止使用，或听的时间超过之后就不能使用」→ 两层限制：
 *      ① 时段窗：工作日（周一~五）/ 周末（周六日）各自的允许时间段；
 *      ② 每日时长：当天累计收听（复用收听统计 listeningLog 的真实数据）超过上限即停。
 *
 * 老板 2026-09-14 追加：
 *  - 「那两种限制，只要有一个限制，就可以限制 app 不能使用」→ 两层限制**各自独立开关**
 *    （timeWindowEnabled / dailyLimitEnabled），不再共用一个总开关。
 *  - 音量上限要能精细调节（滚轮），不再只有 60/80/不限三档。
 *
 * 到点怎么办：不搞「播放中突然拔掉」的突兀体验 —— 播放器收到 blocked() 状态变化时
 * 柔和暂停并给出提示，想再播会直接被拦下（toast 说明原因）。
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
 * 兼容老配置：老版本只有一个总开关 timeLimitEnabled。
 * 新版本两个开关都没写过（null）时，沿用老开关的值 ——
 * 否则升级后家长原来配好的限制会静默失效。
 */
async function enabledWithLegacy(specificKey) {
  const v = await store.get(specificKey, null)
  if (v !== null && v !== undefined) return v === '1'
  return (await store.get(CONFIG_KEYS.timeLimitEnabled, '0')) === '1'
}

/** 时段限制开关 */
export async function timeWindowEnabled() {
  return enabledWithLegacy(CONFIG_KEYS.timeWindowEnabled)
}

/** 每日时长限制开关 */
export async function dailyLimitEnabled() {
  return enabledWithLegacy(CONFIG_KEYS.dailyLimitEnabled)
}

/** 是否配置了任一时段（用来判断"开关开了但没填时段"这种无效状态） */
export async function hasTimeWindowConfig() {
  const wd = await store.get(CONFIG_KEYS.timeWeekdayFrom, '')
  const we = await store.get(CONFIG_KEYS.timeWeekendFrom, '')
  return !!(wd || we)
}

/**
 * 当前时间是否在允许时段内。
 * 支持「跨午夜」窗（如 20:00-07:00，晚上听到睡前的场景）。
 * 未开启时段限制 / 未配置时段 → 允许。
 *
 * 老板 2026-09-14：「那两种限制，只要有一个限制，就可以限制 app 不能使用」
 * → 时段与每日时长各自独立开关，开哪个哪个生效。
 */
export async function withinTimeWindow(d = new Date()) {
  if (!(await timeWindowEnabled())) return true
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

/** 时段摘要文案（家长设置里显示） */
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
 * 今天是否还能听（时长维度）。开关没开 / 上限为 0 → 不限。
 * @returns {allowed: boolean, remainingSec: number} remainingSec=Infinity 表示不限
 */
export async function dailyQuota() {
  if (!(await dailyLimitEnabled())) return { allowed: true, remainingSec: Infinity }
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

export const VOLUME_CAP_MIN = 0.1
export const VOLUME_CAP_MAX = 1

/**
 * 全局音量上限（0.1~1，1=不限制，步进 5%）。
 * 播放器每次设置音量都会先过这一道：effective = min(用户想要的, cap)；
 * 且**每次装轨/开播都要重新应用**（插件音量是按 asset 存的，
 * 换集会回到默认 100%，只设一次等于没设）。
 */
export async function volumeCap() {
  const v = Number(await store.get(CONFIG_KEYS.volumeCap, '1'))
  if (!Number.isFinite(v)) return 1
  // 老数据可能是 0.6 / 0.8 这类非 5% 倍数，保留原值（不做四舍五入丢精度）
  return Math.min(VOLUME_CAP_MAX, Math.max(VOLUME_CAP_MIN, v))
}

/** 音量上限的中文描述（'不限制' / '最高 65%'） */
export function volumeCapLabel(cap) {
  const pct = Math.round((Number.isFinite(cap) ? cap : 1) * 100)
  return pct >= 100 ? '不限制' : `最高 ${pct}%`
}

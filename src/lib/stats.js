/**
 * 收听时长统计（本地记录，不上传服务器）
 *
 * 需求：家长要能看到孩子「今天听了什么、各听了多久、上午/下午分别是多少」，
 * 粒度到**作品**（书名），不到单集。所以每条记录只存书名，不存章节。
 *
 * 设计取舍：
 *  - 累积式记录：播放中每 FLUSH_MS 落一次盘，只累加"真实在播的秒数"，
 *    暂停时立刻结算 —— 这样统计的是"听了多久"，而不是"开着 App 多久"。
 *  - 按 30 分钟粒度切片存储，而不是每 N 秒写一条：否则一天会有上千条记录，
 *    JSON 存储会越来越大、设置页也会变慢。同一天同一本书同半小时合并成一条。
 *  - 只保留最近 KEEP_DAYS 天，自动清理，避免无限增长。
 *
 * 记录结构：{ d: 'YYYY-MM-DD', b: 'bookId', t: '书名', s: 起始时间戳, sec: 秒数 }
 * 取"上午/下午"时用 s（该片段起始时刻）判断，而不是 d，所以要存时间戳。
 */
import { store, CONFIG_KEYS } from './store.js'

const KEEP_DAYS = 60          // 只留最近 60 天
const FLUSH_MS = 30000        // 每 30 秒结算一次
const SLOT_MS = 30 * 60 * 1000 // 同类记录合并到 30 分钟一档

let cache = null              // 记录数组（内存副本）
let cur = null                // 正在累积的播放：{ bookId, title, sec, lastAt }
let timer = null

function todayKey(ts = Date.now()) {
  const d = new Date(ts)
  const p = n => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

async function load() {
  if (cache) return cache
  cache = (await store.getJSON(CONFIG_KEYS.listeningLog, [])) || []
  if (!Array.isArray(cache)) cache = []
  return cache
}

async function save() {
  // 清理过期
  const cutoff = Date.now() - KEEP_DAYS * 86400000
  cache = (cache || []).filter(r => r && r.s >= cutoff)
  await store.setJSON(CONFIG_KEYS.listeningLog, cache)
}

/** 把一段秒数记到当前播放的书上（按 30 分钟档合并） */
async function addSeconds(sec) {
  if (!cur || !(sec > 0)) return
  const list = await load()
  const slot = Math.floor(cur.lastAt / SLOT_MS) * SLOT_MS
  // 同一天、同一本书、同一半小时候的档 → 累加，不再新增记录
  const hit = list.find(r => r.b === cur.bookId && Math.floor(r.s / SLOT_MS) * SLOT_MS === slot)
  if (hit) hit.sec += sec
  else list.push({ d: todayKey(cur.lastAt), b: cur.bookId, t: cur.title, s: cur.lastAt, sec })
}

/**
 * 开始/继续计时。
 * @param {string} bookId
 * @param {string} title 书名（统计只到作品粒度，不记章节）
 */
export async function startListening(bookId, title) {
  if (!bookId) return
  // onState 在播放中会被反复调用（每次状态事件）。同一本书继续播时直接返回：
  // 既不要重建 record（会重复写盘），也不要动 lastAt ——
  // lastAt 是 tick 计算 delta 的基准，一改就会把基准推后，时长永远累积不上。
  if (cur && cur.bookId === bookId) return
  await flush()
  cur = { bookId, title: title || '未命名', sec: 0, lastAt: Date.now() }
  if (timer) clearInterval(timer)
  timer = setInterval(() => { tick().catch(() => {}) }, FLUSH_MS)
  await tick()   // 立刻落一条，避免刚开始听就退出的情况丢数据
}

/** 累加自上次以来的秒数并落盘 */
async function tick() {
  if (!cur) return
  const now = Date.now()
  const delta = (now - cur.lastAt) / 1000
  cur.lastAt = now
  // 后台播放：iOS/Android 切后台后 JS 定时器会被挂起，回前台时 delta 是一大段
  // （孩子锁屏听书就属于这种）。这段时间**应该计入**，否则会大幅少算。
  // 上限设 MAX_GAP 是为了防止极端情况（比如定时器被系统延迟很久）把时长算爆。
  // 暂停时会走 stopListening()，cur 已清空，所以"暂停着放一夜"不会被算进来。
  if (delta > 0) {
    const MAX_GAP = 30 * 60
    cur.sec += Math.min(delta, MAX_GAP)
  }
  // 只落 ≥1 秒的量：否则每次开始播放都会写一条 sec≈0.0001 的垃圾记录
  // （统计页会显示成「0 秒」，很难看也污染列表）
  if (cur.sec >= 1) {
    await addSeconds(cur.sec)
    cur.sec = 0
    await save()
  }
}

/** 暂停/停止播放时结算 */
export async function stopListening() {
  if (timer) { clearInterval(timer); timer = null }
  try { await tick() } catch (_) { }
  cur = null
}

/** 切换作品时用（内部会先结算上一本） */
export async function flush() {
  if (!cur) return
  try { await tick() } catch (_) { }
}

// ---------------- 查询 ----------------

/** 取某天的全部记录（默认今天） */
export async function dayRecords(day = todayKey()) {
  const list = await load()
  return list.filter(r => r.d === day).sort((a, b) => a.s - b.s)
}

/**
 * 汇总：某天按作品聚合
 * @returns [{ bookId, title, sec, sessions: [{ from, to, sec, period }] }]
 */
export async function summaryByBook(day = todayKey()) {
  const recs = await dayRecords(day)
  const map = new Map()
  for (const r of recs) {
    const key = r.b || r.t
    if (!map.has(key)) map.set(key, { bookId: r.b, title: r.t, sec: 0, sessions: [] })
    const b = map.get(key)
    b.sec += r.sec
    b.sessions.push({ from: r.s, to: r.s + r.sec * 1000, sec: r.sec, period: periodOf(r.s) })
  }
  return [...map.values()].sort((a, b) => b.sec - a.sec)
}

/** 汇总：某天上午/下午各多少秒 */
export async function summaryByPeriod(day = todayKey()) {
  const recs = await dayRecords(day)
  const out = { morning: 0, afternoon: 0, evening: 0 }
  for (const r of recs) out[periodOf(r.s)] += r.sec
  return out
}

/** 按起始时刻分时段：凌晨/上午 0-12、下午 12-18、晚上 18-24 */
export function periodOf(ts) {
  const h = new Date(ts).getHours()
  if (h < 12) return 'morning'
  if (h < 18) return 'afternoon'
  return 'evening'
}

export const PERIOD_LABEL = { morning: '上午', afternoon: '下午', evening: '晚上' }

/** 有记录的日期列表（倒序），用于统计页切换 */
export async function daysWithRecords() {
  const list = await load()
  return [...new Set(list.map(r => r.d))].sort().reverse()
}

/** 清空全部统计（设置页提供） */
export async function clearAll() {
  cache = []
  await store.setJSON(CONFIG_KEYS.listeningLog, [])
}

/** 把秒数格式化成「1 小时 23 分」 */
export function fmtDuration(sec) {
  // ⚠️ 必须先整体四舍五入到分钟、再拆小时和分。
  // 早先写成 h=floor(s/3600)、m=round(s%3600/60)：3599 秒会得到
  // h=0、m=60 →「60 分钟」（进位没同步到小时），59 秒又变成「1 分钟」。
  // 与 app.js 的 fmtDur 用同一套口径，避免两个页面显示不一致。
  const s = Math.max(0, Math.round(sec || 0))
  if (s < 60) return `${s} 秒`
  const totalMin = Math.round(s / 60)
  const h = Math.floor(totalMin / 60)
  const m = totalMin % 60
  if (h && m) return `${h} 小时 ${m} 分`
  if (h) return `${h} 小时`
  return `${m} 分钟`
}

/** 时间点 → HH:MM */
export function fmtClock(ts) {
  const d = new Date(ts)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

export { todayKey }

#!/usr/bin/env node
/**
 * 收听统计逻辑的回归测试（node 直接跑，不需要浏览器）
 *
 * 为什么单独测：统计是家长用来管孩子时间的依据，算错了比 UI 花掉更严重
 * （少算 → 家长以为孩子没听；多算 → 冤枉孩子）。
 * 这里用真实源码 + 假 Preferences 驱动，覆盖：
 *   - 同一本书的时长会累加到同一条记录
 *   - 不同书分开统计
 *   - 上午/下午/晚上分时段归类
 *   - 暂停后不再计时（不能把"暂停着放一夜"算进去）
 *   - 时长格式化（进位正确）
 *   - 超过保留天数的记录会被清掉
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

let PASS = 0, FAIL = 0
const ok = (name, cond, extra = '') => {
  if (cond) { PASS++; console.log(`  ✅ ${name}`) }
  else { FAIL++; console.log(`  ❌ ${name} ${extra}`) }
}

// ---- 假 store（把 store.setJSON/getJSON 换成内存 Map）----
const mem = new Map()
const fakeStore = {
  async get(key, fb = null) {
    if (!mem.has(key)) return fb
    return mem.get(key)
  },
  async set(key, v) { mem.set(key, String(v)) },
  async getJSON(key, fb) {
    const raw = mem.get(key)
    if (!raw) return fb
    try { return JSON.parse(raw) } catch (_) { return fb }
  },
  setJSON(key, o) { return this.set(key, JSON.stringify(o)) },
  async remove(key) { mem.delete(key) },
}
const CONFIG_KEYS = {
  listeningLog: 'listeningLog',
}

// 把 stats.js 的源码取出来，替换掉对 store 的 import，注入假 store
let src = readFileSync(path.join(ROOT, 'src/lib/stats.js'), 'utf8')
src = src.replace(/import\s*\{[^}]*\}\s*from\s*'\.\/store\.js'/, '')
src = src.replace(/import\s*\{[^}]*\}\s*from\s*'\.\/haptics\.js'/, '')
src = src.replace(/^export /gm, '')
src = `${src}\nreturn { startListening, stopListening, flush, dayRecords, summaryByBook, summaryByPeriod, periodOf, fmtDuration, fmtClock, todayKey, daysWithRecords, clearAll, __setStore: (s) => { store = s }, __setKeys: (k) => { CONFIG_KEYS = k } }`

const factory = new Function('store', 'CONFIG_KEYS', src)
const S = factory(fakeStore, CONFIG_KEYS)

// 控制时间：把 Date.now / setInterval 换成可控的
// ⚠️ 用本地时区构造时间戳（不要硬编码 +08:00）。
// stats 的分时段是按手机**本地时区**判断的（孩子在当地 9 点听就是"上午"），
// 所以测试必须在任意 TZ 下都通过 —— 硬编码偏移会在 CI（UTC）上失败。
const at = (h, m = 0) => new Date(2026, 8, 12, h, m, 0, 0).getTime()
let NOW = at(9)
const realNow = Date.now
const realSetTimeout = globalThis.setTimeout
const realSetInterval = globalThis.setInterval
const realClearInterval = globalThis.clearInterval
let intervals = []
Date.now = () => NOW
globalThis.setInterval = (fn, ms) => { const id = { fn, ms }; intervals.push(id); return id }
globalThis.clearInterval = (id) => { intervals = intervals.filter(x => x !== id) }
const advance = (ms) => {
  NOW += ms
  // 手动触发定时器（模拟到点）
  for (const it of [...intervals]) {
    if (ms >= it.ms) it.fn()
  }
}

// 每个用例前清空
// 注意：stats.js 内部有一个模块级 cache。只清假 store 不够 ——
// 必须走 clearAll() 一起清掉，否则用例之间会互相污染（踩过）。
const reset = async () => { intervals = []; await S.clearAll(); mem.clear() }

async function run() {
  console.log("\n=== 1. 基本累加 ===")
  await reset()
  await S.startListening('bookA', '示例开篇')
  advance(30000)
  await new Promise(r => realSetTimeout(r, 20))
  await S.stopListening()
  let recs = await S.dayRecords()
  ok("产生了一条记录", recs.length === 1, JSON.stringify(recs))
  ok("记的是书名", recs[0]?.t === '示例开篇', recs[0]?.t)
  ok("时长约 30 秒", recs[0]?.sec >= 25 && recs[0]?.sec <= 35, String(recs[0]?.sec))

  console.log("\n=== 2. 同一本书累加、不同书分开 ===")
  await reset()
  await S.startListening('bookA', '书A')
  advance(30000); await new Promise(r => realSetTimeout(r, 20))
  await S.stopListening()
  await S.startListening('bookA', '书A')
  advance(30000); await new Promise(r => realSetTimeout(r, 20))
  await S.stopListening()
  await S.startListening('bookB', '书B')
  advance(60000); await new Promise(r => realSetTimeout(r, 20))
  await S.stopListening()
  const byBook = await S.summaryByBook()
  ok("聚合出 2 本书", byBook.length === 2, String(byBook.length))
  const a = byBook.find(b => b.title === '书A')
  const b = byBook.find(b => b.title === '书B')
  ok("书A 累计约 60 秒（两次合并）", a && a.sec >= 55 && a.sec <= 65, String(a?.sec))
  ok("书B 约 60 秒", b && b.sec >= 55 && b.sec <= 65, String(b?.sec))
  ok("时长倒序（多的在前）", byBook[0].sec >= byBook[1].sec)

  console.log("\n=== 3. 暂停后不再计时 ===")
  await reset()
  await S.startListening('bookA', '书A')
  advance(30000); await new Promise(r => realSetTimeout(r, 20))
  await S.stopListening()          // 暂停
  advance(3600000)                 // 干放 1 小时
  const r3 = await S.dayRecords()
  const total3 = r3.reduce((x, y) => x + y.sec, 0)
  ok("暂停期间不计入（1 小时没被算进去）", total3 < 60, String(total3))

  console.log("\n=== 4. 上午/下午/晚上分时段 ===")
  await reset()
  // 上午 9 点
  NOW = at(9)
  await S.startListening('b', '书')
  advance(60000); await new Promise(r => realSetTimeout(r, 20))
  await S.stopListening()
  // 下午 14 点
  NOW = at(14)
  await S.startListening('b', '书')
  advance(120000); await new Promise(r => realSetTimeout(r, 20))
  await S.stopListening()
  // 晚上 20 点
  NOW = at(20)
  await S.startListening('b', '书')
  advance(180000); await new Promise(r => realSetTimeout(r, 20))
  await S.stopListening()

  const per = await S.summaryByPeriod('2026-09-12')
  ok("上午约 60 秒", per.morning >= 55 && per.morning <= 65, String(per.morning))
  ok("下午约 120 秒", per.afternoon >= 115 && per.afternoon <= 125, String(per.afternoon))
  ok("晚上约 180 秒", per.evening >= 175 && per.evening <= 185, String(per.evening))
  ok("periodOf 边界：11:59→上午", S.periodOf(at(11, 59)) === 'morning')
  ok("periodOf 边界：12:00→下午", S.periodOf(at(12)) === 'afternoon')
  ok("periodOf 边界：17:59→下午", S.periodOf(at(17, 59)) === 'afternoon')
  ok("periodOf 边界：18:00→晚上", S.periodOf(at(18)) === 'evening')

  console.log("\n=== 5. 分时段明细（sessions）===")
  const byBook5 = await S.summaryByBook('2026-09-12')
  const sessions = (byBook5[0]?.sessions || []).sort((a, b) => a.from - b.from)
  ok("有 3 段明细", sessions.length === 3, String(sessions.length))
  ok("明细时段正确", sessions[0]?.period === 'morning' && sessions[1]?.period === 'afternoon'
     && sessions[2]?.period === 'evening', JSON.stringify(sessions.map(s => s.period)))

  console.log("\n=== 6. 时长格式化 ===")
  ok("59 秒", S.fmtDuration(59) === '59 秒', S.fmtDuration(59))
  ok("60 秒 → 1 分钟", S.fmtDuration(60) === '1 分钟', S.fmtDuration(60))
  ok("90 秒 → 2 分钟(四舍五入)", S.fmtDuration(90) === '2 分钟', S.fmtDuration(90))
  ok("3600 秒 → 1 小时", S.fmtDuration(3600) === '1 小时', S.fmtDuration(3600))
  // 进位陷阱：3599 秒四舍五入到 60 分钟，必须进位成 1 小时而不是显示「60 分钟」
  ok("3599 秒 → 1 小时（进位）", S.fmtDuration(3599) === '1 小时', S.fmtDuration(3599))
  ok("5000 秒 → 1 小时 23 分", S.fmtDuration(5000) === '1 小时 23 分', S.fmtDuration(5000))
  ok("负数安全", S.fmtDuration(-5) === '0 秒', S.fmtDuration(-5))
  ok("undefined 安全", S.fmtDuration(undefined) === '0 秒', S.fmtDuration(undefined))

  console.log("\n=== 7. 日期归属 & 清理 ===")
  await reset()
  NOW = at(23, 59)
  await S.startListening('b', '书')
  advance(30000); await new Promise(r => realSetTimeout(r, 20))
  await S.stopListening()
  const d = await S.dayRecords()
  ok("跨零点前后仍归到当天（用片段起始时刻）", d.length === 1 && d[0].d === '2026-09-12',
     JSON.stringify(d.map(x => x.d)))

  // 保留期清理：手动塞一条 100 天前的记录，save 时应被清掉
  mem.set('listeningLog', JSON.stringify([
    { d: '2026-01-01', b: 'old', t: '很久以前', s: NOW - 200 * 86400000, sec: 600 },
    { d: S.todayKey(), b: 'new', t: '最近', s: NOW - 3600000, sec: 300 },
  ]))
  // 触发一次 save（通过 start+stop）
  await S.startListening('b2', '书2')
  advance(30000); await new Promise(r => realSetTimeout(r, 20))
  await S.stopListening()
  const keys = await S.daysWithRecords()
  ok("超过保留期的记录被清掉", !keys.includes('2026-01-01'), JSON.stringify(keys))

  console.log("\n=== 8. clearAll ===")
  await S.clearAll()
  const after = await S.dayRecords()
  ok("清空后没有记录", after.length === 0, String(after.length))

  console.log("\n=== 9. 边界：没在播时 stop 不报错 ===")
  let threw = false
  try { await S.stopListening(); await S.flush() } catch (_) { threw = true }
  ok("空状态 stop/flush 不抛错", !threw)

  // 还原
  Date.now = realNow
  globalThis.setInterval = realSetInterval
  globalThis.clearInterval = realClearInterval

  console.log(`\n${'='.repeat(46)}\n结果：${PASS} 通过 / ${FAIL} 失败`)
  process.exit(FAIL ? 1 : 0)
}

run().catch(e => { console.error('测试崩了:', e); process.exit(1) })

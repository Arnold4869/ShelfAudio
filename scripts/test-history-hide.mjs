#!/usr/bin/env node
/**
 * ND 历史删除兜底回归（P1 §3.3 + 复审 NF-2，2026-10-12）
 *
 * 背景：Subsonic 没有「隐藏继续听」。removeFromContinue 只删 bookmark，
 * 而 updateProgress 每次进度同步都会重建 → 「删完立刻回来」。
 * 修法：删除成功后记入本地清单 ndHiddenContinue；loadHistory 过滤之；
 * 用户重新起播时 unhideHistoryEntry 解除。
 *
 * NF-2（复审 2026-10-12）：ndHiddenContinue 原是裸「读-改-写」，与
 * fire-and-forget 的 unhide 交错会互相覆盖。改走 store.mutateJSON 串行队列
 * （同 §4.7）。本版改用**真实 src/lib/store.js**（只桩 Preferences），并发
 * 断言用**写侧延迟**撑开丢更新窗口（两个并发删除 + 删除/解除交错）直接验证
 * 串行化 —— 裸 RMW 下会丢条目（见 §6 注释：为什么延迟必须加在写侧）。
 *
 * 断言（修复被还原时全部会红）：
 *  1. removeHistoryEntry('nd:…') 成功 → ndHiddenContinue 落盘
 *  2. 服务端仍返回该条（bookmark 被进度同步重建）→ loadHistory 过滤掉
 *  3. unhideHistoryEntry → 清单移除，loadHistory 重新可见
 *  4. ABS id 不写清单（ABS 走服务端 hideFromContinueListening）
 *  5. 清单封顶 100 条（防无限增长）
 *  6. NF-2：并发删除不丢条目（串行队列），并发 remove+unhide 不交错覆盖
 *
 * 用法: node scripts/test-history-hide.mjs
 */
import fs from 'fs'
import path from 'path'
import { fileURLToPath, pathToFileURL } from 'url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

// ---------- 真 store.js + 可控 Preferences 桩 ----------
const PREFS = new Map()          // 键含 shelfaudio. 前缀
// 按调用次序消耗的 set（写回）延迟表（ms）。并发断言用它把「读-改-写」的
// **写侧**窗口撑开：丢更新的条件是「读在对方的写之前、自己的写在对方的写之后」
// —— 只有写延迟撑得开这个窗口。试过给 get 加延迟：延迟读会连同它的写一起
// 后移，慢读者总是读到快写者写完的结果，裸 RMW 也不丢（复跑验证过，等延迟
// 与读延迟两种构造在旧代码上照样绿 = 测了个寂寞）。
let setDelays = []
globalThis.__HIDE_PREFS__ = {
  async get({ key }) { return { value: PREFS.has(key) ? PREFS.get(key) : null } },
  async set({ key, value }) {
    const d = setDelays.length ? setDelays.shift() : 0
    if (d) await new Promise(r => setTimeout(r, d))
    PREFS.set(key, String(value))
  },
  async remove({ key }) { PREFS.delete(key) },
}
globalThis.window = { Capacitor: { isNativePlatform: () => true } }

{
  const src = fs.readFileSync(path.join(ROOT, 'src/lib/store.js'), 'utf8')
  fs.writeFileSync(path.join(ROOT, '.tmp-hide-store.mjs'),
    src.replace(/import \{ Preferences \} from '@capacitor\/preferences'/, 'const Preferences = globalThis.__HIDE_PREFS__'))
}

// ---------- 其余桩（hub / continue-local） ----------
const SERVER_ITEMS = { list: [], removed: [] }
const abs = {
  async me() { return { username: 'u', mediaProgress: [] } },
  async itemsInProgress() { return SERVER_ITEMS.list },
  async removeFromContinue(id) { SERVER_ITEMS.removed.push(id) },
}
const continueLocal = {
  async listContinueLocal() { return [] },
  async removeContinueLocal() {},
}

// ---------- 装载真 history.js（store 换成真 store 桩文件） ----------
const SRC = fs.readFileSync(path.join(ROOT, 'src/lib/history.js'), 'utf8')
const stubPath = path.join(ROOT, '.tmp-history-under-test.mjs')
const code = SRC
  .replace(/import \{ hub as abs \} from '\.\/servers\.js'/, 'const abs = globalThis.__HISTORY_HUB__')
  .replace(/import \{ store, CONFIG_KEYS \} from '\.\/store\.js'/, `import { store, CONFIG_KEYS } from './.tmp-hide-store.mjs'`)
  .replace(/import \{ listContinueLocal, removeContinueLocal \} from '\.\/continue-local\.js'/, 'const { listContinueLocal, removeContinueLocal } = globalThis.__HISTORY_LOCAL__')
fs.writeFileSync(stubPath, code)

globalThis.__HISTORY_HUB__ = abs
globalThis.__HISTORY_LOCAL__ = continueLocal

const history = await import(pathToFileURL(stubPath).href)

let pass = 0, fail = 0
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ✅ ${name}`) }
  else { fail++; console.log(`  ❌ ${name}${extra ? ' — ' + extra : ''}`) }
}
const HIDE_KEY = 'shelfaudio.ndHiddenContinue'
const hiddenList = () => { const v = PREFS.get(HIDE_KEY); return v === undefined ? [] : JSON.parse(v) }
const setHiddenList = a => PREFS.set(HIDE_KEY, JSON.stringify(a))
const ndItem = (id, title) => ({
  id, media: { metadata: { title } },
  progressLastUpdate: Date.now(),
  _progress: { currentTime: 50, duration: 100 },
})

console.log('\n=== 1. 删除 ND 历史 → 记入本地隐藏清单 ===')
{
  PREFS.clear(); SERVER_ITEMS.list = []; SERVER_ITEMS.removed = []
  SERVER_ITEMS.list = [ndItem('nd:alb1', 'ND 专辑'), ndItem('nd:alb2', '另一张')]
  await history.removeHistoryEntry('nd:alb1')
  ok('服务端 removeFromContinue 被调', SERVER_ITEMS.removed.includes('nd:alb1'), JSON.stringify(SERVER_ITEMS.removed))
  ok('ndHiddenContinue 落盘含 nd:alb1', hiddenList().includes('nd:alb1'), JSON.stringify(hiddenList()))
  ok('只记被删的那条', hiddenList().length === 1, JSON.stringify(hiddenList()))
}

console.log('\n=== 2. bookmark 被进度同步重建 → 历史不再显示（P1 核心）===')
{
  PREFS.clear(); SERVER_ITEMS.list = []; SERVER_ITEMS.removed = []
  setHiddenList(['nd:alb1'])
  // 模拟：删除后下一次 updateProgress 又把 bookmark 建回来了
  SERVER_ITEMS.list = [ndItem('nd:alb1', '删了又回来的'), ndItem('nd:alb2', '正常专辑')]
  const out = await history.loadHistory()
  ok('loadHistory 过滤掉 nd:alb1', !out.some(x => x.id === 'nd:alb1'), JSON.stringify(out.map(x => x.id)))
  ok('其它 ND 条目正常显示', out.some(x => x.id === 'nd:alb2'), JSON.stringify(out.map(x => x.id)))
}

console.log('\n=== 3. 重新起播 → unhideHistoryEntry 解除隐藏 ===')
{
  PREFS.clear(); SERVER_ITEMS.list = []; SERVER_ITEMS.removed = []
  setHiddenList(['nd:alb1', 'nd:alb9'])
  await history.unhideHistoryEntry('nd:alb1')
  const l = hiddenList()
  ok('清单移除 nd:alb1', !l.includes('nd:alb1'), JSON.stringify(l))
  ok('清单保留 nd:alb9', l.includes('nd:alb9'), JSON.stringify(l))
  SERVER_ITEMS.list = [ndItem('nd:alb1', '又想听了')]
  const out = await history.loadHistory()
  ok('解除后历史重新可见', out.some(x => x.id === 'nd:alb1'), JSON.stringify(out.map(x => x.id)))
  // 幂等：对不在清单里的 id 无副作用（不写回）
  const rawBefore = PREFS.get(HIDE_KEY)
  await history.unhideHistoryEntry('nd:not-there')
  ok('对不在清单的 id 无副作用（不写回）', PREFS.get(HIDE_KEY) === rawBefore, JSON.stringify(PREFS.get(HIDE_KEY)))
}

console.log('\n=== 4. ABS id 不写 ND 清单 ===')
{
  PREFS.clear(); SERVER_ITEMS.list = []; SERVER_ITEMS.removed = []
  SERVER_ITEMS.list = [ndItem('abs1', 'ABS 书')]
  await history.removeHistoryEntry('abs1')
  ok('ABS 删除走服务端', SERVER_ITEMS.removed.includes('abs1'))
  ok('ndHiddenContinue 不写', !PREFS.has(HIDE_KEY), JSON.stringify(PREFS.get(HIDE_KEY)))
  await history.unhideHistoryEntry('abs1')
  ok('ABS unhide 无副作用', !PREFS.has(HIDE_KEY))
}

console.log('\n=== 5. 清单封顶 100 条 ===')
{
  PREFS.clear(); SERVER_ITEMS.list = []; SERVER_ITEMS.removed = []
  const ids = Array.from({ length: 105 }, (_, i) => 'nd:a' + i)
  for (const id of ids) await history.removeHistoryEntry(id)
  const l = hiddenList()
  ok('封顶 100', l.length === 100, String(l.length))
  ok('保留最新的（a5..a104）', l.includes('nd:a104') && l.includes('nd:a5') && !l.includes('nd:a4'), JSON.stringify(l.slice(0, 3)) + '…')
}

console.log('\n=== 6. NF-2：并发写不丢条目（串行队列，写侧延迟制造竞态窗口）===')
{
  // 竞态构造（setDelays 按调用次序消耗）：两个删除的读都立刻完成（都看到空表），
  // x2 的写回 5ms 落地、x1 的写回 40ms 才落地 → 裸 RMW 下 x1 的 [x1] 把 x2 的
  // [x2] 整个覆盖掉，x2 丢。走 mutateJSON 则 x2 的整段（读→改→写）排在 x1 的
  // 整段后面，读到的是 [x1] → [x1,x2]。
  PREFS.clear(); SERVER_ITEMS.removed = []
  setDelays = [40, 5]
  await Promise.all([
    history.removeHistoryEntry('nd:x1'),
    history.removeHistoryEntry('nd:x2'),
  ])
  setDelays = []
  const l = hiddenList()
  ok('并发删除两条都落盘（裸 RMW 下丢 1 条）', l.includes('nd:x1') && l.includes('nd:x2'), JSON.stringify(l))
  ok('并发删除共 2 条（不多不少）', l.length === 2, JSON.stringify(l))

  // 并发 remove + unhide：删除记入、解除移除，互不覆盖。
  // 注意入队顺序：remove 先让位给两个 stub await，unhide 的 mutateJSON 反而
  // 先入队 → unhide 的写吃 delay[0]（慢 40ms）、remove 的吃 delay[1]（快 5ms）。
  // 裸 RMW 时序：两者都立刻读到 [u1]，remove 5ms 写回 [u1,u2]，unhide 40ms
  // 写回 [] → u2 丢（「删了又不见」）。队列下 unhide 整段先走完（[] 落地），
  // remove 再读到 [] → [u2]。
  setHiddenList(['nd:u1'])
  setDelays = [40, 5]
  await Promise.all([
    history.removeHistoryEntry('nd:u2'),     // 记入 u2
    history.unhideHistoryEntry('nd:u1'),     // 解除 u1
  ])
  setDelays = []
  const l2 = hiddenList()
  ok('并发 remove+unhide 各自生效（u2 在、u1 出）', l2.includes('nd:u2') && !l2.includes('nd:u1'), JSON.stringify(l2))
  ok('并发后清单只剩 1 条', l2.length === 1, JSON.stringify(l2))
}

for (const f of ['.tmp-hide-store.mjs', '.tmp-history-under-test.mjs']) {
  try { fs.unlinkSync(path.join(ROOT, f)) } catch (_) {}
}
console.log('\n==============================================')
console.log(`结果：${pass} 通过 / ${fail} 失败`)
process.exit(fail ? 1 : 0)

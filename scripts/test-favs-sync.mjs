#!/usr/bin/env node
/**
 * 本机收藏 → 服务器同步回归（§4.7 + 复审 NF-4，2026-10-12）
 *
 * 背景：ABS 普通账号无 update 权限时收藏写不进服务器，退到本机（localFavs）；
 * 权限补齐后 boot 时 syncToServer 把本机收藏补进服务器收藏夹，成功后清掉本机记录。
 *
 * NF-4（复审 2026-10-12）：原实现成功后 `mutateJSON(KEY, () => [])` —— 队列只
 * 保证读写不交错，挡不住「清空整个键」把快照之后并发 addLocal 的新收藏冲掉
 * （last-write-wins，行为与 HEAD 等价但注释夸大）。改成**只删快照里已同步的
 * id**，并发新增天然保留。
 *
 * 本版用**真实 src/lib/store.js**（只桩 Preferences）+ 桩 abs（网络窗口可控）：
 *  - 同步窗口 = addToCollection 的网络延迟（30ms），期间并发 addLocal 落盘；
 *  - 断言「并发新增在同步成功后仍在」—— 在 HEAD 的 `() => []` 上会红（可证伪）。
 *
 * 其余回归面：已上服务器的跳过且计成功 / 部分失败不清本机（没同步成功的不能丢）/
 * nd: 条目不参与同步 / 无收藏夹与网络失败不动本机。
 *
 * 用法: node scripts/test-favs-sync.mjs
 */
import fs from 'fs'
import path from 'path'
import { fileURLToPath, pathToFileURL } from 'url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

// ---------- 真 store.js + Preferences 桩 ----------
const PREFS = new Map()
globalThis.__FAV_PREFS__ = {
  async get({ key }) { return { value: PREFS.has(key) ? PREFS.get(key) : null } },
  async set({ key, value }) { PREFS.set(key, String(value)) },
  async remove({ key }) { PREFS.delete(key) },
}
globalThis.window = { Capacitor: { isNativePlatform: () => true } }
{
  const src = fs.readFileSync(path.join(ROOT, 'src/lib/store.js'), 'utf8')
  fs.writeFileSync(path.join(ROOT, '.tmp-fav-store.mjs'),
    src.replace(/import \{ Preferences \} from '@capacitor\/preferences'/, 'const Preferences = globalThis.__FAV_PREFS__'))
}

// ---------- 装载真 favs.js ----------
const SRC = fs.readFileSync(path.join(ROOT, 'src/lib/favs.js'), 'utf8')
const stubPath = path.join(ROOT, '.tmp-favs-under-test.mjs')
fs.writeFileSync(stubPath,
  SRC.replace(/import \{ store, CONFIG_KEYS \} from '\.\/store\.js'/, `import { store, CONFIG_KEYS } from './.tmp-fav-store.mjs'`))
const favs = await import(pathToFileURL(stubPath).href)

// ---------- 桩 abs：网络窗口可控 ----------
const NET_DELAY = 30
function makeAbs({ books = [], failOn = null, collectionsThrows = false } = {}) {
  const calls = { add: [], collections: 0 }
  return {
    calls,
    async collections() {
      calls.collections++
      if (collectionsThrows) throw new Error('403')
      return [{ id: 'col1', books: books.map(id => ({ id })) }]
    },
    async addToCollection(colId, bookId) {
      await new Promise(r => setTimeout(r, NET_DELAY))   // 网络窗口：并发 addLocal 从这进
      calls.add.push(bookId)
      if (failOn === bookId) throw new Error('403')
    },
  }
}

let pass = 0, fail = 0
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ✅ ${name}`) }
  else { fail++; console.log(`  ❌ ${name}${extra ? ' — ' + extra : ''}`) }
}
const FAV_KEY = 'shelfaudio.localFavs'
const list = () => { const v = PREFS.get(FAV_KEY); return v === undefined ? [] : JSON.parse(v) }
const seed = arr => PREFS.set(FAV_KEY, JSON.stringify(arr))
const ids = () => list().map(x => x.id)
const item = (id, title) => ({ id, title, author: '', duration: 0, at: 1 })

console.log('\n=== 1. 基本同步：全成功 → 补进服务器 + 清掉本机快照 ===')
{
  PREFS.clear()
  seed([item('b1', '书一'), item('b2', '书二')])
  const abs = makeAbs()
  const okCount = await favs.syncToServer(abs)
  ok('返回成功条数 2', okCount === 2, String(okCount))
  ok('两本都补进服务器收藏夹', abs.calls.add.join() === 'b1,b2', JSON.stringify(abs.calls.add))
  ok('本机记录清空', list().length === 0, JSON.stringify(list()))
}

console.log('\n=== 2. NF-4：同步窗口里并发新增的收藏不被冲掉 ===')
{
  // 时序：快照读到 [b1,b2] → addToCollection 各 30ms → 期间 addLocal('late')
  // 落盘 → 循环结束 ok=2 触发清理。旧实现 `() => []` 会把 late 一起清掉
  // （这正是复审说的「注释夸大」）；新实现只删快照里的 b1/b2。
  PREFS.clear()
  seed([item('b1', '书一'), item('b2', '书二')])
  const abs = makeAbs()
  const p = favs.syncToServer(abs)                 // 不 await：进网络窗口
  await new Promise(r => setTimeout(r, 5))         // 稳稳落在 30ms 窗口内
  await favs.addLocal(item('late', '窗口里新加的'))
  const okCount = await p
  ok('返回成功条数 2（快照内的两本）', okCount === 2, String(okCount))
  ok('并发新增的 late 仍在（旧实现 `() => []` 会冲掉）', ids().join() === 'late', JSON.stringify(list()))
  ok('快照内的 b1/b2 已清（同步成功）', !ids().includes('b1') && !ids().includes('b2'))
  ok('服务器只收到快照内的两本', abs.calls.add.join() === 'b1,b2', JSON.stringify(abs.calls.add))
}

console.log('\n=== 3. 已在服务器收藏夹 → 跳过且计成功 ===')
{
  PREFS.clear()
  seed([item('b1', '书一'), item('b2', '书二')])
  const abs = makeAbs({ books: ['b1'] })           // b1 已在服务器
  const okCount = await favs.syncToServer(abs)
  ok('返回成功条数 2（跳过也算补齐）', okCount === 2, String(okCount))
  ok('只为 b2 发了一次 addToCollection', abs.calls.add.join() === 'b2', JSON.stringify(abs.calls.add))
  ok('本机记录清空', list().length === 0, JSON.stringify(list()))
}

console.log('\n=== 4. 部分失败 → 一条都不清（没同步成功的不能丢）===')
{
  PREFS.clear()
  seed([item('b1', '书一'), item('b2', '书二')])
  const abs = makeAbs({ failOn: 'b2' })            // b2 写被拒 → break
  const okCount = await favs.syncToServer(abs)
  ok('返回成功条数 1', okCount === 1, String(okCount))
  ok('b1、b2 都留在本机（失败的不能丢；成功的下轮靠「已在服务器」跳过，重复补齐无害）',
     ids().sort().join() === 'b1,b2', JSON.stringify(list()))
  ok('循环在 b2 失败后中止（没继续试后面的）', abs.calls.add.length === 2, JSON.stringify(abs.calls.add))
}

console.log('\n=== 5. nd: 条目不参与 ABS 同步 ===')
{
  PREFS.clear()
  seed([item('nd:alb1', 'ND 专辑'), item('b1', '书一')])
  const abs = makeAbs()
  const okCount = await favs.syncToServer(abs)
  ok('只同步 ABS 条目（nd: 过滤）', abs.calls.add.join() === 'b1', JSON.stringify(abs.calls.add))
  ok('返回成功条数 1', okCount === 1, String(okCount))
  ok('nd: 条目留在本机（它走 star 链路）', ids().join() === 'nd:alb1', JSON.stringify(list()))
}

console.log('\n=== 6. 无收藏夹 / 网络失败 → 不动本机 ===')
{
  PREFS.clear()
  seed([item('b1', '书一')])
  const absEmpty = { collections: async () => [] }              // 服务器没有收藏夹
  ok('无收藏夹返回 0', await favs.syncToServer(absEmpty) === 0)
  ok('无收藏夹时本机不动', ids().join() === 'b1', JSON.stringify(list()))
  const absErr = makeAbs({ collectionsThrows: true })           // collections() 直接抛
  ok('网络失败返回 0', await favs.syncToServer(absErr) === 0)
  ok('网络失败时本机不动', ids().join() === 'b1', JSON.stringify(list()))
}

for (const f of ['.tmp-fav-store.mjs', '.tmp-favs-under-test.mjs']) {
  try { fs.unlinkSync(path.join(ROOT, f)) } catch (_) {}
}
console.log('\n==============================================')
console.log(`结果：${pass} 通过 / ${fail} 失败`)
process.exit(fail ? 1 : 0)

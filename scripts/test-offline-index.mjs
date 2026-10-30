#!/usr/bin/env node
/**
 * 离线索引语义回归（P1 §3.5 + P2 §4.4 + 复审 NF-1，2026-10-12）
 *
 * §3.5 核心：索引「读取失败」与「真空」必须区分 ——
 *  - index() 读失败（桥错误 / JSON 损坏）→ null；没有键/形状不对 → {}
 *  - cachedBooks/cacheSize/removeBook 读失败 → 抛「缓存信息读取失败」
 *    （缓存页据此渲染警告 + 保留清空入口，而不是把入口藏掉装作没缓存）
 *  - offlineInfo 读失败 → 静默 null（播放路径不报错）
 *
 * NF-1（复审 2026-10-12）：上一版测试的 store 桩在「读失败」时**抛错**，与真实
 * store「吞错回 fallback」的契约相悖 —— 失败态断言验证的是虚构世界（复审原话：
 * 测了个寂寞）。本版改用**真实 src/lib/store.js**（只把 @capacitor/preferences
 * 换成可控桩），全链路「桥错误 → getJSONStrict 抛 → index() 返回 null →
 * 管理面报错」跑在真代码上；mutateIndex 的「损坏 → 备份 .bak → 从空重建」
 * 也在真 store 上断言。
 *
 * §4.4：downloadBook 的 stat 校验只对**索引里记过的集**做 ——
 *  全新书直接下载，不再每集先 stat（536 集 = 536 次桥调用）。
 *
 * 用法: node scripts/test-offline-index.mjs
 */
import fs from 'fs'
import path from 'path'
import { fileURLToPath, pathToFileURL } from 'url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

// ---------- 真 store.js + 可控 Preferences 桩 ----------
// 桩只模拟原生 SharedPreferences 的行为契约（get/set/remove + 可注入的桥错误），
// store 的吞错/严格读逻辑全部是被测真代码。
const PREFS = new Map()          // 键含 shelfaudio. 前缀（与真实 Preferences 一致）
let prefsGetThrows = false       // 模拟 Preferences 桥错误（读失败）
globalThis.__OFF_PREFS__ = {
  async get({ key }) {
    if (prefsGetThrows) throw new Error('bridge unavailable')
    return { value: PREFS.has(key) ? PREFS.get(key) : null }
  },
  async set({ key, value }) { PREFS.set(key, String(value)) },
  async remove({ key }) { PREFS.delete(key) },
}
// 真 store.js 走原生分支（hasNative() 看 window.Capacitor）—— 生产路径就在这条上
globalThis.window = { Capacitor: { isNativePlatform: () => true } }

{
  const src = fs.readFileSync(path.join(ROOT, 'src/lib/store.js'), 'utf8')
  fs.writeFileSync(path.join(ROOT, '.tmp-store-under-test.mjs'),
    src.replace(/import \{ Preferences \} from '@capacitor\/preferences'/, 'const Preferences = globalThis.__OFF_PREFS__'))
}
const { store } = await import(pathToFileURL(path.join(ROOT, '.tmp-store-under-test.mjs')).href)

// ---------- Filesystem 桩（计数） ----------
const FS = {
  statCalls: 0, downloadCalls: 0, deleteCalls: 0, rmdirCalls: [],
  sizes: new Map(),                 // path -> size（stat 返回值）
}
const Filesystem = {
  async stat({ path }) { FS.statCalls++; const s = FS.sizes.get(path); if (s === undefined) throw new Error('File does not exist'); return { size: s } },
  async downloadFile({ path }) { FS.downloadCalls++; FS.sizes.set(path, 1234); return { path } },
  async writeFile() {},
  async deleteFile({ path }) { FS.deleteCalls++; FS.sizes.delete(path) },
  async rmdir({ path }) { FS.rmdirCalls.push(path) },
  async mkdir() {},
  async getUri({ path }) { return { uri: 'file://' + path } },
  async readdir() { return { files: [] } },
}
const Directory = { Data: 'DATA' }
const hub = { downloadUrl: (id, u) => 'http://x/' + u, authHeaders: () => ({}) }
const t = (k, n) => (k === 'chapter' ? '集' : k)

// ---------- 装载真 offline.js（store 换成上面那份真 store 桩文件） ----------
const SRC = fs.readFileSync(path.join(ROOT, 'src/lib/offline.js'), 'utf8')
const stubPath = path.join(ROOT, '.tmp-offline-under-test.mjs')
const code = SRC
  .replace(/import \{ Filesystem, Directory \} from '@capacitor\/filesystem'/, 'const { Filesystem, Directory } = globalThis.__OFF_FS__')
  .replace(/import \{ store, CONFIG_KEYS \} from '\.\/store\.js'/, `import { store } from './.tmp-store-under-test.mjs'`)
  .replace(/import \{ hub \} from '\.\/servers\.js'/, 'const hub = globalThis.__OFF_HUB__')
  .replace(/import \{ t \} from '\.\/terms\.js'/, 'const t = globalThis.__OFF_T__')
fs.writeFileSync(stubPath, code)

globalThis.__OFF_FS__ = { Filesystem, Directory }
globalThis.__OFF_HUB__ = hub
globalThis.__OFF_T__ = t

const offline = await import(pathToFileURL(stubPath).href)

// ---------- 断言 ----------
let pass = 0, fail = 0
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ✅ ${name}`) }
  else { fail++; console.log(`  ❌ ${name}${extra ? ' — ' + extra : ''}`) }
}
const throwsWith = async (name, fn, msg) => {
  try { await fn(); ok(name, false, '没有抛错') }
  catch (e) { ok(name, String(e?.message || e).includes(msg), `message=${e?.message || e}`) }
}

// 键带真实前缀（store 层统一加 shelfaudio.）
const IDX_KEY = 'shelfaudio.offlineIndex'
const BAK_KEY = 'shelfaudio.offlineIndex.bak'
const setIdxRaw = s => PREFS.set(IDX_KEY, s)
const idxRaw = () => PREFS.get(IDX_KEY)      // undefined = 从没写过

console.log('\n=== 0. 真 store 契约：get/getJSON 吞错（不变），getJSONStrict 抛（NF-1 根）===')
{
  PREFS.clear(); prefsGetThrows = false
  PREFS.set('shelfaudio.k', '{"a":1}')
  ok('get 正常读', await store.get('k', 'FB') === '{"a":1}')
  ok('getJSON 正常解析', (await store.getJSON('k', null))?.a === 1)
  ok('getJSONStrict 正常解析', (await store.getJSONStrict('k'))?.a === 1)
  ok('getJSONStrict 键不存在 → null（「没有」不是错误）', await store.getJSONStrict('nope') === null,
     String(await store.getJSONStrict('nope')))
  // JSON 损坏（写入中途被杀的截断串）
  PREFS.set('shelfaudio.bad', '{"a":1')
  ok('getJSON 损坏 → 回 fallback（吞错契约不变）', await store.getJSON('bad', 'FB') === 'FB')
  let parseErr = null
  try { await store.getJSONStrict('bad') } catch (e) { parseErr = e }
  ok('getJSONStrict 损坏 → 抛 kind=parse', parseErr?.kind === 'parse', String(parseErr?.kind))
  ok('getJSONStrict 损坏 → e.raw 保留原始串（供备份）', parseErr?.raw === '{"a":1', JSON.stringify(parseErr?.raw))
  // 桥错误
  prefsGetThrows = true
  ok('get 桥错误 → 回 fallback（真实吞错契约，上版桩违背的就是它）', await store.get('k', 'FB') === 'FB')
  ok('getJSON 桥错误 → 回 fallback', await store.getJSON('k', 'FB') === 'FB')
  let readErr = null
  try { await store.getJSONStrict('k') } catch (e) { readErr = e }
  ok('getJSONStrict 桥错误 → 抛 kind=read', readErr?.kind === 'read', String(readErr?.kind))
  prefsGetThrows = false
}

console.log('\n=== 1. 桥错误 → index() null → 管理面报错（§3.5 全链路，NF-1 后可达）===')
{
  PREFS.clear(); FS.sizes.clear()
  setIdxRaw(JSON.stringify({ b1: { title: '书1', at: 5, bytes: 9, tracks: { 0: { path: 'p', size: 9 } } } }))
  // 健全性：正常读
  const books = await offline.cachedBooks()
  ok('有效索引 → cachedBooks 列出 1 本', books.length === 1 && books[0].id === 'b1', JSON.stringify(books))
  const before = idxRaw()
  prefsGetThrows = true
  await throwsWith('桥错误 → cachedBooks 抛「缓存信息读取失败」', () => offline.cachedBooks(), '缓存信息读取失败')
  await throwsWith('桥错误 → cacheSize 抛「缓存信息读取失败」', () => offline.cacheSize(), '缓存信息读取失败')
  await throwsWith('桥错误 → clearAll 抛「缓存信息读取失败」', () => offline.clearAll(), '缓存信息读取失败')
  await throwsWith('桥错误 → removeBook 抛「离线索引读取失败」', () => offline.removeBook('b1'), '离线索引读取失败')
  await throwsWith('桥错误 → downloadBook 抛「离线索引读取失败」', () => offline.downloadBook({ id: 'b1', title: 'x', tracks: [{ index: 1, title: 'a', contentUrl: '/x.mp3' }] }), '离线索引读取失败')
  ok('桥错误 → offlineInfo 静默 null（播放不报错）', await offline.offlineInfo('b1') === null, String(await offline.offlineInfo('b1')))
  ok('桥错误 → 索引原串未被动（读都读不到，不盲写）', idxRaw() === before)
  ok('桥错误 → 不写 .bak（没有可备份的东西）', !PREFS.has(BAK_KEY))
  prefsGetThrows = false
}

console.log('\n=== 2. JSON 损坏：展示侧报错（不再装作没缓存），写入侧备份后重建（NF-1 核心）===')
{
  const CORRUPT = '{"b1":{"title":"书1","at":5,"bytes":9,"tr'   // 截断写
  PREFS.clear(); FS.sizes.clear(); FS.rmdirCalls.length = 0; FS.deleteCalls = 0
  setIdxRaw(CORRUPT)

  // 展示侧：报错 —— 修复前（getJSON 吞错）这里返回空列表 = §3.5 的症状本身
  await throwsWith('损坏 → cachedBooks 抛（修复前返回 []，装作没缓存）', () => offline.cachedBooks(), '缓存信息读取失败')
  await throwsWith('损坏 → cacheSize 抛（修复前返回 0）', () => offline.cacheSize(), '缓存信息读取失败')
  ok('损坏 → offlineInfo 静默 null', await offline.offlineInfo('b1') === null)
  ok('此时 .bak 还没写（展示侧读取不触发备份）', !PREFS.has(BAK_KEY))

  // 写入侧 ①：removeBook 照删 —— 要删的目录名只由 bookId 决定，不依赖索引内容
  //（播放页的「删除缓存」在索引损坏时也给出路，不用先全清）
  FS.rmdirCalls.length = 0; FS.deleteCalls = 0
  await offline.removeBook('b1')
  ok('损坏时 removeBook 不抛', true)
  ok('该书的目录已递归删（文件清掉，不留孤儿）', FS.rmdirCalls.includes('audio/b1'), JSON.stringify(FS.rmdirCalls))
  ok('损坏串已备份到 offlineIndex.bak（原文不丢）', PREFS.get(BAK_KEY) === CORRUPT, JSON.stringify(PREFS.get(BAK_KEY)))
  ok('索引重建为 {}', idxRaw() === '{}', idxRaw())

  // 写入侧 ②：clearAll 是失败态 UI 的自救出口（「清空后重新下载」），必须能用
  setIdxRaw(CORRUPT)
  FS.sizes.clear(); FS.rmdirCalls.length = 0
  FS.sizes.set('audio/b1/001-x.mp3', 9)      // 磁盘上有别的书的文件
  await offline.clearAll()
  ok('损坏时 clearAll 不抛（自救出口可用）', true)
  ok('备份串仍是损坏原文', PREFS.get(BAK_KEY) === CORRUPT)
  ok('索引已重置为空对象 {}', idxRaw() === '{}', idxRaw())
  ok('audio 根目录已递归删（文件清光，不再孤儿）', FS.rmdirCalls.includes('audio'), JSON.stringify(FS.rmdirCalls))

  // 写入侧 ②：downloadBook 损坏时也能推进（备份 + 从空记录重建，本书全量重下）
  setIdxRaw(CORRUPT)
  FS.sizes.clear(); FS.statCalls = 0; FS.downloadCalls = 0
  const res = await offline.downloadBook({ id: 'nb', title: '新书', tracks: [
    { index: 1, title: '第1', contentUrl: '/t0.mp3' },
    { index: 2, title: '第2', contentUrl: '/t1.mp3' },
  ] })
  ok('损坏时下载照常完成（不因损坏拒绝写入）', res.ok === 2 && res.fail === 0, JSON.stringify(res))
  ok('备份串同步更新（仍是损坏原文）', PREFS.get(BAK_KEY) === CORRUPT)
  const rebuilt = JSON.parse(idxRaw())
  ok('索引重建为只含新书（旧损坏数据进了 .bak）', Object.keys(rebuilt).join() === 'nb', JSON.stringify(rebuilt))
  ok('重建后管理面恢复可用', (await offline.cachedBooks()).length === 1)
}

console.log('\n=== 3. 空索引 / 坏形状：仍是「没有缓存」，不是「读失败」===')
{
  PREFS.clear(); prefsGetThrows = false
  // 没有键 → {}（真的没缓存过）
  ok('无键 → cachedBooks 空数组', (await offline.cachedBooks()).length === 0)
  ok('无键 → cacheSize 0', await offline.cacheSize() === 0)
  // 空对象索引
  setIdxRaw('{}')
  ok('空对象 → cachedBooks 空数组', (await offline.cachedBooks()).length === 0)
  // 坏形状（数组）当空处理 —— 解析得动、只是形状不对，不算损坏
  setIdxRaw('[]')
  ok('数组形状 → 当空', (await offline.cachedBooks()).length === 0)
  ok('数组形状 → 不写 .bak', !PREFS.has(BAK_KEY))
  // 空串视同没有（与旧 getJSON 的 falsy 分支口径一致）
  setIdxRaw('')
  ok('空串 → 当空（视同没有）', (await offline.cachedBooks()).length === 0)
}

console.log('\n=== 4. downloadBook：全新书不做「下载前 stat」，只有索引记过的集才做（§4.4）===')
// 说明：下载完成后仍有**每集一次**的核对 stat（防 0 字节半截文件，设计保留）。
// 所以断言口径 = 记过的集（下载前 stat）+ 实际下载的集（下载后核对 stat）。
// 修复前（HEAD）对每一集都先 stat 一遍：全新书 5 集 = 5 次下载前 + 5 次核对 = 10 次。
{
  PREFS.clear(); FS.sizes.clear()
  FS.statCalls = 0; FS.downloadCalls = 0
  setIdxRaw('{}')
  const tracks = Array.from({ length: 5 }, (_, i) => ({ index: i + 1, title: '第' + (i + 1), contentUrl: '/t' + i + '.mp3' }))
  const res = await offline.downloadBook({ id: 'nb', title: '新书', tracks })
  ok('全部下载成功', res.ok === 5 && res.fail === 0, JSON.stringify(res))
  ok('全新书 0 次「下载前 stat」（只有 5 次下载后核对；修复前是 10 次）', FS.statCalls === 5, String(FS.statCalls))
  ok('downloadFile 5 次', FS.downloadCalls === 5, String(FS.downloadCalls))
  const idx = JSON.parse(idxRaw())
  ok('索引记全 5 集', Object.keys(idx.nb?.tracks || {}).length === 5, JSON.stringify(idx.nb?.tracks))
}
{
  // 半缓存书：索引记了第 1、2 集 → 下载前 stat 只查这 2 集；第 3、4 集直接下。
  // 文件名按真实规则 trackFile(n, title)：001-第1.mp3 …（safeName 保留中文）
  PREFS.clear(); FS.sizes.clear()
  FS.statCalls = 0; FS.downloadCalls = 0
  setIdxRaw(JSON.stringify({
    hb: { title: '半本', at: 1, bytes: 0, tracks: {
      0: { path: 'audio/hb/001-第1.mp3', size: 1234 },
      1: { path: 'audio/hb/002-第2.mp3', size: 1234 },
    } },
  }))
  FS.sizes.set('audio/hb/001-第1.mp3', 1234)   // 文件在且大小吻合 → 跳过
  FS.sizes.set('audio/hb/002-第2.mp3', 1234)
  const tracks = Array.from({ length: 4 }, (_, i) => ({ index: i + 1, title: '第' + (i + 1), contentUrl: '/t' + i + '.mp3' }))
  const res = await offline.downloadBook({ id: 'hb', title: '半本', tracks })
  ok('4 集都齐（2 跳过 + 2 新下）', res.ok === 4 && res.fail === 0, JSON.stringify(res))
  ok('stat = 2 次下载前（记过的集）+ 2 次下载后核对 = 4（修复前 6）', FS.statCalls === 4, String(FS.statCalls))
  ok('downloadFile 只补缺失的 2 集', FS.downloadCalls === 2, String(FS.downloadCalls))
  // 大小不吻合（半截文件）→ 重下
  PREFS.clear(); FS.sizes.clear()
  FS.statCalls = 0; FS.downloadCalls = 0
  setIdxRaw(JSON.stringify({
    hb: { title: '半本', at: 1, bytes: 0, tracks: { 0: { path: 'audio/hb/001-第1.mp3', size: 9999 } } },
  }))
  FS.sizes.set('audio/hb/001-第1.mp3', 1234)   // 实际大小 ≠ 索引记录 → 半截
  const res2 = await offline.downloadBook({ id: 'hb', title: '半本', tracks: [{ index: 1, title: '第1', contentUrl: '/t.mp3' }] })
  ok('半截文件被识别并重下', res2.ok === 1 && FS.downloadCalls === 1, JSON.stringify(res2) + ' dl=' + FS.downloadCalls)
  ok('半截集 stat = 1 次下载前 + 1 次核对 = 2', FS.statCalls === 2, String(FS.statCalls))
}

console.log('\n=== 5. 正常路径回归：removeBook / clearAll（不因 NF-1 改动回退）===')
{
  PREFS.clear(); FS.sizes.clear(); FS.deleteCalls = 0; FS.rmdirCalls.length = 0
  setIdxRaw(JSON.stringify({ b1: { title: '书1', at: 5, bytes: 9, tracks: { 0: { path: 'audio/b1/001-x.mp3', size: 9 } } } }))
  FS.sizes.set('audio/b1/001-x.mp3', 9)
  await offline.removeBook('b1')
  const after = JSON.parse(idxRaw())
  ok('正常删除后索引里没有 b1', !after.b1, JSON.stringify(after))
  ok('删过文件', FS.deleteCalls === 1, String(FS.deleteCalls))
  setIdxRaw(JSON.stringify({ b2: { title: '书2', at: 5, bytes: 9, tracks: { 0: { path: 'audio/b2/001-x.mp3', size: 9 } } } }))
  await offline.clearAll()
  ok('正常 clearAll 清空索引', idxRaw() === '{}', idxRaw())
  ok('正常 clearAll 删了书目录与根目录', FS.rmdirCalls.length >= 2, JSON.stringify(FS.rmdirCalls))
}

for (const f of ['.tmp-store-under-test.mjs', '.tmp-offline-under-test.mjs']) {
  try { fs.unlinkSync(path.join(ROOT, f)) } catch (_) {}
}
console.log('\n==============================================')
console.log(`结果：${pass} 通过 / ${fail} 失败`)
process.exit(fail ? 1 : 0)

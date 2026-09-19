/**
 * 多源门面（servers.js）回归 —— 老板 2026-09-14 的核心需求：
 *   「只登录 abs 时不显示 nd 的东西；两个都登录时分开显示（右上角切换）；
 *     只登录 nd 也不显示 abs 的东西」
 *
 * 这里直接驱动真代码（servers.js + api.js + navidrome.js 的类），
 * 用假网络层模拟两台服务器，断言：
 *   1. 只登录 ABS → 门面只走 ABS，任何调用都拿不到 ND 数据
 *   2. 只登录 ND  → 反向同理
 *   3. 两个都登录 → active 源决定列表内容（切换后内容整体换一套）
 *   4. **按 id 前缀分派**：即便当前激活 ABS，点 ND 的书也能正确用 ND 客户端播
 *   5. 切换器 UI：单源不渲染按钮，双源渲染
 */
import fs from 'fs'
import path from 'path'
import { fileURLToPath, pathToFileURL } from 'url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

// ---------- 假网络层：按 host 分派到 ABS / ND 两个 mock ----------
const CACHE = { abs: [], nd: [], absTracks: [], ndSongs: [] }
function fakeFetch(url, opts) {
  const u = String(url)
  const isAbs = u.includes(':13378')
  const isNd = u.includes(':4533')
  const json = (o, status = 200) => ({ status, ok: status < 300, headers: {}, data: o })
  // ⚠️ 真请求会带 ?token=... 查询串，匹配路径前必须剥掉（踩过：/api/libraries$ 永远不匹配）
  const pathOnly = String(new URL(u, 'http://x').pathname)

  if (isAbs) {
    if (pathOnly === '/status') return json({ version: '2.36.0' })
    if (pathOnly === '/login') return json({ user: { token: 'abs-token', username: 'absuser', type: 'root' } })
    if (pathOnly === '/api/libraries') return json({ libraries: [{ id: 'abs-lib', name: '有声书' }] })
    if (/^\/api\/libraries\/[^/]+\/items$/.test(pathOnly)) return json({ results: CACHE.abs })
    if (pathOnly === '/api/items/abs1') return json({ id: 'abs1', media: { metadata: { title: 'ABS 书' }, chapters: [] } })
    if (pathOnly === '/api/items/abs1/play') return json({ id: 'abs-sess', duration: 100, audioTracks: CACHE.absTracks })
    if (pathOnly === '/api/me/items-in-progress') return json({ libraryItems: CACHE.abs })
    if (pathOnly === '/api/me') return json({ username: 'absuser', mediaProgress: [] })
    if (pathOnly === '/api/collections') return json({ collections: [] })
    return json({})
  }
  if (isNd) {
    const p = pathOnly
    const okNd = body => json({ 'subsonic-response': { status: 'ok', version: '1.16.1', ...body } })
    if (p === '/rest/ping') return okNd({})
    if (p === '/rest/getUser') return okNd({ user: { username: 'nduser', adminRole: true } })
    if (p === '/rest/getMusicFolders') return okNd({ musicFolders: { musicFolder: [{ id: 'nd-lib', name: '音乐' }] } })
    if (p === '/rest/getAlbumList2') return okNd({ albumList2: { album: CACHE.nd } })
    if (p === '/rest/search3') return okNd({ searchResult3: { album: CACHE.nd } })
    if (p === '/rest/getAlbum') return okNd({ album: { ...CACHE.nd[0], song: CACHE.ndSongs } })
    if (p === '/rest/getStarred2') return okNd({ starred2: { album: [] } })
    if (p === '/rest/getBookmarks') return okNd({ bookmarks: { bookmark: [] } })
    if (p === '/rest/getUser' || p === '/rest/scrobble') return okNd({})
    return okNd({})
  }
  return json({}, 404)
}
globalThis.__MOCK_FETCH__ = fakeFetch

// ---------- 装载真代码 ----------
function loadStubbed(relPath, extra = []) {
  const src = fs.readFileSync(path.join(ROOT, relPath), 'utf8')
  let code = src
  const out = path.join(ROOT, '.tmp-' + path.basename(relPath).replace('.js', '-stub.mjs'))
  fs.writeFileSync(out, code)
  return out
}

// api.js：把内部 request 换成 mock
{
  const src = fs.readFileSync(path.join(ROOT, 'src/lib/api.js'), 'utf8')
  const code = src
    .replace(/import \{ CapacitorHttp \} from '@capacitor\/core'/, 'const CapacitorHttp = null')
    .replace(/async function request\(url, \{ method = 'GET', headers = \{\}, data, timeout = DEFAULT_TIMEOUT \} = \{\}\) \{[\s\S]*?\n\}/,
      `async function request(url, { method = 'GET', headers = {}, data, timeout } = {}) {
        const r = globalThis.__MOCK_FETCH__(url, { method, headers, data })
        return { status: r.status, ok: r.ok, headers: r.headers, _data: r.data, _native: true }
      }`)
  fs.writeFileSync(path.join(ROOT, '.tmp-api-stub.mjs'), code)
}
// navidrome.js：同上
{
  const src = fs.readFileSync(path.join(ROOT, 'src/lib/navidrome.js'), 'utf8')
  const code = src
    .replace(/import \{ CapacitorHttp \} from '@capacitor\/core'/, 'const CapacitorHttp = null')
    .replace(/import \{ md5, randomSalt \} from '\.\/md5\.js'/, `import { md5, randomSalt } from './src/lib/md5.js'`)
    .replace(/function isNativeShell\(\)[\s\S]*?\n\}/, 'function isNativeShell() { return false }')
    .replace(/const ctrl = new AbortController\(\)[\s\S]*?finally \{ clearTimeout\(timer\) \}/,
      `const r = globalThis.__MOCK_FETCH__(url, {})
       return { status: r.status, ok: r.ok, headers: {}, data: r.data }`)
  fs.writeFileSync(path.join(ROOT, '.tmp-nd-stub.mjs'), code)
}
// servers.js：换掉两个 import 与 store 桩
{
  const src = fs.readFileSync(path.join(ROOT, 'src/lib/servers.js'), 'utf8')
  const code = src
    .replace(/import \{ AbsApi, abs as absRaw \} from '\.\/api\.js'/, `import { AbsApi } from './.tmp-api-stub.mjs'\nconst absRaw = new AbsApi()`)
    .replace(/import \{ NavidromeApi \} from '\.\/navidrome\.js'/, `import { NavidromeApi } from './.tmp-nd-stub.mjs'`)
    .replace(/import \{ store, CONFIG_KEYS \} from '\.\/store\.js'/, `const mem = new Map()\nexport const __mem = mem\nconst store = {\n  async get(k, d=''){ return mem.has(k) ? mem.get(k) : d },\n  async set(k, v){ mem.set(k, String(v)) },\n  async remove(k){ mem.delete(k) },\n}\nconst CONFIG_KEYS = { server:'server', token:'token', username:'username', ndServer:'ndServer', ndUser:'ndUser', ndPassword:'ndPassword', activeSource:'activeSource', kidPin:'kidPin' }`)
  fs.writeFileSync(path.join(ROOT, '.tmp-servers-stub.mjs'), code)
}

const { hub } = await import(pathToFileURL(path.join(ROOT, '.tmp-servers-stub.mjs')).href)

// ---------- 断言 ----------
let pass = 0, failN = 0
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ✅ ${name}`) }
  else { failN++; console.log(`  ❌ ${name}${extra ? ' — ' + extra : ''}`) }
}

CACHE.abs = [{ id: 'abs1', media: { metadata: { title: 'ABS 书' }, duration: 100 } }]
CACHE.absTracks = [{ index: 1, startOffset: 0, duration: 100, contentUrl: '/api/items/abs1/file/1', title: 'ABS 集1' }]
CACHE.nd = [{ id: 'ndalb', name: 'ND 专辑', artist: 'ND 歌手', songCount: 2, duration: 200 }]
CACHE.ndSongs = [
  { id: 'nds1', albumId: 'ndalb', title: 'ND 歌1', duration: 100, track: 1, contentType: 'audio/mpeg' },
  { id: 'nds2', albumId: 'ndalb', title: 'ND 歌2', duration: 100, track: 2, contentType: 'audio/mpeg' },
]

console.log('\n=== 1. 只登录 ABS：绝不能出现 ND 的东西 ===')
{
  await hub.loginAbs('http://127.0.0.1:13378', 'absuser', 'pw')
  ok('available = [abs]', hub.available.join() === 'abs', hub.available.join())
  ok('multi = false（切换器不显示）', hub.multi === false)
  const items = await hub.getLibraryItems('abs-lib', {})
  ok('书架只出 ABS 的书', items.results.length === 1 && items.results[0].id === 'abs1', JSON.stringify(items.results.map(r => r.id)))
  ok('库里没有任何 nd: 前缀条目', !items.results.some(r => String(r.id).startsWith('nd:')))
  const libs = await hub.libraries()
  ok('库列表 = ABS 库', libs[0].id === 'abs-lib', JSON.stringify(libs))
}

console.log('\n=== 2. 再登录 ND：两台都在，active 决定显示谁 ===')
{
  await hub.loginNd('http://127.0.0.1:4533', 'nduser', 'pw')
  ok('available = [abs, nd]', hub.available.join() === 'abs,nd', hub.available.join())
  ok('multi = true（切换按钮出现）', hub.multi === true)
  // 登录 ND 时若 ABS 已在，保持 ABS 激活（不打断当前浏览）
  ok('保持 ABS 激活', hub.active === 'abs', hub.active)
  const absItems = await hub.getLibraryItems('abs-lib', {})
  ok('ABS 激活 → 书架是 ABS 的书', absItems.results[0].id === 'abs1', JSON.stringify(absItems.results.map(r => r.id)))

  // 切到 ND
  await hub.setActivePersist('nd')
  ok('切换后 active = nd', hub.active === 'nd', hub.active)
  const ndItems = await hub.getLibraryItems('nd-lib', {})
  ok('ND 激活 → 书架是 ND 的专辑', ndItems.results.length === 1 && ndItems.results[0].id === 'nd:ndalb',
     JSON.stringify(ndItems.results.map(r => r.id)))
  ok('ND 结果带 nd: 前缀（与 ABS 隔离）', ndItems.results.every(r => String(r.id).startsWith('nd:')))
  const ndLibs = await hub.libraries()
  ok('库列表整体换成 ND 的库', ndLibs[0].id === 'nd-lib', JSON.stringify(ndLibs))
  const ndProg = await hub.itemsInProgress()
  // ⚠️ 门面统一返回**数组**（2026-09-19 修：ND 客户端原本返回 {libraryItems} 对象，
  //    调用方 .map() 抛错被吞 → ND 继续听/历史永远空白）。
  ok('itemsInProgress 统一返回数组（形状与 ABS 一致）', Array.isArray(ndProg),
     JSON.stringify(v => v))
  ok('继续听也只出 ND 的（分开显示，不混合）',
     (ndProg || []).every(i => String(i.id).startsWith('nd:')),
     JSON.stringify((ndProg || []).map(i => i.id)))
}

console.log('\n=== 3. 按 id 前缀分派：激活源 ≠ 条目源 也能正确路由 ===')
{
  await hub.setActivePersist('nd')   // 当前看 ND
  // 但要播一本 ABS 的书（比如从历史/收藏点进来）→ 必须用 ABS 客户端
  const a = await hub.startPlayback('abs1', 0)
  ok('ABS 条目用 ABS 会话（sessionId 无 nd: 前缀）', String(a.sessionId) === 'abs-sess', a.sessionId)
  const n = await hub.startPlayback('nd:ndalb', 0)
  ok('ND 条目用 ND 会话（sessionId 带 nd:）', String(n.sessionId).startsWith('nd:'), n.sessionId)

  // 封面直链指向各自服务器
  const ac = hub.coverUrl('abs1')
  const nc = hub.coverUrl('nd:ndalb')
  ok('ABS 封面指向 ABS 服务器', ac.includes(':13378'), ac)
  ok('ND 封面指向 ND 服务器且带凭据', nc.includes(':4533') && nc.includes('/rest/getCoverArt') && /t=[0-9a-f]{32}/.test(nc), nc)

  // 音频直链
  const au = hub.trackUrl('/api/items/abs1/file/1', 'abs1')
  const nu = hub.trackUrl('/rest/stream?id=nds1', 'nd:ndalb')
  ok('ABS 音轨 URL 指向 ABS', au.includes(':13378') && au.includes('/api/items/'), au)
  ok('ND 音轨 URL 指向 ND 且带凭据', nu.includes(':4533') && nu.includes('/rest/stream') && /t=[0-9a-f]{32}/.test(nu), nu)
  // 转码参数（老板 2026-09-14 方案 A）：iOS 原生播放器吃不下 raw FLAC，统一让 ND 转 mp3@320
  ok('ND 流带服务端转码参数 format=mp3&maxBitRate=320', nu.includes('format=mp3') && nu.includes('maxBitRate=320'), nu)
  // 下载/缓存走同一 streamUrl，不能漏掉转码参数（否则离线文件也是 raw FLAC → 播不出）
  const ndl = hub.downloadUrl('nd:ndalb', '/rest/stream?id=nds1')
  ok('ND 下载直链也带转码参数', ndl.includes('format=mp3') && ndl.includes('maxBitRate=320'), ndl)

  // 鉴权头：ABS 要 Bearer，ND 走 URL（空头）
  ok('ABS 带 Bearer 头', !!hub.authHeaders('abs1').Authorization)
  ok('ND 不带 header（凭据在 URL）', Object.keys(hub.authHeaders('nd:ndalb')).length === 0)
}

console.log('\n=== 4. 断掉一台：另一台照常用，切换器消失 ===')
{
  await hub.logout('abs')
  ok('只剩 ND', hub.available.join() === 'nd', hub.available.join())
  ok('active 自动落到 nd', hub.active === 'nd', hub.active)
  ok('multi=false（切换器消失）', hub.multi === false)
  const items = await hub.getLibraryItems('nd-lib', {})
  ok('只剩 ND 时书架只有 ND 的', items.results.every(r => String(r.id).startsWith('nd:')))
  // 再断 ND
  await hub.logout('nd')
  ok('都断开 → available 空', hub.available.length === 0, JSON.stringify(hub.available))
}

console.log('\n=== 5. 重启恢复（store 落盘 → restore）===')
{
  // 重新登录（logout 用例把状态清了）
  await hub.loginAbs('http://127.0.0.1:13378', 'absuser', 'pw')
  await hub.loginNd('http://127.0.0.1:4533', 'nduser', 'pw')
  await hub.setActivePersist('nd')
  // 模拟重启：直接用新实例（不重新 import，避免模块缓存共享 store）
  const mod2 = await import(pathToFileURL(path.join(ROOT, '.tmp-servers-stub.mjs')).href)
  const h2 = new mod2.ServerHub()
  const avail2 = await h2.restore()
  ok('恢复出两台服务器', avail2.join() === 'abs,nd', avail2.join())
  ok('恢复上次的激活源 = nd', h2.active === 'nd', h2.active)
  ok('ND 凭据恢复成功（能发请求）', await h2.nd.libraries().then(l => l[0].id === 'nd-lib').catch(() => false))
}

for (const f of ['.tmp-api-stub.mjs', '.tmp-nd-stub.mjs', '.tmp-servers-stub.mjs', '.tmp-api-stub.mjs']) {
  try { fs.unlinkSync(path.join(ROOT, f)) } catch (_) {}
}
console.log('\n==============================================')
console.log(`结果：${pass} 通过 / ${failN} 失败`)
process.exit(failN ? 1 : 0)

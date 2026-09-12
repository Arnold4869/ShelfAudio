/**
 * 对真实 ABS 服务器做端到端联调（Node 跑，不需要设备）
 * 验证：登录 → 库 → 书目 → 播放会话 → 音轨直链(Range) → 进度同步 → 关闭
 *       + 章节↔音轨时间轴换算 + 语音指令解析
 *
 * 用法：node scripts/e2e-abs.mjs [serverUrl] [user] [pass]
 */
import { AbsApi } from '../src/lib/api.js'
import { parseCommand } from '../src/lib/voice.js'

const BASE = process.argv[2] || 'http://127.0.0.1:18080'
const USER = process.argv[3] || 'user'
const PASS = process.argv[4] || 'password'

let pass = 0, fail = 0
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ✅ ${name}${extra ? ' — ' + extra : ''}`) }
  else { fail++; console.log(`  ❌ ${name}${extra ? ' — ' + extra : ''}`) }
}

const api = new AbsApi()

console.log('=== 1. 服务器探活 ===')
const st = await AbsApi.serverStatus(BASE)
ok('serverStatus', st?.serverVersion, 'ABS ' + st?.serverVersion)

console.log('\n=== 2. 登录 ===')
const u = await api.login(BASE, USER, PASS)
ok('login', !!u?.token, `用户 ${u.username}`)
ok('token 已保存', api.ready)

console.log('\n=== 3. 用户信息 ===')
const me = await api.me()
ok('me()', me?.id === u.id, `权限 download=${me?.permissions?.download}`)

console.log('\n=== 4. 库与书目 ===')
const libs = await api.libraries()
ok('libraries()', libs.length > 0, `${libs.length} 个库: ` + libs.map(l => l.name).join(', '))
const lib = libs[0]
const page = await api.getLibraryItems(lib.id, { limit: 100, sort: 'media.metadata.title' })
ok('getLibraryItems()', page.total > 0, `${page.total} 本`)
const item = page.results[0]
ok('书目有标题', !!item.media?.metadata?.title, item.media.metadata.title)

console.log('\n=== 5. 书目详情 + 章节/音轨 ===')
const detail = await api.getItem(item.id)
const files = detail.media?.audioFiles || []
const chapters = detail.media?.chapters || []
ok('audioFiles', files.length > 0, `${files.length} 个音频文件`)
ok('chapters', chapters.length > 0, `${chapters.length} 个章节`)
ok('章节与音轨一一对应', chapters.length === files.length,
   `${chapters.length} vs ${files.length}`)
// 关键：章节 start 应等于音轨累计起点
let cum = 0, mismatch = 0
for (let i = 0; i < Math.min(files.length, chapters.length); i++) {
  if (Math.abs((chapters[i].start || 0) - cum) > 0.05) mismatch++
  cum += files[i].duration || 0
}
ok('章节 start == 累计音轨时长', mismatch === 0, mismatch ? `${mismatch} 处不符` : '全部对齐')

console.log('\n=== 6. 封面直链 ===')
// 有些书没有封面（coverPath 为 null），挑一本有的来验证接口本身可用
let withCover = null
for (const it of page.results.slice(0, 12)) {
  const d = await api.getItem(it.id)
  if (d.media?.coverPath) { withCover = it; break }
}
if (withCover) {
  const cr = await fetch(api.coverUrl(withCover.id, { width: 400 }))
  ok('有封面的书可取图', cr.ok, `HTTP ${cr.status} ${cr.headers.get('content-type')} ${cr.headers.get('content-length')}B — ${withCover.media.metadata.title}`)
} else {
  ok('有封面的书可取图', false, '前 12 本都没有封面，无法验证')
}
// 没有封面的书应返回 404（UI 靠 onerror 显示占位符，这是预期行为）
const noCover = (await api.getItem(item.id)).media?.coverPath ? null : item
if (noCover) {
  const cr2 = await fetch(api.coverUrl(noCover.id, { width: 400 }))
  ok('无封面书返回 404（UI 有占位兜底）', cr2.status === 404, `HTTP ${cr2.status}`)
}

console.log('\n=== 7. 播放会话 ===')
const { sessionId, tracks, duration } = await api.startPlayback(item.id, 0)
ok('startPlayback', !!sessionId, `session=${sessionId}`)
ok('返回音轨', tracks.length > 0, `${tracks.length} 条`)
ok('音轨有 startOffset', tracks.every(t => typeof t.startOffset === 'number'),
   `tracks[0].startOffset=${tracks[0].startOffset}, tracks[1].startOffset=${tracks[1].startOffset}`)
ok('总时长合理', duration > 0, `${(duration / 60).toFixed(1)} 分钟`)

console.log('\n=== 8. 音频直链（Range 流式，播放器实际用法）===')
const url = api.trackUrl(tracks[0].contentUrl)
const r1 = await fetch(url, { headers: { ...api.authHeaders(), Range: 'bytes=0-1023' } })
ok('Range 请求返回 206', r1.status === 206, `HTTP ${r1.status}, type=${r1.headers.get('content-type')}`)
const buf = await r1.arrayBuffer()
ok('确实拿到数据', buf.byteLength > 0, `${buf.byteLength} 字节`)

console.log('\n=== 9. 用 ?token= 走 URL 鉴权（原生播放器 fallback）===')
const r2 = await fetch(url)   // trackUrl 已带 token
ok('URL token 可用', r2.status === 200 || r2.status === 206, `HTTP ${r2.status}`)

console.log('\n=== 10. 进度同步链路 ===')
await api.syncSession(sessionId, 42.5, 10, duration)
const me2 = await api.me()
const prog = (me2.mediaProgress || []).find(p => (p.extraData?.libraryItemId === item.id) || p.mediaItemId === detail.media.id)
ok('sync 后进度已写入', !!prog, prog ? `currentTime=${prog.currentTime?.toFixed(1)}s` : '未找到')
if (prog) ok('currentTime 正确', Math.abs(prog.currentTime - 42.5) < 1, `${prog.currentTime}`)
await api.closeSession(sessionId, 45, 1, duration)
ok('closeSession', true)

console.log('\n=== 11. 继续听 ===')
const ip = await api.itemsInProgress()
ok('itemsInProgress', Array.isArray(ip), `${ip.length} 本`)

console.log('\n=== 12. 搜索 ===')
const found = await api.searchAll(libs, '猴子')
ok('searchAll 中文搜索', found.length > 0, `命中 ${found.length} 本: ` + found.slice(0, 3).map(x => x.media?.metadata?.title).join(' / '))

console.log('\n=== 13. 书级时间轴换算（播放器核心算法）===')
// 模拟播放器：bookTime <-> fileTime
function trackIndexForBookTime(tracks, bookTime) {
  for (let i = tracks.length - 1; i >= 0; i--) {
    if (bookTime >= (tracks[i].startOffset || 0) - 0.001) return i
  }
  return 0
}
const t0 = tracks[0], t1 = tracks[1]
ok('bookTime=0 → 第 1 条', trackIndexForBookTime(tracks, 0) === 0)
ok('bookTime=tracks[1].startOffset → 第 2 条', trackIndexForBookTime(tracks, t1.startOffset) === 1)
ok('bookTime=tracks[1].startOffset+5 → 第 2 条', trackIndexForBookTime(tracks, t1.startOffset + 5) === 1)
ok('bookTime 未越界', trackIndexForBookTime(tracks, duration + 100) === tracks.length - 1)
const fileTime = 10 - (t0.startOffset || 0)
ok('fileTime = bookTime - startOffset', fileTime === 10, `${fileTime}`)

console.log('\n=== 14. 语音指令解析 ===')
const cases = [
  ['暂停', 'pause'], ['停一下', 'pause'],
  ['下一集', 'next'], ['跳过', 'next'],
  ['上一集', 'prev'],
  ['继续播放', 'play'],
  ['大声点', 'louder'], ['小声一点', 'quieter'],
  ['一点五倍', 'rate'], ['两倍速', 'rate'],
  ['三十分钟后关闭', 'sleep'],
  ['我要听示例故事甲', 'search'], ['找一下示例故事乙', 'search'],
]
for (const [text, expect] of cases) {
  const got = parseCommand(text)
  ok(`"${text}" → ${expect}`, got.intent === expect, `实际 ${got.intent}`)
}
const q = parseCommand('我要听示例故事甲')
ok('搜索词已剥离动词', q.query === '示例故事甲', `query="${q.query}"`)
const rt = parseCommand('一点五倍')
ok('"一点五倍" 解析为 1.5', rt.rate === 1.5, `rate=${rt.rate}`)
const sl = parseCommand('三十分钟后关闭')
ok('"三十分钟后关闭" = 30 分钟', sl.minutes === 30, `minutes=${sl.minutes}`)

console.log(`\n${'='.repeat(46)}`)
console.log(`结果：${pass} 通过 / ${fail} 失败`)
process.exit(fail ? 1 : 0)

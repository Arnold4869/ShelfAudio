/**
 * 播放器音轨互斥测试（回归防护）
 *
 * 背景：这个 bug 反复出现过 —— 选新集后旧集还在响（两个声音叠加）。
 * 根因是 @capgo/capacitor-native-audio 里 **每个 assetId 是独立的原生播放器实例**，
 * 切集时只 preload 新的、不停旧的，旧的自然继续出声。
 *
 * 本测试用假的原生插件替身，直接驱动 BookPlayer 的真实代码，
 * 断言"任意时刻最多只有一条音轨处于 playing 状态"。
 *
 * 做法：把 src/lib/player.js 源码里的插件 import 替换成替身，
 * 写到临时文件后 import —— 这样测的是真代码，不是复刻的逻辑。
 *
 * 用法: node scripts/test-player-mutex.mjs
 */
import fs from 'fs'
import path from 'path'
import { fileURLToPath, pathToFileURL } from 'url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SRC = fs.readFileSync(path.join(ROOT, 'src/lib/player.js'), 'utf8')

// ---------- 假的原生插件 ----------
const state = {
  assets: new Map(),   // assetId -> { playing, time }
  events: {},          // name -> [cb]
  calls: [],           // 调用流水，便于定位顺序问题
}
const playingSet = () => [...state.assets.entries()].filter(([, a]) => a.playing).map(([id]) => id)

const FakeAudio = {
  async configure(o) { state.calls.push(['configure', o?.background]) },
  async addListener(name, cb) { (state.events[name] ||= []).push(cb); return { remove() {} } },
  async preload({ assetId, volume }) {
    state.calls.push(['preload', assetId])
    // ⚠️ 忠于真实插件（NativeAudio.preloadAsset）：
    //     assetId 已存在时直接 reject ERROR_AUDIO_EXISTS，不是覆盖！
    //     真实代码见 node_modules/@capgo/capacitor-native-audio/.../NativeAudio.java
    //     if (audioAssetList.containsKey(audioId)) { call.reject(ERROR_AUDIO_EXISTS ...) }
    if (state.assets.has(assetId)) throw new Error('audio asset already exists - ' + assetId)
    state.assets.set(assetId, { playing: false, time: 0, volume: volume ?? 1 })
  },
  // 忠于真实插件：play 的 volume 默认 1.0，且 Android playInternal 会无条件
  // player.setVolume(volume)（不传 = 打回 100%）。这是「音量每次开播被重置」bug 的根，
  // 假插件必须复刻这个行为，回归断言才有意义。
  async play({ assetId, time, volume }) {
    state.calls.push(['play', assetId, time, volume])
    const a = state.assets.get(assetId)
    if (!a) throw new Error('asset 未 preload: ' + assetId)
    a.playing = true
    a.time = time || 0
    a.volume = volume ?? 1
  },
  async pause({ assetId }) { const a = state.assets.get(assetId); if (a) a.playing = false },
  async resume({ assetId }) { const a = state.assets.get(assetId); if (a) a.playing = true },
  async stop({ assetId }) { state.calls.push(['stop', assetId]); const a = state.assets.get(assetId); if (a) a.playing = false },
  async unload({ assetId }) { state.calls.push(['unload', assetId]); state.assets.delete(assetId) },
  async setCurrentTime({ assetId, time }) { const a = state.assets.get(assetId); if (a) a.time = time; state.calls.push(['setTime', assetId, time]) },
  async setRate() {},
  async setVolume({ assetId, volume }) { state.calls.push(['setVolume', assetId, volume]); const a = state.assets.get(assetId); if (a) a.volume = volume },
  async getCurrentTime({ assetId }) { return { currentTime: state.assets.get(assetId)?.time ?? 0 } },
  async clearCache() { state.calls.push(['clearCache']); state.cacheCleared = true },
}

// ---------- 用替身跑真实 src/lib/player.js ----------
const stubPath = path.join(ROOT, '.tmp-player-under-test.mjs')
let code = SRC
  .replace(/import \{ NativeAudio \} from '@capgo\/capacitor-native-audio'/, 'const NativeAudio = globalThis.__FAKE_AUDIO__')
  .replace(/import \{ registerPlugin \} from '@capacitor\/core'/, 'const registerPlugin = () => ({ start: async () => {}, stop: async () => {} })')
  .replace(/import \{ abs \} from '\.\/api\.js'/, 'const abs = globalThis.__FAKE_ABS__')
  // 家长音量上限是动态 import('./parental.js')（懒加载），替身也换成可控桩
  .replace(/import\('\.\/parental\.js'\)/g, 'import(globalThis.__PARENTAL_URL__)')
fs.writeFileSync(stubPath, code)

// parental.js 桩：store 由内存 Map 代替，cap 可在用例里现场改
{
  const mem = new Map()
  globalThis.__SA_TEST_STORE__ = mem
  const stub = `
const mem = globalThis.__SA_TEST_STORE__
export const store = {
  async get(k, d = '') { return mem.has(k) ? mem.get(k) : d },
  async set(k, v) { mem.set(k, String(v)) },
}
export const CONFIG_KEYS = { volumeCap: 'volumeCap' }
export async function volumeCap() {
  const v = Number(mem.get('volumeCap') ?? '1')
  return Number.isFinite(v) && v >= 0.1 && v <= 1 ? v : 1
}
export function volumeCapLabel(cap) {
  const pct = Math.round((Number.isFinite(cap) ? cap : 1) * 100)
  return pct >= 100 ? '不限制' : '最高 ' + pct + '%'
}
export const VOLUME_CAP_MIN = 0.1, VOLUME_CAP_MAX = 1
export async function timeWindowEnabled() { return false }
export async function dailyLimitEnabled() { return false }
export async function hasTimeWindowConfig() { return false }
`
  const p = path.join(ROOT, '.tmp-parental-stub.mjs')
  fs.writeFileSync(p, stub)
  globalThis.__PARENTAL_URL__ = pathToFileURL(p).href
}

globalThis.__FAKE_AUDIO__ = FakeAudio
globalThis.__FAKE_ABS__ = null
globalThis.window = {
  Capacitor: { isNativePlatform: () => true, getPlatform: () => 'ios' },
  dispatchEvent() {},
}

const { BookPlayer } = await import(pathToFileURL(stubPath).href)

// ---------- 三集的小书 ----------
const tracks = [
  { index: 1, startOffset: 0,   duration: 300, url: 'u0', headers: {} },
  { index: 2, startOffset: 300, duration: 300, url: 'u1', headers: {} },
  { index: 3, startOffset: 600, duration: 300, url: 'u2', headers: {} },
]

let pass = 0, fail = 0
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ✅ ${name}`) }
  else { fail++; console.log(`  ❌ ${name}${extra ? ' — ' + extra : ''}`) }
}

console.log('\n=== 1. 顺序播放：每次换集后只应有一个音轨在播 ===')
{
  const p = new BookPlayer({})
  p._watchdogMs = 500
  await p.load({ itemId: 'x', tracks, sessionId: 's', duration: 900, startBookTime: 0 })
  await p.play()
  ok('第1集在播', playingSet().join() === 'sa-0', `实际=${playingSet()}`)

  await p.nextTrack()
  ok('切到第2集后只剩 1 个在播', playingSet().length === 1, `实际=${playingSet()}`)
  ok('且在播的是第2集', playingSet().join() === 'sa-1', `实际=${playingSet()}`)

  await p.nextTrack()
  ok('切到第3集后只剩 1 个在播', playingSet().length === 1, `实际=${playingSet()}`)
  ok('且在播的是第3集', playingSet().join() === 'sa-2', `实际=${playingSet()}`)

  ok('原生层只保留 1 条音轨（旧的已 unload）', state.assets.size === 1, `实际=${[...state.assets.keys()]}`)
  await p.stop()
  fs.unlinkSync(stubPath)
}

console.log('\n=== 2. 直接点选任意集（章节跳转路径）===')
{
  state.assets.clear(); state.calls.length = 0
  const p = new BookPlayer({})
  p._watchdogMs = 500
  await p.load({ itemId: 'x', tracks, sessionId: 's', duration: 900, startBookTime: 0 })
  await p.play()
  ok('起始第1集在播', playingSet().join() === 'sa-0')

  // 点第3集 = seek 到全书 600s
  await p.seek(600)
  ok('跳到第3集后只剩 1 个在播', playingSet().length === 1, `实际=${playingSet()}`)
  ok('在播的是第3集', playingSet().join() === 'sa-2', `实际=${playingSet()}`)
  ok('位置落在该集内（600-600=0）', state.assets.get('sa-2')?.time === 0, `time=${state.assets.get('sa-2')?.time}`)

  // 再点回第1集
  await p.seek(0)
  ok('跳回第1集后只剩 1 个在播', playingSet().length === 1, `实际=${playingSet()}`)
  ok('在播的是第1集', playingSet().join() === 'sa-0', `实际=${playingSet()}`)

  // 顺序保证：play 新集之前必须先 stop 旧集
  const iPlay2 = state.calls.findIndex(c => c[0] === 'play' && c[1] === 'sa-2')
  const iStop0 = state.calls.findIndex(c => c[0] === 'stop' && c[1] === 'sa-0')
  ok('先 stop 旧集、再 play 新集', iStop0 >= 0 && iStop0 < iPlay2, `stop@${iStop0} play@${iPlay2}`)
  await p.stop()
}

console.log('\n=== 3. 暂停态换集不应出声 ===')
{
  state.assets.clear(); state.calls.length = 0
  const p = new BookPlayer({})
  p._watchdogMs = 500
  await p.load({ itemId: 'x', tracks, sessionId: 's', duration: 900, startBookTime: 0 })
  await p.play()
  await p.pause()
  ok('暂停后无音轨在播', playingSet().length === 0, `实际=${playingSet()}`)
  await p.seek(600)
  ok('暂停态换集后仍无音轨在播', playingSet().length === 0, `实际=${playingSet()}`)
  ok('位置已就位到第3集', state.assets.get('sa-2')?.time === 0)
  await p.stop()
}

console.log('\n=== 4. 旧音轨的延迟 complete 事件不应推进新集 ===')
{
  state.assets.clear()
  // 用 4 集的书：如果误把旧集的 complete 当成本集播完，
  // 会从第2集被推进到第3集 —— 用 3 集时停在末集推进不了，测不出这个 bug。
  const four = [
    { index: 1, startOffset: 0,   duration: 300, url: 'u0', headers: {} },
    { index: 2, startOffset: 300, duration: 300, url: 'u1', headers: {} },
    { index: 3, startOffset: 600, duration: 300, url: 'u2', headers: {} },
    { index: 4, startOffset: 900, duration: 300, url: 'u3', headers: {} },
  ]
  const p = new BookPlayer({})
  await p.load({ itemId: 'x', tracks: four, sessionId: 's', duration: 1200, startBookTime: 0 })
  await p.play()
  await p.seek(300)                       // 跳到第2集
  ok('当前是第2集(idx=1)', p.trackIndex === 1, `实际=${p.trackIndex}`)
  // 模拟第1集被停掉后迟到的 complete（不该被当成本集播完）
  await p._onTrackEnd({ assetId: 'sa-0' })
  ok('旧集的 complete 被忽略，仍是第2集', p.trackIndex === 1, `实际=${p.trackIndex}`)

  // 反向校验：本集自己的 complete 必须正常推进
  await p._onTrackEnd({ assetId: 'sa-1' })
  ok('本集的 complete 正常推进到第3集', p.trackIndex === 2, `实际=${p.trackIndex}`)
  ok('推进后仍只有 1 条音轨在播', playingSet().length === 1, `实际=${playingSet()}`)
  await p.stop()
}

console.log('\n=== 5. 音轨下标与 assetId 的映射（1-based index 陷阱）===')
{
  state.assets.clear()
  const p = new BookPlayer({})
  p._watchdogMs = 500
  await p.load({ itemId: 'x', tracks, sessionId: 's', duration: 900, startBookTime: 0 })
  await p.play()
  // ABS 的 track.index 是 1-based；assetId 必须用数组下标
  ok('下标0 → sa-0（不是 sa-1）', p._assetId(0) === 'sa-0')
  ok('下标2 → sa-2（t.index 是 3）', p._assetId(2) === 'sa-2')
  await p.nextTrack(); await p.nextTrack()
  ok('连按两次下一集到第3集', p.trackIndex === 2, `实际=${p.trackIndex}`)
  ok('只装载了 1 条音轨', state.assets.size === 1, `实际=${[...state.assets.keys()]}`)
  await p.stop()
  ok('stop 后原生层清空', state.assets.size === 0, `实际=${[...state.assets.keys()]}`)
}

console.log('\n=== 6. 恢复进度"结尾贴齐"（防"一回来就到集尾"）===')
{
  state.assets.clear(); state.calls.length = 0
  const p = new BookPlayer({})
  // 进度停在 297s：第1集（0~300s）的最后 3 秒
  await p.load({ itemId: 'x', tracks, sessionId: 's', duration: 900, startBookTime: 297 })
  ok('恢复时贴齐到下一集开头（load 路径）',
     p.trackIndex === 1 && Math.abs(p.currentBookTime - 300) < 0.01,
     `trackIndex=${p.trackIndex} bookTime=${p.currentBookTime}`)
  ok('原生层装载的是第2集', state.assets.has('sa-1') && !state.assets.has('sa-0'))
  await p.stop()
}
console.log('\n=== 7. 恢复位置在集中间 → 忠实定位，不贴齐 ===')
{
  state.assets.clear()
  const p = new BookPlayer({})
  await p.load({ itemId: 'x', tracks, sessionId: 's', duration: 900, startBookTime: 150 })
  ok('中间位置不贴齐', p.trackIndex === 0 && Math.abs(p.currentBookTime - 150) < 0.01,
     `trackIndex=${p.trackIndex} bookTime=${p.currentBookTime}`)
  await p.stop()
}
console.log('\n=== 8. 恢复位置在最后一集末尾（无下一集）→ 不贴齐 ===')
{
  state.assets.clear()
  const p = new BookPlayer({})
  await p.load({ itemId: 'x', tracks, sessionId: 's', duration: 900, startBookTime: 898 })
  ok('最后一集末尾保持原位（跳到开头交还用户处理）',
     p.trackIndex === 2 && Math.abs(p.currentBookTime - 898) < 0.01,
     `trackIndex=${p.trackIndex} bookTime=${p.currentBookTime}`)
  await p.stop()
}

console.log('\n=== 9. App 被杀后重开：原生层残留 asset（preload 撞车）===')
{
  state.assets.clear(); state.calls.length = 0
  // 模拟被杀现场：原生层还留着上次播放的 sa-0 / sa-1（前台服务保活进程）
  state.assets.set('sa-0', { playing: false, time: 175 })
  state.assets.set('sa-1', { playing: false, time: 0 })
  const p = new BookPlayer({})
  // 恢复「继续听第一本」：load 不应被 preload 拒绝卡死
  let loadErr = null
  try {
    await p.load({ itemId: 'x', tracks, sessionId: 's', duration: 900, startBookTime: 150 })
    await p.play()
  } catch (e) { loadErr = e }
  ok('恢复播放不因残留 asset 失败', loadErr === null, String(loadErr))
  ok('残留 asset 已被替换为新实例',
     state.assets.get('sa-0')?.playing === true,
     `sa-0.playing=${state.assets.get('sa-0')?.playing}`)
  ok('同时只有一条在播', playingSet().length === 1, playingSet().join(','))
  await p.stop()
}

console.log('\n=== 10. 启动看门狗：play 后从未出声（缓存损坏卡死）→ 清缓存自愈 ===')
{
  state.assets.clear(); state.calls.length = 0; state.cacheCleared = false
  const p = new BookPlayer({})
  p._watchdogMs = 500   // 测试注入：500ms 触发，不用真等 12s
  await p.load({ itemId: 'x', tracks, sessionId: 's', duration: 900, startBookTime: 150 })
  // 替身里 asset 永远不发 currentTime（模拟坏缓存卡死）
  await p.play()
  ok('看门狗定时器已布防', p._startWatchdog !== null)
  await new Promise(r => setTimeout(r, 1400))   // 500ms 触发 + 自愈余量
  ok('看门狗触发：调用了 clearCache', state.cacheCleared === true,
     `cacheCleared=${state.cacheCleared}`)
  ok('看门狗自愈后重新 preload+play',
     state.calls.filter(c => c[0] === 'preload').length >= 2 &&
     state.calls.filter(c => c[0] === 'play').length >= 2,
     JSON.stringify(state.calls.filter(c => c[0]==='preload'||c[0]==='play'||c[0]==='clearCache')))
  ok('自愈后仍处播放意图', p._wantPlaying === true)
  await p.stop()
}

console.log('\n=== 11. 看门狗不误伤：正常播放（有 currentTime 事件）不触发 ===')
{
  state.assets.clear(); state.calls.length = 0; state.cacheCleared = false
  const p = new BookPlayer({})
  p._watchdogMs = 500
  await p.init()   // 必须先 init：currentTime 监听器是在 init() 里注册的
  await p.load({ itemId: 'x', tracks, sessionId: 's', duration: 900, startBookTime: 0 })
  await p.play()
  ok('currentTime 监听器已注册（否则本测试无效）',
     (state.events['currentTime'] || []).length > 0,
     `listeners=${(state.events['currentTime']||[]).length}`)
  // 模拟正常播放：原生按秒发 currentTime
  const tick = setInterval(() => {
    for (const cb of (state.events['currentTime']||[]))
      cb({ assetId: 'sa-' + p.trackIndex, currentTime: (state.assets.get('sa-'+p.trackIndex)?.time||0) + 1, duration: 300 })
  }, 200)
  await new Promise(r => setTimeout(r, 1400))
  clearInterval(tick)
  ok('正常播放看门狗不触发（没清缓存）', state.cacheCleared === false,
     `cacheCleared=${state.cacheCleared}`)
  await p.stop()
}

console.log('\n=== 10. 恢复落点合法性（播放路径审计加固）===')
{
  state.assets.clear(); state.calls.length = 0
  const p = new BookPlayer({})
  // 场景 A：进度等于总时长 900（坏数据）→ 应归零从头播
  await p.load({ itemId: 'x', tracks, sessionId: 's', startBookTime: 900 })
  ok('进度=总时长 → 归零', p.trackIndex === 0 && p.currentBookTime === 0,
     `idx=${p.trackIndex} t=${p.currentBookTime}`)
  // 场景 B：进度超总时长
  await p.load({ itemId: 'x', tracks, sessionId: 's', startBookTime: 99999 })
  ok('进度≫总时长 → 归零', p.trackIndex === 0 && p.currentBookTime === 0)
  // 场景 C：NaN
  await p.load({ itemId: 'x', tracks, sessionId: 's', startBookTime: NaN })
  ok('NaN 进度 → 归零', p.trackIndex === 0 && p.currentBookTime === 0)
  // 场景 D：负数
  await p.load({ itemId: 'x', tracks, sessionId: 's', startBookTime: -50 })
  ok('负数进度 → 归零', p.trackIndex === 0 && p.currentBookTime === 0)
  // 场景 E：正常中间进度不受影响
  await p.load({ itemId: 'x', tracks, sessionId: 's', startBookTime: 350 })
  ok('正常进度 350s → 轨2中部', p.trackIndex === 1, `idx=${p.trackIndex} t=${p.currentBookTime}`)
  // 场景 F：落在轨尾 5s 内仍有下一轨 → 贴齐下一集（回归）
  await p.load({ itemId: 'x', tracks, sessionId: 's', startBookTime: 597 })
  ok('轨尾5s内 → 贴齐下一集开头', p.trackIndex === 2 && p.currentBookTime === 600,
     `idx=${p.trackIndex} t=${p.currentBookTime}`)
}

console.log('\n=== 12. 选集后自动播放（老板 2026-09-13：点选一集不自动播）===')
{
  state.assets.clear(); state.calls.length = 0
  const p = new BookPlayer({})
  await p.init()
  await p.load({ itemId: 'x', tracks, sessionId: 's', duration: 900, startBookTime: 0 })

  // 场景 1：正在播放时选另一集 → 应继续播放
  await p.play()
  // 选集弹窗的真实调用：p.seek(start, { autoPlay: true })（见 views/player.js）
  await p.seek(600, { autoPlay: true })   // 跳到第 3 集
  ok('播放中选集 → 继续播放', p.playing === true)

  // 场景 2：暂停状态选另一集 → 应自动开始播放（这次要修的行为）
  await p.pause()
  ok('已暂停（前置条件）', p.playing === false)
  await p.seek(0, { autoPlay: true })      // 跳回第 1 集
  ok('暂停态选集 → 自动开播', p.playing === true)

  // 场景 3：进度条拖拽（不传 autoPlay）→ 暂停态拖拽仍保持暂停
  await p.pause()
  await p.seek(300)
  ok('暂停态拖进度条 → 仍暂停（不误伤）', p.playing === false)
  await p.stop()
}

console.log('\n=== 13. stop() 只卸载装载过的 asset（不随轨数线性膨胀）===')
{
  state.assets.clear(); state.calls.length = 0
  const p = new BookPlayer({})
  await p.init()
  // 1546 轨的大书（示例长篇级别）
  const bigTracks = Array.from({length: 1546}, (_, i) => ({
    index: i + 1, startOffset: i * 180, duration: 180,
    url: 'http://x/' + i, title: 't' + i,
  }))
  await p.load({ itemId: 'big', tracks: bigTracks, sessionId: 's', duration: 1546*180, startBookTime: 0 })
  await p.play()
  const unloadBefore = state.calls.filter(c => c[0] === 'unload').length
  await p.stop({ silent: true })
  const unloadAfter = state.calls.filter(c => c[0] === 'unload').length
  const n = unloadAfter - unloadBefore
  ok('1546 轨的书 stop() 卸载调用 ≤ 5 次（原来 1548 次）', n <= 5, `n=${n}`)
  // 功能不回退：装载过的 asset 确实被卸掉
  ok('当前播放的 asset 已被卸载', !state.assets.has('sa-' + 0),
     `assets=${[...state.assets.keys()].slice(0,4)}`)
  // 换书再停一遍也要干净（用小书验证兜底路径）
  state.calls.length = 0
  await p.load({ itemId: 'small', tracks, sessionId: 's2', duration: 900, startBookTime: 0 })
  await p.play()
  await p.stop({ silent: true })
  ok('61 轨的书 stop() 后原生层无残留 asset', playingSet().length === 0,
     `playing=${playingSet()}`)
  await p.stop({ silent: true })
}

console.log('\n=== 14. 家长音量上限（2026-09-14 修复：上限必须真正生效）===')
{
  const store = globalThis.__SA_TEST_STORE__
  state.assets.clear(); state.calls.length = 0
  // 场景 A：上限 60%，孩子从不碰音量 → 装轨后原生层音量必须是 0.6（旧版是 1.0，bug）
  store.set('volumeCap', '0.6')
  const p = new BookPlayer({})
  await p.init()
  await p.load({ itemId: 'x', tracks, sessionId: 's', duration: 900, startBookTime: 0 })
  await p.play()
  ok('load 时读了家长上限', p._volumeCap === 0.6, `cap=${p._volumeCap}`)
  ok('当前 asset 音量被压到 0.6（旧 bug：开播不设音量=100%）',
     state.assets.get('sa-0')?.volume === 0.6, `v=${state.assets.get('sa-0')?.volume}`)

  // 场景 B：切集（自动下一集）后，新 asset 音量也必须是 0.6
  //   （插件音量 per-asset，新 preload 的 asset 默认 100%）
  state.calls.length = 0
  await p._onTrackEnd({ assetId: 'sa-0' })   // 播完第1集 → 自动进第2集
  ok('切集后新 asset 音量仍是 0.6（per-asset 不继承）',
     state.assets.get('sa-1')?.volume === 0.6, `v=${state.assets.get('sa-1')?.volume}`)

  // 场景 C：语音"大声点"也不能越过上限（_volume 保留用户意图，下发值必须封顶）
  await p.setVolume(1.0)
  ok('setVolume(1.0) 下发值被封顶到 0.6', state.assets.get('sa-1')?.volume === 0.6,
     `_volume=${p._volume} native=${state.assets.get('sa-1')?.volume}`)
  ok('用户意图音量仍记为 1.0（不写坏，家长取消上限后能回满）',
     Math.abs(p._volume - 1) < 1e-9, `_volume=${p._volume}`)

  // 场景 D：家长中途调低上限 → reapply 立即生效
  store.set('volumeCap', '0.3')
  await p.reapplyVolumeCap()
  ok('reapplyVolumeCap 后生效 0.3', state.assets.get('sa-1')?.volume === 0.3,
     `native=${state.assets.get('sa-1')?.volume}`)

  // 场景 E：上限取消（1.0）→ 回满
  store.set('volumeCap', '1')
  await p.reapplyVolumeCap()
  ok('上限取消后恢复 1.0', state.assets.get('sa-1')?.volume === 1,
     `native=${state.assets.get('sa-1')?.volume}`)
  await p.stop()
}

console.log('\n=== 15. 播放模式：顺序 / 单曲循环 / 乱序（老板 2026-09-14）===')
{
  state.assets.clear(); state.calls.length = 0
  const p = new BookPlayer({})
  await p.init()
  await p.load({ itemId: 'x', tracks, sessionId: 's', duration: 900, startBookTime: 0 })

  // 默认顺序播放
  ok('默认模式 = order（ABS 行为不变）', p.playMode === 'order', p.playMode)
  ok('非法模式值回退成 order', p.setPlayMode('bogus') === 'order')

  // ---- 顺序：正在播时播完第 1 集 → 进第 2 集并继续播 ----
  p.setPlayMode('order')
  await p.play()
  await p._onTrackEnd({ assetId: 'sa-0' })
  ok('顺序播放：第1集播完 → 第2集', p.trackIndex === 1, `idx=${p.trackIndex}`)
  ok('顺序播放：自动接续后仍在播（不断声）', p.playing === true)

  // ---- 顺序：最后一集播完 → 结束（onEnd 回调），不会回绕 ----
  let ended = 0
  const p2 = new BookPlayer({ onEnd: () => ended++ })
  await p2.init()
  await p2.load({ itemId: 'x', tracks, sessionId: 's', duration: 900, startBookTime: 900 })
  p2.trackIndex = tracks.length - 1
  p2.currentBookTime = tracks[tracks.length - 1].startOffset
  await p2._onTrackEnd()
  ok('顺序播放：最后一集播完 → 触发 onEnd', ended === 1, `ended=${ended}`)
  await p2.stop({ silent: true })

  // ---- 单曲循环：播完 → 回到本曲开头（不是下一曲）----
  state.calls.length = 0
  const p3 = new BookPlayer({})
  await p3.init()
  await p3.load({ itemId: 'x', tracks, sessionId: 's', duration: 900, startBookTime: 300 })
  p3.setPlayMode('repeat')
  const beforeIdx = p3.trackIndex
  p3.currentBookTime = tracks[beforeIdx].startOffset + tracks[beforeIdx].duration  // 模拟播到本曲末尾
  await p3._onTrackEnd({ assetId: 'sa-' + beforeIdx })
  ok('单曲循环：播完仍是同一首', p3.trackIndex === beforeIdx, `${beforeIdx} → ${p3.trackIndex}`)
  ok('单曲循环：回到本曲开头', Math.abs(p3.currentBookTime - tracks[beforeIdx].startOffset) < 0.01,
     `t=${p3.currentBookTime} start=${tracks[beforeIdx].startOffset}`)
  ok('单曲循环：继续播放（不断声）', p3.playing === true)
  await p3.stop({ silent: true })

  // ---- 乱序：播完 → 随机跳到别的曲目（可能同一首？保证不是）----
  const p4 = new BookPlayer({})
  await p4.init()
  await p4.load({ itemId: 'x', tracks, sessionId: 's', duration: 900, startBookTime: 0 })
  p4.setPlayMode('shuffle')
  let moved = 0
  for (let i = 0; i < 24; i++) {
    p4.trackIndex = 0
    p4.currentBookTime = 0
    await p4._onTrackEnd({ assetId: 'sa-0' })
    if (p4.trackIndex !== 0) moved++
  }
  ok('乱序：播完会跳到别的曲目（24 次全部换了）', moved === 24, `moved=${moved}/24`)
  // 手动「下一首」在乱序下也随机
  let manualDiff = 0
  for (let i = 0; i < 24; i++) {
    p4.trackIndex = 1
    p4.currentBookTime = tracks[1].startOffset
    await p4.nextTrack()
    if (p4.trackIndex !== 1) manualDiff++
  }
  ok('乱序：手动下一首也换曲（24 次全部换了）', manualDiff === 24, `diff=${manualDiff}/24`)
  // 单轨边界：只有一首歌时不能死循环
  const p5 = new BookPlayer({})
  await p5.init()
  await p5.load({ itemId: 'x', tracks: [tracks[0]], sessionId: 's', duration: 300, startBookTime: 0 })
  p5.setPlayMode('shuffle')
  await p5.nextTrack()
  ok('乱序：只有一首歌时点下一首不崩、仍停在原曲', p5.trackIndex === 0)
  await p5.stop({ silent: true })
  await p4.stop({ silent: true })

  // ---- 单曲循环 + 乱序 都必须在「暂停态播完」时也不出怪状态 ----
  const p6 = new BookPlayer({})
  await p6.init()
  await p6.load({ itemId: 'x', tracks, sessionId: 's', duration: 900, startBookTime: 0 })
  p6.setPlayMode('repeat')
  p6.playing = false
  p6._wantPlaying = false
  await p6._onTrackEnd({ assetId: 'sa-0' })
  ok('单曲循环：暂停态收到 complete 不异常（仍定位到本曲开头）', Math.abs(p6.currentBookTime - 0) < 0.01,
     `t=${p6.currentBookTime}`)
  await p6.stop({ silent: true })

  // ---- 整本播完 → onBookEnd 必须触发（计数清零，2026-09-16 第 4 轮审计）----
  console.log('\n=== 15b. 整本播完触发 onBookEnd（章节计数清零）===')
  {
    state.assets.clear()
    let bookEnds = 0
    const p8 = new BookPlayer({ onBookEnd: () => { bookEnds++ } })
    await p8.init()
    // 2 集的书，从第 2 集（末集）播完 → 应触发 onBookEnd
    await p8.load({ itemId: 'x', tracks: [
      { index: 1, startOffset: 0, duration: 300, url: 'u0', headers: {} },
      { index: 2, startOffset: 300, duration: 300, url: 'u1', headers: {} },
    ], sessionId: 's', duration: 600, startBookTime: 300 })
    await p8.play()
    p8.onBeforeAdvance = () => false   // 没设章节定时 → 不拦截
    await p8._onTrackEnd({ assetId: 'sa-1' })
    ok('末集播完触发 onBookEnd（计数可清零）', bookEnds === 1, `bookEnds=${bookEnds}`)
    // 重复 complete 不能重复触发（_endedFired 护栏）
    await p8._onTrackEnd({ assetId: 'sa-1' })
    ok('重复 complete 不重复触发 onBookEnd', bookEnds === 1, `bookEnds=${bookEnds}`)
    await p8.stop({ silent: true })
  }

  // ---- 睡眠定时·按章节：onBeforeAdvance 拦截（老板 2026-09-16）----
  console.log('\n=== 15. 睡眠定时·按章节（onBeforeAdvance 拦截不推进）===')
  {
    state.assets.clear()
    const p7 = new BookPlayer({})
    await p7.init()
    await p7.load({ itemId: 'x', tracks, sessionId: 's', duration: 900, startBookTime: 0 })
    await p7.play()
    // 顺序播放，onBeforeAdvance 一直返回 true（"听满 N 集该停了"）
    p7.onBeforeAdvance = () => true
    await p7._onTrackEnd({ assetId: 'sa-0' })
    ok('按章节到点：停在本集（不推进下一集）', p7.trackIndex === 0, `idx=${p7.trackIndex}`)
    ok('按章节到点：当前音轨已不在播（真的停了）', playingSet().length === 0, `playing=${playingSet()}`)
    // 拦截器不拦截时，complete 照常推进（别把正常连播弄坏）
    p7.onBeforeAdvance = () => false
    await p7._onTrackEnd({ assetId: 'sa-0' })
    ok('未到点：complete 照常推进到第2集', p7.trackIndex === 1, `idx=${p7.trackIndex}`)
    // 拦截优先于乱序推进
    p7.setPlayMode('shuffle')
    p7.onBeforeAdvance = () => true
    await p7._onTrackEnd({ assetId: 'sa-1' })
    ok('乱序模式下到点同样被拦截（不随机跳走）', p7.trackIndex === 1, `idx=${p7.trackIndex}`)
    await p7.stop({ silent: true })
  }

  // ---- 音量在 play/切集/暂停恢复时不被插件默认值打回 100%（2026-09-17 修复）----
  // 根因：插件 play() 的 volume 默认 1.0（两端一致），Android playInternal 无条件
  // player.setVolume(volume)、iOS player.volume = initialVolume。修复前 app 的
  // NativeAudio.play 从不传 volume → 每次开播（暂停恢复/切集/换书/看门狗自愈）
  // 音量都回满，家长上限也被打穿。假插件已复刻该语义（play 不带 volume → 1）。
  console.log('\n=== 16. 音量跨 play/暂停恢复/切集保持（2026-09-17）===')
  {
    const store = globalThis.__SA_TEST_STORE__
    state.assets.clear(); state.calls.length = 0
    store.set('volumeCap', '0.5')
    const p = new BookPlayer({})
    await p.init()
    await p.load({ itemId: 'x', tracks, sessionId: 's', duration: 900, startBookTime: 0 })
    await p.play()
    ok('开播后原生层音量 = 上限 0.5', state.assets.get('sa-0')?.volume === 0.5,
       `v=${state.assets.get('sa-0')?.volume}`)

    // 暂停 → 播放：真实插件 play 默认值会把音量打回 1.0，修复后必须仍 0.5
    await p.pause()
    await p.play()
    ok('暂停→恢复后音量仍 0.5（旧 bug：play 不带 volume 被打回 100%）',
       state.assets.get('sa-0')?.volume === 0.5, `v=${state.assets.get('sa-0')?.volume}`)

    // 语音"小声点"（0.5→0.3）→ 再暂停恢复，用户调的音量也不能丢
    await p.setVolume(0.3)
    ok('语音调小后生效 0.3', state.assets.get('sa-0')?.volume === 0.3)
    await p.pause()
    await p.play()
    ok('用户调小后再恢复仍 0.3（不被打回 100%）', state.assets.get('sa-0')?.volume === 0.3,
       `v=${state.assets.get('sa-0')?.volume}`)

    // 自动切集：新 asset 的音量也必须继承生效值
    p.onBeforeAdvance = () => false
    await p._onTrackEnd({ assetId: 'sa-0' })
    ok('切集后新 asset 音量 0.3（per-asset 默认 100% 不允许漏）',
       state.assets.get('sa-1')?.volume === 0.3, `v=${state.assets.get('sa-1')?.volume}`)
    // 看门狗自愈 / play 重试路径同样带 volume：直接检查 _playArgs
    // （用 ?. 调用：旧代码没有这个方法时应判失败，而不是抛错中断后续断言）
    const args = p._playArgs?.('sa-1', 10)
    ok('_playArgs 显式带 volume=0.3', args?.volume === 0.3, `args=${JSON.stringify(args)}`)
    await p.stop({ silent: true })

    // 桥调用次数护栏：音量=100%、无上限的主路径，play 不应额外多带 setVolume
    state.assets.clear(); state.calls.length = 0
    store.set('volumeCap', '1')
    const p2 = new BookPlayer({})
    await p2.init()
    await p2.load({ itemId: 'x', tracks, sessionId: 's', duration: 900, startBookTime: 0 })
    await p2.play()
    await p2.pause()
    state.calls.length = 0
    await p2.play()
    ok('音量 100% 主路径：恢复播放不产生额外 setVolume 桥调用',
       state.calls.filter(c => c[0] === 'setVolume').length === 0,
       `calls=${JSON.stringify(state.calls)}`)
    ok('音量 100% 主路径：asset 音量保持 1', state.assets.get('sa-0')?.volume === 1)
    await p2.stop({ silent: true })
  }
}

try { fs.unlinkSync(stubPath) } catch (_) {}
try { fs.unlinkSync(path.join(ROOT, '.tmp-parental-stub.mjs')) } catch (_) {}

console.log('\n==============================================')
console.log(`结果：${pass} 通过 / ${fail} 失败`)
process.exit(fail ? 1 : 0)

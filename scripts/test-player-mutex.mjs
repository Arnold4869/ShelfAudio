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
  async preload({ assetId }) {
    state.calls.push(['preload', assetId])
    state.assets.set(assetId, { playing: false, time: 0 })
  },
  async play({ assetId, time }) {
    state.calls.push(['play', assetId, time])
    const a = state.assets.get(assetId)
    if (!a) throw new Error('asset 未 preload: ' + assetId)
    a.playing = true
    a.time = time || 0
  },
  async pause({ assetId }) { const a = state.assets.get(assetId); if (a) a.playing = false },
  async resume({ assetId }) { const a = state.assets.get(assetId); if (a) a.playing = true },
  async stop({ assetId }) { state.calls.push(['stop', assetId]); const a = state.assets.get(assetId); if (a) a.playing = false },
  async unload({ assetId }) { state.calls.push(['unload', assetId]); state.assets.delete(assetId) },
  async setCurrentTime({ assetId, time }) { const a = state.assets.get(assetId); if (a) a.time = time; state.calls.push(['setTime', assetId, time]) },
  async setRate() {}, async setVolume() {},
  async getCurrentTime({ assetId }) { return { currentTime: state.assets.get(assetId)?.time ?? 0 } },
}

// ---------- 用替身跑真实 src/lib/player.js ----------
const stubPath = path.join(ROOT, '.tmp-player-under-test.mjs')
let code = SRC
  .replace(/import \{ NativeAudio \} from '@capgo\/capacitor-native-audio'/, 'const NativeAudio = globalThis.__FAKE_AUDIO__')
  .replace(/import \{ registerPlugin \} from '@capacitor\/core'/, 'const registerPlugin = () => ({ start: async () => {}, stop: async () => {} })')
  .replace(/import \{ abs \} from '\.\/api\.js'/, 'const abs = globalThis.__FAKE_ABS__')
fs.writeFileSync(stubPath, code)

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

try { fs.unlinkSync(stubPath) } catch (_) {}

console.log('\n==============================================')
console.log(`结果：${pass} 通过 / ${fail} 失败`)
process.exit(fail ? 1 : 0)

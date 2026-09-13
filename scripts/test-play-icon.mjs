/**
 * 播放键（播放/暂停图标）状态一致性测试
 *
 * 背景：老板反馈"正在播放时候，中间应该变成暂停键，它还是播放键"。
 * 根因候选：原生 playbackState 事件会抖动 —— ExoPlayer 缓冲中、
 * 音频焦点被抢占（语音识别/来电）时，asset.isPlaying() 短暂返回 false，
 * 插件据此发出 state=paused/stopped 事件，把 UI 翻回"播放键"，
 * 但声音其实还在播。
 *
 * 做法同 test-player-mutex.mjs：把插件 import 换成替身，测真代码。
 */
import fs from 'fs'
import path from 'path'
import { fileURLToPath, pathToFileURL } from 'url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SRC = fs.readFileSync(path.join(ROOT, 'src/lib/player.js'), 'utf8')

const state = { assets: new Map(), events: {}, calls: [], realPlaying: new Map() }

const FakeAudio = {
  async configure() {},
  async addListener(name, cb) { (state.events[name] ||= []).push(cb); return { remove() {} } },
  async preload({ assetId }) {
    state.assets.set(assetId, { playing: false, time: 0 })
    state.realPlaying.set(assetId, false)
  },
  async play({ assetId, time }) {
    const a = state.assets.get(assetId)
    if (!a) throw new Error('asset 未 preload: ' + assetId)
    a.playing = true; a.time = time || 0
    state.realPlaying.set(assetId, true)   // 原生层确实在播了
  },
  async pause({ assetId }) {
    const a = state.assets.get(assetId); if (a) a.playing = false
    state.realPlaying.set(assetId, false)
  },
  async resume({ assetId }) {
    const a = state.assets.get(assetId); if (a) a.playing = true
    state.realPlaying.set(assetId, true)
  },
  async stop({ assetId }) {
    const a = state.assets.get(assetId); if (a) a.playing = false
    state.realPlaying.set(assetId, false)
  },
  async unload({ assetId }) { state.assets.delete(assetId); state.realPlaying.delete(assetId) },
  async setCurrentTime({ assetId, time }) { const a = state.assets.get(assetId); if (a) a.time = time },
  async setRate() {}, async setVolume() {},
  async getCurrentTime({ assetId }) { return { currentTime: state.assets.get(assetId)?.time ?? 0 } },
  // ⚠️ 关键：插件暴露的真实状态查询
  async isPlaying({ assetId }) { return { isPlaying: !!state.realPlaying.get(assetId) } },
}

const stubPath = path.join(ROOT, '.tmp-icon-under-test.mjs')
let code = SRC
  .replace(/import \{ NativeAudio \} from '@capgo\/capacitor-native-audio'/, 'const NativeAudio = globalThis.__FAKE_AUDIO__')
  .replace(/import \{ registerPlugin \} from '@capacitor\/core'/, 'const registerPlugin = () => ({ start: async () => {}, stop: async () => {} })')
  .replace(/import \{ abs \} from '\.\/api\.js'/, 'const abs = globalThis.__FAKE_ABS__')
fs.writeFileSync(stubPath, code)

globalThis.__FAKE_AUDIO__ = FakeAudio
globalThis.__FAKE_ABS__ = { syncSession() {} }
globalThis.window = { Capacitor: { isNativePlatform: () => true, getPlatform: () => 'android' }, dispatchEvent() {} }

const { BookPlayer } = await import(pathToFileURL(stubPath).href)

const tracks = [
  { index: 1, startOffset: 0,   duration: 300, url: 'u0', headers: {} },
  { index: 2, startOffset: 300, duration: 300, url: 'u1', headers: {} },
]

let pass = 0, fail = 0
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ✅ ${name}`) }
  else { fail++; console.log(`  ❌ ${name}${extra ? ' — ' + extra : ''}`) }
}

/** UI 实际会画什么（与 views/player.js 的 paintState 同口径） */
const iconOf = p => p.buffering ? 'loading' : (p.playing ? 'pause' : 'play')

function emit(name, payload) {
  (state.events[name] || []).forEach(cb => cb(payload))
}

console.log('\n=== 1. 点播放后应立刻显示暂停键 ===')
{
  state.assets.clear(); state.calls.length = 0
  const p = new BookPlayer({})
  await p.init()
  await p.load({ itemId: 'x', tracks, sessionId: 's', duration: 600, startBookTime: 0 })
  ok('装载后显示播放键', iconOf(p) === 'play', iconOf(p))
  await p.play()
  ok('播放后立刻显示暂停键（不等原生确认）', iconOf(p) === 'pause', iconOf(p))
  await p.stop()
}

console.log('\n=== 2. 缓冲期原生报"未在播"不能把 UI 翻回播放键 ===')
{
  state.assets.clear()
  const p = new BookPlayer({})
  await p.init()
  await p.load({ itemId: 'x', tracks, sessionId: 's', duration: 600, startBookTime: 0 })
  await p.play()
  // 插件 play() 后立刻发的那个事件：ExoPlayer 还在缓冲 → state=paused
  emit('playbackState', { assetId: 'sa-0', state: 'paused', reason: 'play', currentTime: 0 })
  await new Promise(r => setTimeout(r, 30))
  ok('缓冲期抖动后仍是暂停键', iconOf(p) === 'pause', iconOf(p))
  ok('原生层确实在播（前提成立）', state.realPlaying.get('sa-0') === true)
  await p.stop()
}

console.log('\n=== 3. 播放中被音频焦点抢占（语音识别/来电）报 paused 也不能翻 ===')
{
  state.assets.clear()
  const p = new BookPlayer({})
  await p.init()
  await p.load({ itemId: 'x', tracks, sessionId: 's', duration: 600, startBookTime: 0 })
  await p.play()
  // 模拟播放已久（超出任何"启动容忍窗口"）
  p._startDeadline = Date.now() - 60000
  emit('playbackState', { assetId: 'sa-0', state: 'paused', reason: 'audioFocusLossTransient' })
  await new Promise(r => setTimeout(r, 30))
  ok('焦点抢占的抖动不翻状态（声音还在播）', iconOf(p) === 'pause', iconOf(p))
  await p.stop()
}

console.log('\n=== 4. 真的暂停了，UI 必须翻回播放键 ===')
{
  state.assets.clear()
  const p = new BookPlayer({})
  await p.init()
  await p.load({ itemId: 'x', tracks, sessionId: 's', duration: 600, startBookTime: 0 })
  await p.play()
  await p.pause()
  ok('用户暂停后显示播放键', iconOf(p) === 'play', iconOf(p))
  // 远程/系统暂停（锁屏、通知栏、耳机按键）：原生层真停了
  await p.play()
  state.realPlaying.set('sa-0', false)          // 原生层确实停了
  state.assets.get('sa-0').playing = false
  emit('playbackState', { assetId: 'sa-0', state: 'paused', reason: 'remotePause' })
  await new Promise(r => setTimeout(r, 30))
  ok('系统真实暂停后正确翻回播放键', iconOf(p) === 'play', iconOf(p))
  await p.stop()
}

try { fs.unlinkSync(stubPath) } catch (_) {}

console.log('\n==============================================')
console.log(`结果：${pass} 通过 / ${fail} 失败`)
process.exit(fail ? 1 : 0)

#!/usr/bin/env node
/**
 * sleep.js 跨源睡眠定时回归（P1 §3.1，2026-10-12 审计修）
 *
 * 覆盖：
 *  1. setSleepTracks 落盘 JSON { remain, unit, itemId }（不再是纯数字）
 *  2. onTrackCompleted(itemId) 换书/换源 → 静默作废（不消耗、不暂停、不 toast）
 *  3. 同一 itemId → 正常递减，到 0 触发暂停
 *  4. restoreSleepTimer 读回旧纯数字串（兼容老数据）
 *  5. restoreSleepTimer 读回新 JSON（unit/itemId 恢复）
 *  6. getSleepTracksUnit 返回落盘单位（ND 设的「3 首」切 ABS 不显示成「3 集」）
 *
 * 做法：把 src/lib/sleep.js 源码里的三个依赖 import 替换成内存桩（沿用
 * test-player-mutex.mjs 的「真代码 + 打桩」手法），写到临时文件后 import。
 * 直接 import 真源码，不复制逻辑。
 *
 * 用法: node scripts/test-sleep-tracks.mjs
 */
import fs from 'fs'
import path from 'path'
import { fileURLToPath, pathToFileURL } from 'url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

// ---------- 内存桩 ----------
const MEM = new Map()           // store key -> 值
const TOASTS = []              // toast 调用记录
let pauseCalls = 0             // firePause 触发的暂停次数（state.player.pause）

const stubStore = {
  async get(k, d = null) { return MEM.has(k) ? MEM.get(k) : d },
  async set(k, v) { MEM.set(k, String(v)) },
  async remove(k) { MEM.delete(k) },
  async getJSON(k, d) {
    const raw = await this.get(k, null)
    if (raw == null) return d
    try { return JSON.parse(raw) } catch (_) { return d }
  },
  setJSON(k, o) { return this.set(k, JSON.stringify(o)) },
}
const CONFIG_KEYS = { sleepAt: 'sleepAt', sleepTracks: 'sleepTracks' }

const stubHaptic = { warn() {} }

// toast / state 来自 app.js：桩成可观察的
const stubApp = {
  toast(msg) { TOASTS.push(msg) },
  state: { player: { pause() { pauseCalls++; return Promise.resolve() } } },
}

// ---------- 装载真代码（替换依赖） ----------
const SRC = fs.readFileSync(path.join(ROOT, 'src/lib/sleep.js'), 'utf8')
const stubPath = path.join(ROOT, '.tmp-sleep-under-test.mjs')
const code = SRC
  .replace(/import \{ store, CONFIG_KEYS \} from '\.\/store\.js'/, 'const { store, CONFIG_KEYS } = globalThis.__SLEEP_STORE__')
  .replace(/import \{ haptic \} from '\.\/haptics\.js'/, 'const haptic = globalThis.__SLEEP_HAPTIC__')
  .replace(/import \{ toast \} from '\.\.\/app\.js'/, 'const toast = globalThis.__SLEEP_APP__.toast')
  .replace(/const \{ state \} = await import\('\.\.\/app\.js'\)/, 'const { state } = globalThis.__SLEEP_APP__')
fs.writeFileSync(stubPath, code)

globalThis.__SLEEP_STORE__ = { store: stubStore, CONFIG_KEYS }
globalThis.__SLEEP_HAPTIC__ = stubHaptic
globalThis.__SLEEP_APP__ = stubApp

const sleep = await import(pathToFileURL(stubPath).href)

// ---------- 断言 ----------
let pass = 0, fail = 0
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ✅ ${name}`) }
  else { fail++; console.log(`  ❌ ${name}${extra ? ' — ' + extra : ''}`) }
}

// firePause 是异步的（内部多处 await）——触发过它的用例必须等它落地再断言/进入下一段，
// 否则上一段的收尾动作（落盘 '0'、toast、pause）会漏进下一段。
const settle = () => new Promise(r => setTimeout(r, 25))

async function reset() {
  await settle()     // 让上一段未完成的 firePause / store.set 落地
  MEM.clear(); TOASTS.length = 0; pauseCalls = 0
}

console.log('\n=== 1. 落盘 JSON 形状（含 unit/itemId）===')
{
  reset()
  await sleep.setSleepTracks(3, '首', 'nd:alb1')
  const raw = MEM.get('sleepTracks')
  ok('落盘是 JSON 串', typeof raw === 'string' && raw.startsWith('{'), raw)
  const parsed = JSON.parse(raw)
  ok('remain=3', parsed.remain === 3, JSON.stringify(parsed))
  ok('unit=首', parsed.unit === '首', JSON.stringify(parsed))
  ok('itemId=nd:alb1', parsed.itemId === 'nd:alb1', JSON.stringify(parsed))
  ok('getSleepTracksUnit=首', sleep.getSleepTracksUnit() === '首', sleep.getSleepTracksUnit())
}

console.log('\n=== 2. 换书/换源 → 静默作废（P1 核心）===')
{
  await reset()
  await sleep.setSleepTracks(3, '首', 'nd:alb1')
  const toastBase = TOASTS.length        // setSleepTracks 自己会 toast 一次，作基线
  const r = sleep.onTrackCompleted('nd:OTHER')
  await settle()
  ok('不消耗（返回 false 且不暂停）', r === false, `r=${r}`)
  ok('剩余计数清零', sleep.getSleepTracksLeft() === 0, String(sleep.getSleepTracksLeft()))
  ok('kind 变 null', sleep.sleepKind() === null, String(sleep.sleepKind()))
  ok('不弹新 toast（静默作废）', TOASTS.length === toastBase, JSON.stringify(TOASTS))
  ok('不触发暂停', pauseCalls === 0, String(pauseCalls))
  ok('落盘清零', MEM.get('sleepTracks') === '0', MEM.get('sleepTracks'))
}

console.log('\n=== 3. 同一 itemId → 正常递减到 0 暂停 ===')
{
  await reset()
  await sleep.setSleepTracks(2, '集', 'book1')
  const r1 = sleep.onTrackCompleted('book1')
  ok('第1集播完剩 1', r1 === false && sleep.getSleepTracksLeft() === 1, `r=${r1} left=${sleep.getSleepTracksLeft()}`)
  const r2 = sleep.onTrackCompleted('book1')
  await settle()   // firePause 异步：等它落地再断言
  ok('第2集播完到点', r2 === true, `r=${r2}`)
  ok('触发暂停', pauseCalls === 1, String(pauseCalls))
  ok('弹「睡眠定时到」toast', TOASTS.some(m => m.includes('睡眠定时到')), JSON.stringify(TOASTS))
}

console.log('\n=== 4. 旧纯数字串兼容读回 ===')
{
  await reset()
  MEM.set('sleepTracks', '4')   // 老版本只存数字
  await sleep.restoreSleepTimer()
  ok('旧数据读回 remain=4', sleep.getSleepTracksLeft() === 4, String(sleep.getSleepTracksLeft()))
  ok('无 unit（不设）', sleep.getSleepTracksUnit() === '', String(sleep.getSleepTracksUnit()))
  // 无 itemId → 不校验来源，继续老行为：正常递减
  const r = sleep.onTrackCompleted('anyBook')
  ok('无来源信息时正常递减（老行为）', r === false && sleep.getSleepTracksLeft() === 3, String(sleep.getSleepTracksLeft()))
}

console.log('\n=== 5. 新 JSON 读回（unit/itemId 恢复）===')
{
  await reset()
  MEM.set('sleepTracks', JSON.stringify({ remain: 5, unit: '首', itemId: 'nd:alb9' }))
  await sleep.restoreSleepTimer()
  ok('读回 remain=5', sleep.getSleepTracksLeft() === 5, String(sleep.getSleepTracksLeft()))
  ok('读回 unit=首', sleep.getSleepTracksUnit() === '首', sleep.getSleepTracksUnit())
  ok('读回 itemId 仍生效（换书作废）', sleep.onTrackCompleted('nd:elsewhere') === false && sleep.getSleepTracksLeft() === 0, String(sleep.getSleepTracksLeft()))
  await settle()
}

console.log('\n=== 6. 无 itemId 绑定 → 不校验（向后兼容调用方）===')
{
  await reset()
  await sleep.setSleepTracks(3, '集')   // 不传 itemId
  const r = sleep.onTrackCompleted('whatever')
  ok('无绑定时正常递减', r === false && sleep.getSleepTracksLeft() === 2, String(sleep.getSleepTracksLeft()))
}

try { fs.unlinkSync(stubPath) } catch (_) {}
console.log('\n==============================================')
console.log(`结果：${pass} 通过 / ${fail} 失败`)
process.exit(fail ? 1 : 0)

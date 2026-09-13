/**
 * 显示开关（老板 2026-09-14：「加个开关，在设置里，可以隐藏语音按钮」）
 *
 * 为什么单独一个模块：语音按钮出现在多个视图（书架、搜索页），
 * 判断逻辑必须统一，而且需要在视图渲染**之前**就知道结果 ——
 * store 是异步的（原生 Preferences），渲染时现读会闪一下，
 * 所以登录后在 boot 阶段读一次，缓存到内存；设置页改开关时同步更新缓存。
 */
import { store, CONFIG_KEYS } from './store.js'

let _hideVoice = false
let _loaded = false

/** 启动时调用（boot 阶段）：把偏好读进内存 */
export async function loadUiPrefs() {
  try {
    _hideVoice = (await store.get(CONFIG_KEYS.hideVoice, '0')) === '1'
  } catch (_) { _hideVoice = false }
  _loaded = true
  return { hideVoice: _hideVoice }
}

/** 语音按钮是否应该隐藏（同步，视图渲染时可直接用） */
export function voiceHidden() { return _hideVoice }

/** 设置页切换开关 */
export async function setVoiceHidden(v) {
  _hideVoice = !!v
  _loaded = true
  try { await store.set(CONFIG_KEYS.hideVoice, v ? '1' : '0') } catch (_) {}
  return _hideVoice
}

export function uiPrefsLoaded() { return _loaded }

/**
 * 等待偏好就绪（幂等）。视图渲染前 await 一下，按钮显隐就不会闪
 * （否则先按默认显示、读到偏好后再隐藏，用户会看到按钮跳一下）。
 */
let _readyPromise = null
export function uiPrefsReady() {
  if (_loaded) return Promise.resolve()
  if (!_readyPromise) _readyPromise = loadUiPrefs().catch(() => {})
  return _readyPromise
}

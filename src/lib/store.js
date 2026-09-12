/**
 * 本地配置存储 —— 必须落在原生层（Preferences），不能只用 localStorage。
 * 原因：iOS 重装/换签名后沙盒会清空、Android WebView localStorage 也可能被系统回收，
 * 落在原生 SharedPreferences/UserDefaults 才稳。
 * 无原生环境（浏览器调试）时退回 localStorage。
 */
import { Preferences } from '@capacitor/preferences'

const PREFIX = 'shelfaudio.'

function hasNative() {
  try {
    return !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform())
  } catch (_) { return false }
}

export const store = {
  async get(key, fallback = null) {
    try {
      if (hasNative()) {
        const { value } = await Preferences.get({ key: PREFIX + key })
        return value === null || value === undefined ? fallback : value
      }
      const v = window.localStorage.getItem(PREFIX + key)
      return v === null ? fallback : v
    } catch (_) { return fallback }
  },

  async set(key, value) {
    const v = String(value)
    try {
      if (hasNative()) await Preferences.set({ key: PREFIX + key, value: v })
      else window.localStorage.setItem(PREFIX + key, v)
    } catch (_) {}
  },

  async remove(key) {
    try {
      if (hasNative()) await Preferences.remove({ key: PREFIX + key })
      else window.localStorage.removeItem(PREFIX + key)
    } catch (_) {}
  },

  async getJSON(key, fallback) {
    const raw = await this.get(key, null)
    if (!raw) return fallback
    try { return JSON.parse(raw) } catch (_) { return fallback }
  },

  setJSON(key, obj) { return this.set(key, JSON.stringify(obj)) },
}

export const CONFIG_KEYS = {
  server: 'server',
  token: 'token',
  username: 'username',
  mode: 'mode',                 // 'kid' | 'adult'
  kidPin: 'kidPin',             // 退出儿童模式的家长密码
  playbackRate: 'playbackRate',
  sleepMinutes: 'sleepMinutes',
  kidLibraryIds: 'kidLibraryIds',
}

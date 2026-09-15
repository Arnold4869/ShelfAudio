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
  kidPin: 'kidPin',             // 家长密码（进「家长设置」需要）
  playbackRate: 'playbackRate',
  sleepMinutes: 'sleepMinutes',
  sleepAt: 'sleepAt',                     // 睡眠到点时间戳（ms）'0'=未设定（2026-09-15）
  kidLibraryIds: 'kidLibraryIds',
  haptics: 'haptics',                   // 触感反馈开关 '1' | '0'
  progressScope: 'progressScope',       // 进度条口径 'track'（单集，默认）| 'book'（整部作品）
  hideVoice: 'hideVoice',               // 隐藏语音搜索按钮 '1' | '0'（老板 2026-09-13）
  listeningLog: 'listeningLog',         // 收听时长记录（JSON 数组）
  // ---- 老板 2026-09-13 ----
  quietNotification: 'quietNotification', // 静默「普通通知」'1'|'0'（锁屏控制保留）
  volumeCap: 'volumeCap',                 // 全局音量上限 0.1~1（'1'=不限制）
  ndServer: 'ndServer',                   // Navidrome 服务器地址
  ndUser: 'ndUser',                       // ND 用户名
  ndPassword: 'ndPassword',               // ND 密码：Subsonic 协议每次请求要算 md5(password+salt)，必须存
  activeSource: 'activeSource',           // 当前激活源 'abs' | 'nd'（两源都登录时的右上角切换）
  timeLimitEnabled: 'timeLimitEnabled',   // [旧] 使用时间管控总开关（兼容读，不再写入）
  timeWindowEnabled: 'timeWindowEnabled', // 时段限制开关 '1'|'0'（老板 2026-09-14：两个限制各自独立）
  dailyLimitEnabled: 'dailyLimitEnabled', // 每日时长限制开关 '1'|'0'
  timeWeekdayFrom: 'timeWeekdayFrom',     // 工作日允许开始时间 'HH:MM'
  timeWeekdayTo: 'timeWeekdayTo',         // 工作日允许结束时间
  timeWeekendFrom: 'timeWeekendFrom',     // 周末允许开始时间
  timeWeekendTo: 'timeWeekendTo',         // 周末允许结束时间
  timeDailyMinutes: 'timeDailyMinutes',   // 每天最多听多少分钟（0=不限）
  playMode: 'playMode',                   // 播放模式 'order'|'repeat'|'shuffle'（老板 2026-09-14）
}

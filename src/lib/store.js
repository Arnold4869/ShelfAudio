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

  /**
   * 严格读（NF-1，复审 2026-10-12）：与 get/getJSON 的「吞错回 fallback」不同，
   * 桥错误与 JSON 解析失败都**向上抛** —— 给「读失败必须被看见」的调用方用。
   *
   * 为什么单开一条路而不改 get/getJSON：绝大多数配置键「读失败 = 用默认值」
   * 正是期望行为（改了会满屏报错）；但离线索引这类「记录磁盘文件清单」的键，
   * 把读失败折叠成「没有」会让 UI 误报 0 MB、清空入口消失、单删假成功
   * （审计 §3.5，本轮复审确认原修法的检测层在吞错语义下不可达）。
   *
   * 契约：
   *  - 键不存在（含存了空串）→ 返回 null：「真的没有」不是错误，调用方自行归一；
   *  - 桥错误 → 抛 err.kind = 'read'（连原始串都拿不到，没有可备份的东西）；
   *  - 解析失败 → 抛 err.kind = 'parse'，err.raw = 损坏的原始串
   *    （离线索引拿它备份到 .bak 再重建，防「写入中途被杀的截断串」被覆写后永久丢失）。
   */
  async getJSONStrict(key) {
    let raw
    try {
      if (hasNative()) {
        const { value } = await Preferences.get({ key: PREFIX + key })
        raw = value
      } else {
        raw = window.localStorage.getItem(PREFIX + key)
      }
    } catch (e) {
      const err = new Error('本地存储读取失败：' + (e?.message || e))
      err.kind = 'read'
      throw err
    }
    if (raw === null || raw === undefined || raw === '') return null
    try {
      return JSON.parse(raw)
    } catch (e) {
      const err = new Error('本地数据解析失败：' + (e?.message || e))
      err.kind = 'parse'
      err.raw = raw
      throw err
    }
  },

  setJSON(key, obj) { return this.set(key, JSON.stringify(obj)) },

  /**
   * JSON 键的串行「读-改-写」（§4.7，2026-10-12 审计修）。
   *
   * 为什么：本地清单类键（继续听补记 / 本机收藏）的写入是「读 → 改 → 写回」，
   * 而 recordContinue 在 playItem 里是**不 await 的并行写** —— 快速连点两本书时
   * 两次 RMW 交错，先完成读的那次会把后写的整段覆盖掉。离线索引（offline.js
   * 的 mutateIndex）在 0.14.0 就为同款问题修过，这里把队列抽到 store 层统一用。
   *
   * fn(cur) 收到当前值（读失败/没有时为 null，调用方自己归一），返回新值；
   * 返回 undefined 表示不变更、不写回。同一 key 的变更严格按提交顺序串行执行。
   */
  mutateJSON(key, fn) {
    this._mutQueues || (this._mutQueues = new Map())
    const prev = this._mutQueues.get(key) || Promise.resolve()
    const next = prev.then(async () => {
      const cur = await this.getJSON(key, null)
      const out = await fn(cur)
      if (out !== undefined) await this.setJSON(key, out)
    }).catch(() => {})
    this._mutQueues.set(key, next)
    return next
  },
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
  sleepKind: 'sleepKind',                 // 睡眠定时类型 'time'（倒计时，默认）| 'tracks'（听 N 首/集后停，老板 2026-09-16）
  sleepTracks: 'sleepTracks',             // 按章节定时：还剩几首/集后暂停（'0'=未设定）
  // ND 的「已从历史移除」本地隐藏清单（JSON 数组，存 nd: 专辑 id）。
  // ND 服务端没有 hideFromContinueListening 概念：removeFromContinue 只删 bookmark，
  // 下次进度同步会重建 → 删完立刻回来。本地记一份兜底（P1 §3.3，2026-10-12）。
  ndHiddenContinue: 'ndHiddenContinue',
  warmupEnabled: 'warmupEnabled',         // 冷启动预热开关 '1'|'0'（默认开；预热「继续听第一本」省起播等待）
}

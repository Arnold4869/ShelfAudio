/**
 * 播放引擎封装
 * - 原生（iOS/Android）：@capgo/capacitor-native-audio，走系统原生播放器
 *   → 后台播放 + 锁屏/通知栏控制（iOS: MPNowPlayingInfoCenter / Android: MediaSession）
 * - 浏览器：退回 HTML5 Audio + MediaSession API（开发调试用，不影响真机）
 *
 * 重要（Android 后台播放）：光配置 backgroundPlayback 不够，必须自己起前台服务。
 * 见 android/.../PlaybackService.java，由 native.js 调用。
 */

import { NativeAudio } from '@capgo/capacitor-native-audio'
import { registerPlugin } from '@capacitor/core'

/**
 * Android 前台服务桥（自定义原生插件，见 android/.../PlaybackServicePlugin.java）
 * 插件不提供前台服务，但 Android 8+ 后台播放必须有它，否则锁屏几分钟后音频被系统杀掉。
 */
const ForegroundService = registerPlugin('ForegroundService')

function isNative() {
  try { return !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform()) } catch (_) { return false }
}

function platform() {
  try { return window.Capacitor?.getPlatform?.() || 'web' } catch (_) { return 'web' }
}

/** 起/停前台服务（Android 专用；iOS 靠 UIBackgroundModes=audio，无需此步） */
async function fgStart(title, text) {
  if (platform() !== 'android') return
  try { await ForegroundService.start({ title: title || '听书', text: text || '正在播放' }) } catch (e) { console.warn('前台服务启动失败', e) }
}
async function fgStop() {
  if (platform() !== 'android') return
  try { await ForegroundService.stop({}) } catch (_) {}
}

/**
 * BookPlayer 管理"一本有声书"：多音轨顺序播放 + 书级时间轴
 *
 * 书级时间轴（ABS 的 currentTime 就是全书累计秒数）：
 *   fileTime = bookTime - tracks[i].startOffset
 *   bookTime = tracks[i].startOffset + fileTime
 */
export class BookPlayer {
  constructor({ onTime, onState, onTrackChange, onEnd } = {}) {
    this.onTime = onTime || (() => {})
    this.onState = onState || (() => {})
    this.onTrackChange = onTrackChange || (() => {})
    this.onEnd = onEnd || (() => {})

    this.itemId = null
    this.sessionId = null
    this.tracks = []
    this.duration = 0
    this.trackIndex = 0        // 当前音轨下标（0-based，对应 this.tracks）
    this.rate = 1
    this.playing = false
    this.currentBookTime = 0
    this._listeners = []
    this._audio = null          // 浏览器回退用
    this._ticker = null
    this._lastSyncAt = 0
    this._timeListened = 0      // 距上次上报的收听秒数
    this.assetPrefix = 'sa-'
    this._endedFired = false
    this.notification = null    // { title, artist, album, artworkUrl }
    this._volume = 1
    this._nativeTicker = null   // 原生兜底心跳（保证进度写回 ABS）
  }

  // ---------- 初始化 ----------
  async init() {
    if (isNative()) {
      try {
        await NativeAudio.configure({
          // ⚠️ background 必须为 false！
          // 插件（8.4.25）在 Android 上收到 background=true 会执行
          //   audioManager.setMode(AudioManager.MODE_IN_COMMUNICATION)
          // MODE_IN_COMMUNICATION 会让系统把输出当成"通话音频"，从而绕开
          // A2DP 蓝牙耳机、强制走听筒/外放 —— 这正是"连了蓝牙却外放"的根因。
          // 后台播放不依赖它：Android 侧由我们自己的 PlaybackService 前台服务保证，
          // iOS 侧由 Info.plist 的 UIBackgroundModes=audio 保证。
          background: false,
          // backgroundPlayback 必须保持 true：Android 上它是「切后台不自动暂停」的开关
          // （NativeAudio.handleOnPause 里靠它 return）。它不会改音频模式，安全。
          backgroundPlayback: true,
          showNotification: true,     // 锁屏/通知栏控制
          focus: true,
          ignoreSilent: true,         // iOS 静音键下也出声（儿童场景必要）
        })
      } catch (e) { console.warn('NativeAudio.configure 失败', e) }

      if (NativeAudio.addListener) {
        try {
          const l1 = await NativeAudio.addListener('currentTime', (ev) => this._onNativeTime(ev))
          const l2 = await NativeAudio.addListener('playbackState', (ev) => this._onNativeState(ev))
          const l3 = await NativeAudio.addListener('complete', () => this._onTrackEnd())
          this._listeners = [l1, l2, l3].filter(Boolean)
        } catch (e) { console.warn('NativeAudio 监听注册失败', e) }
      }
    }
  }

  get isNativeEngine() { return isNative() }

  // ---------- 装载一本书 ----------
  /**
   * @param {object} opts
   *   itemId, tracks[], sessionId, duration, startBookTime, notification{title,artist,album,artworkUrl}
   */
  async load({ itemId, tracks, sessionId, duration, startBookTime = 0, notification }) {
    await this.stop({ silent: true })
    this.itemId = itemId
    this.tracks = tracks || []
    this.sessionId = sessionId || null
    this.duration = duration || this.tracks.reduce((a, t) => a + (t.duration || 0), 0)
    this.notification = notification || null
    this._endedFired = false
    this._timeListened = 0
    this._lastSyncAt = Date.now()

    const idx = this._trackIndexForBookTime(startBookTime)
    this.trackIndex = idx
    const fileTime = Math.max(0, startBookTime - (this.tracks[idx]?.startOffset || 0))
    this.currentBookTime = startBookTime

    if (this.isNativeEngine) {
      await this._nativeLoadTrack(idx, fileTime)
    } else {
      await this._webLoadTrack(idx, fileTime)
    }
    this._emitTime()
    return this
  }

  /** 开始播放（首次由用户手势触发，iOS 才允许出声） */
  async play() {
    if (this.isNativeEngine) {
      // Android：先占住前台服务，否则切后台会被系统掐音频
      await fgStart(this.notification?.title, this.notification?.artist)
      // ⚠️ 必须显式传 time！
      // 插件 play() 的 time 默认是 0（iOS: `call.getDouble(Constant.Time) ?? 0`，
      // Android: `call.getDouble(TIME, 0.0)`），不传就会把播放位置重置到 0。
      // 选章节/拖进度条/从暂停恢复都会因此被"弹回开头"——这就是
      // 「选集点了没用」「历史记录没更新」的共同根因。
      const fileTime = this._fileTimeFor(this.trackIndex)
      await NativeAudio.play({ assetId: this._assetId(this.trackIndex), time: fileTime })
    } else if (this._audio) {
      await this._audio.play().catch(e => console.warn('play 失败', e))
    }
    this.playing = true
    this.onState({ state: 'playing', isPlaying: true })
    this._startWebTickerIfNeeded()
    this._startNativeTicker()
  }

  async pause() {
    if (this.isNativeEngine) await NativeAudio.pause({ assetId: this._assetId(this.trackIndex) })
    else if (this._audio) this._audio.pause()
    this.playing = false
    this.onState({ state: 'paused', isPlaying: false })
    this._stopWebTicker()
  }

  async toggle() { return this.playing ? this.pause() : this.play() }

  /** 跳到全书某个时间点 */
  async seek(bookTime) {
    const t = Math.max(0, Math.min(bookTime, this.duration || 0))
    const idx = this._trackIndexForBookTime(t)
    const wasPlaying = this.playing

    if (idx !== this.trackIndex || !this.isNativeEngine) {
      // 换轨（或浏览器版直接换 src）
      this.trackIndex = idx
      this.currentBookTime = t
      const fileTime = Math.max(0, t - (this.tracks[idx]?.startOffset || 0))
      if (this.isNativeEngine) {
        // 先载入，再由 play({time}) 一次定位（避免 setCurrentTime 与 play 竞态）
        await this._nativeLoadTrack(idx, fileTime)
      } else {
        await this._webLoadTrack(idx, fileTime)
      }
    } else if (this.isNativeEngine) {
      // 同一音轨内：setCurrentTime 是异步派发到音频队列的，
      // 若紧接着调用 play()（其 time 默认 0）会把它覆盖回开头。
      // 所以先等定位完成，再恢复播放。
      await NativeAudio.setCurrentTime({ assetId: this._assetId(idx), time: t - (this.tracks[idx]?.startOffset || 0) })
      this.currentBookTime = t
    } else if (this._audio) {
      this._audio.currentTime = t - (this.tracks[idx]?.startOffset || 0)
      this.currentBookTime = t
    }

    this.currentBookTime = t
    this._emitTime()
    if (wasPlaying) await this.play()
    else await this.pause()
    this._syncProgress(true)
  }

  /** 上一集 / 下一集（章节=音轨） */
  async nextTrack() {
    if (this.trackIndex >= this.tracks.length - 1) return
    await this._gotoTrack(this.trackIndex + 1)
  }

  async prevTrack() {
    // 播放超过 3 秒则回到本集开头，否则上一集（跟主流播客 App 一致）
    const t = this.tracks[this.trackIndex]
    const fileTime = this.currentBookTime - (t?.startOffset || 0)
    if (fileTime > 3 || this.trackIndex === 0) return this.seek(t?.startOffset || 0)
    await this._gotoTrack(this.trackIndex - 1)
  }

  async _gotoTrack(i) {
    if (i < 0 || i >= this.tracks.length) return
    const wasPlaying = this.playing
    this.trackIndex = i
    const start = this.tracks[i].startOffset || 0
    this.currentBookTime = start
    // 载入时不预置位置（真正位置由下面的 play({time}) 决定），避免两次定位打架
    if (this.isNativeEngine) await this._nativeLoadTrack(i, 0)
    else await this._webLoadTrack(i, 0)
    this._emitTime()
    // 关键：一次到位 —— play() 里会带上正确的 time，避免"预置位置被 play 重置成 0"
    if (wasPlaying) await this.play()
    else if (this.isNativeEngine) {
      // 暂停态换集：也要把位置放对，否则之后点播放会从 0 开始
      try { await NativeAudio.setCurrentTime({ assetId: this._assetId(i), time: 0 }) } catch (_) {}
    }
    this._syncProgress(true)
    this.onTrackChange({ index: i, total: this.tracks.length, track: this.tracks[i] })
  }

  async setRate(rate) {
    this.rate = rate
    if (this.isNativeEngine) {
      // iOS: setRate 直接映射 AVPlayer.rate，支持 0.25~4.0
      // Android: 远程音频的 setRate 目前是空转（RemoteAudioAsset 未覆写），实机验证时确认
      try { await NativeAudio.setRate({ assetId: this._assetId(this.trackIndex), rate }) } catch (_) {}
    } else if (this._audio) {
      this._audio.playbackRate = rate
    }
  }

  /** 音量增减（语音“大声点/小声点”用），0.1~1.0 */
  async setVolume(v) {
    this._volume = Math.max(0.1, Math.min(1, v))
    if (this.isNativeEngine) {
      try { await NativeAudio.setVolume({ assetId: this._assetId(this.trackIndex), volume: this._volume }) } catch (_) {}
    } else if (this._audio) {
      this._audio.volume = this._volume
    }
  }

  async nudgeVolume(delta) {
    return this.setVolume((this._volume ?? 1) + delta)
  }

  async stop({ silent = false } = {}) {
    this._stopNativeTicker()
    await fgStop()
    if (this.isNativeEngine) {
      try { await NativeAudio.stop({ assetId: this._assetId(this.trackIndex) }) } catch (_) {}
      // 卸载本书记住的所有 asset，避免原生层堆积
      for (const t of this.tracks) {
        try { await NativeAudio.unload({ assetId: this._assetId(t.index) }) } catch (_) {}
      }
    } else if (this._audio) {
      this._audio.pause()
      this._audio.removeAttribute('src')
      this._audio.load()
      this._audio = null
    }
    this.playing = false
    this._stopWebTicker()
    if (!silent) this.onState({ state: 'stopped', isPlaying: false })
  }

  /** 结束播放：关会话 + 保存进度 */
  async finish() {
    const { currentTime } = this.position()
    if (this.sessionId) {
      await this._api()?.closeSession(this.sessionId, currentTime, this._timeListened, this.duration)
      this.sessionId = null
    }
    this._timeListened = 0
  }

  position() {
    return { currentTime: this.currentBookTime, duration: this.duration, trackIndex: this.trackIndex }
  }

  // ---------- 内部：原生实现 ----------
  _assetId(trackIdx) { return `${this.assetPrefix}${trackIdx}` }

  /** 当前音轨内的偏移（秒）：全书时间 - 该轨 startOffset */
  _fileTimeFor(idx) {
    const off = this.tracks[idx]?.startOffset || 0
    return Math.max(0, this.currentBookTime - off)
  }

  async _nativeLoadTrack(idx, fileTime) {
    const t = this.tracks[idx]
    if (!t) return
    const url = t.url         // 已在 api 层拼好 token
    const assetId = this._assetId(idx)
    try { await NativeAudio.unload({ assetId }) } catch (_) {}
    await NativeAudio.preload({
      assetId,
      assetPath: url,
      isUrl: true,
      headers: t.headers || undefined,     // 用 Bearer header 鉴权更稳（支持 7.10+）
      notificationMetadata: this.notification ? {
        title: this.notification.title,
        artist: this.notification.artist,
        album: this.notification.album,
        artworkUrl: this.notification.artworkUrl,
      } : undefined,
    })
    if (fileTime > 0.5) {
      try { await NativeAudio.setCurrentTime({ assetId, time: fileTime }) } catch (_) {}
    }
  }

  _onNativeTime(ev) {
    // ev: { assetId, currentTime, duration }
    const idx = this._indexFromAssetId(ev.assetId)
    if (idx === null || idx !== this.trackIndex) return
    const off = this.tracks[idx]?.startOffset || 0
    this.currentBookTime = off + (ev.currentTime || 0)
    this._timeListened += 1     // currentTime 事件约 1s 一次，近似累计
    this._emitTime()
    this._syncProgress()
  }

  _onNativeState(ev) {
    // 远程控制（锁屏/通知栏）也会触发这里，UI 必须跟着变
    const playing = ev?.state === 'playing'
    this.playing = playing
    if (typeof ev?.currentTime === 'number') {
      const idx = this._indexFromAssetId(ev.assetId)
      if (idx !== null) {
        this.currentBookTime = (this.tracks[idx]?.startOffset || 0) + ev.currentTime
        this._emitTime()
      }
    }
    this.onState({ state: ev?.state || (playing ? 'playing' : 'paused'), isPlaying: playing, reason: ev?.reason })
  }

  _onTrackEnd() {
    // 单条音轨播完 → 自动下一集；最后一集 → 结束
    if (this.trackIndex < this.tracks.length - 1) {
      this._gotoTrack(this.trackIndex + 1)
    } else {
      if (this._endedFired) return
      this._endedFired = true
      this.playing = false
      this.currentBookTime = this.duration
      this._emitTime()
      this.onEnd()
      this.finish()
    }
  }

  _indexFromAssetId(assetId) {
    if (!assetId || !assetId.startsWith(this.assetPrefix)) return null
    const n = parseInt(assetId.slice(this.assetPrefix.length), 10)
    return Number.isFinite(n) ? n : null
  }

  // ---------- 内部：浏览器回退 ----------
  async _webLoadTrack(idx, fileTime) {
    const t = this.tracks[idx]
    if (!t) return
    if (!this._audio) {
      this._audio = new Audio()
      this._audio.preload = 'auto'
      this._audio.addEventListener('ended', () => this._onTrackEnd())
      this._audio.addEventListener('timeupdate', () => {
        const off = this.tracks[this.trackIndex]?.startOffset || 0
        this.currentBookTime = off + (this._audio.currentTime || 0)
        this._emitTime()
      })
      this._audio.addEventListener('play', () => { this.playing = true; this.onState({ state: 'playing', isPlaying: true }) })
      this._audio.addEventListener('pause', () => { this.playing = false; this.onState({ state: 'paused', isPlaying: false }) })
    }
    this._audio.src = t.url
    this._audio.playbackRate = this.rate
    this._setupMediaSession()
    await new Promise(res => {
      const done = () => res()
      this._audio.addEventListener('loadedmetadata', done, { once: true })
      setTimeout(done, 1500)
    })
    if (fileTime > 0.5) { try { this._audio.currentTime = fileTime } catch (_) {} }
  }

  _setupMediaSession() {
    if (!('mediaSession' in navigator)) return
    const n = this.notification
    if (!n) return
    try {
      navigator.mediaSession.metadata = new window.MediaMetadata({
        title: n.title || '', artist: n.artist || '', album: n.album || '',
        artwork: n.artworkUrl ? [{ src: n.artworkUrl, sizes: '400x400' }] : [],
      })
      navigator.mediaSession.setActionHandler('play', () => this.play())
      navigator.mediaSession.setActionHandler('pause', () => this.pause())
      navigator.mediaSession.setActionHandler('previoustrack', () => this.prevTrack())
      navigator.mediaSession.setActionHandler('nexttrack', () => this.nextTrack())
    } catch (_) {}
  }

  _startWebTickerIfNeeded() { /* 浏览器版靠 timeupdate，无需 ticker */ }
  _stopWebTicker() { /* 同上 */ }

  /**
   * 原生兜底心跳（每 3 秒）
   * 为什么需要：进度回写本来只依赖插件的 currentTime 事件，
   * 但该事件在各种情况下可能不发（事件未注册成功、切后台被挂起、
   * 播放结束瞬间等），导致 ABS 的「继续听 / 历史记录」长期不更新。
   * 这里主动向原生层查一次当前播放位置，作为可靠来源。
   */
  _startNativeTicker() {
    if (!this.isNativeEngine || this._nativeTicker) return
    this._nativeTicker = setInterval(async () => {
      if (!this.playing || !this.sessionId) return
      try {
        const r = await NativeAudio.getCurrentTime({ assetId: this._assetId(this.trackIndex) })
        const t = r?.currentTime
        if (typeof t === 'number' && isFinite(t) && t >= 0) {
          const off = this.tracks[this.trackIndex]?.startOffset || 0
          // 只在原生层给的位置更靠前时纠正，避免把 seek 后的值往回拉
          if (this.currentBookTime < off + t) {
            this.currentBookTime = off + t
            this._emitTime()
          }
          this._timeListened += 3
        }
      } catch (_) {}
      this._syncProgress()
    }, 3000)
  }

  _stopNativeTicker() {
    if (this._nativeTicker) { clearInterval(this._nativeTicker); this._nativeTicker = null }
  }

  // ---------- 内部：通用 ----------
  _trackIndexForBookTime(bookTime) {
    if (!this.tracks.length) return 0
    for (let i = this.tracks.length - 1; i >= 0; i--) {
      if (bookTime >= (this.tracks[i].startOffset || 0) - 0.001) return i
    }
    return 0
  }

  _emitTime() {
    this.onTime({ currentTime: this.currentBookTime, duration: this.duration, trackIndex: this.trackIndex })
  }

  /** 每 ~10 秒把进度回写 ABS；force=true 用于暂停/跳转/章节切换 */
  _syncProgress(force = false) {
    if (!this.sessionId) return
    const now = Date.now()
    if (!force && now - this._lastSyncAt < 10000) return
    this._lastSyncAt = now
    const api = this._api()
    if (!api) return
    const listened = this._timeListened
    this._timeListened = 0
    api.syncSession(this.sessionId, this.currentBookTime, listened, this.duration)
  }

  _api() { return window.__abs || null }
}

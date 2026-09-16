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
  try { await ForegroundService.start({ title: title || '悦耳', text: text || '正在播放' }) } catch (e) { console.warn('前台服务启动失败', e) }
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
  constructor({ onTime, onState, onTrackChange, onEnd, onBeforeAdvance, onBookEnd } = {}) {
    this.onTime = onTime || (() => {})
    this.onState = onState || (() => {})
    this.onTrackChange = onTrackChange || (() => {})
    this.onEnd = onEnd || (() => {})
    /**
     * 「本集播完、即将进入下一集」前的拦截钩子（睡眠定时"听完 N 集/首后停"用，2026-09-16）。
     * 返回 true = 停在这里（不再推进下一集）。
     * 为什么不放在 onTrackChange 里判断：那样下一集已经开始播了才暂停，
     * 用户会听到"下一集刚出声就被掐掉"的一下。
     * 由 app.js 注入（避免 lib/player.js 反向依赖 sleep 模块）。
     */
    this.onBeforeAdvance = typeof onBeforeAdvance === 'function' ? onBeforeAdvance : null
    /**
     * 「整本书/整张专辑播完」钩子（2026-09-16 第 4 轮审计补）。
     * 用途：睡眠定时的剩余计数必须在这里**静默清零**。否则一本书听完了
     * （播放本来就停了），残留的计数会跟着用户去看的下一本书 —— 表现为
     * "在新书刚听 1 集就被莫名暂停"。
     */
    this.onBookEnd = typeof onBookEnd === 'function' ? onBookEnd : null

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
    this._volumeCap = 1         // 家长音量上限（load 时读一次，之后每次装轨都再套一遍）
    // 播放模式（老板 2026-09-14：「单曲循环、顺序播放、乱序播放」）
    //   'order'  顺序播放（默认，播完一集接下一集，最后一集结束）
    //   'repeat' 单曲循环（当前这一首/集反复）
    //   'shuffle' 乱序播放（自动接下一首时随机选一首，避开当前这首）
    // 只对 ND 暴露 UI，ABS 保持原有的顺序行为（默认值即 'order'）。
    this.playMode = 'order'
    this._nativeTicker = null   // 原生兜底心跳（保证进度写回 ABS）
    this._playingAssetIdx = null // 原生层当前真正在播的 asset 下标（换轨时据此清理旧音轨）
    this._loadedIdx = new Set()  // 原生层当前已 preload 的音轨下标（保证同一时刻只留一条）
    // ---- 播放健壮性状态（"点了播不出来 / 点几下卡卡的"根因治理，见 play()）----
    this._wantPlaying = false    // 用户意图（连点时以它为准，不用可能滞后的 this.playing）
    this._chain = Promise.resolve() // play/pause 串行队列：原生调用不允许交叉
    this._starting = false       // 已发出 play、但还没收到 STATE_PLAYING 的窗口
    this._startDeadline = 0      // 该窗口的截止时间（超过就不再容忍"未播"事件）
    this._startWatchdog = null   // 启动看门狗定时器（play 后从未出声 → 自愈）
    this._watchdogFired = false
    this._lastTimeEventAt = 0    // 最后一次收到 currentTime 事件的时间
    this.buffering = false       // 正在缓冲（UI 显示加载态，而不是装作在播）
  }

  /**
   * 串行化原生调用。
   *
   * 为什么必须：连点播放键时，toggle() 里若读可能滞后的 this.playing，
   * 会交错发出 play/pause/play，原生层按到达顺序执行，
   * 结果就是"卡卡的、一声一声的"（声音刚起就被下一条 pause 掐掉）。
   */
  _enqueue(fn) {
    const run = this._chain.then(fn, fn)
    this._chain = run.then(() => {}, () => {})
    return run
  }

  /** 我们的音频会话参数（配置/re配置都用这一份，避免两处不一致） */
  static sessionOptions() {
    return {
      // ⚠️ background 必须为 false！
      // 插件（8.4.25）在 Android 上收到 background=true 会执行
      //   audioManager.setMode(AudioManager.MODE_IN_COMMUNICATION)
      // MODE_IN_COMMUNICATION 会让系统把输出当成"通话音频"，从而绕开
      // A2DP 蓝牙耳机、强制走听筒/外放 —— 这正是"连了蓝牙却外放"的 Android 根因。
      // 后台播放不依赖它：Android 侧由我们自己的 PlaybackService 前台服务保证，
      // iOS 侧由 Info.plist 的 UIBackgroundModes=audio 保证。
      background: false,
      // backgroundPlayback 必须保持 true：Android 上它是「切后台不自动暂停」的开关
      // （NativeAudio.handleOnPause 里靠它 return）。它不会改音频模式，安全。
      backgroundPlayback: true,
      showNotification: true,     // 锁屏/通知栏控制
      focus: true,
      ignoreSilent: true,         // iOS 静音键下也出声（儿童场景必要）
    }
  }

  /**
   * 重新声明音频会话类别。
   *
   * 为什么必须做：语音识别插件（@capgo/capacitor-speech-recognition）在 iOS 上
   * 用完后会把 AVAudioSession 留成
   *     .playAndRecord + .defaultToSpeaker + mode .measurement
   * 而 native-audio 的 play() 内部只调 setActive(true)，**不会重设 category**
   * → 播放沿用 .playAndRecord(+defaultToSpeaker)，把声音强制送到扬声器，
   *   蓝牙 A2DP 通道被绕过。表现就是"明明连着蓝牙耳机却走外放"。
   *
   * 所以在每次语音会话结束后、以及每次开始播放前，重新 configure 一次。
   */
  static async reassertSession() {
    if (!isNative()) return
    try { await NativeAudio.configure(BookPlayer.sessionOptions()) } catch (_) {}
  }

  // ---------- 初始化 ----------
  async init() {
    if (isNative()) {
      try {
        await NativeAudio.configure(BookPlayer.sessionOptions())
      } catch (e) { console.warn('NativeAudio.configure 失败', e) }

      if (NativeAudio.addListener) {
        try {
          const l1 = await NativeAudio.addListener('currentTime', (ev) => this._onNativeTime(ev))
          const l2 = await NativeAudio.addListener('playbackState', (ev) => this._onNativeState(ev))
          const l3 = await NativeAudio.addListener('complete', (ev) => this._onTrackEnd(ev))
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
  async load({ itemId, tracks, sessionId, duration, startBookTime = 0, notification, localMap = null, localResolver = null }) {
    await this.stop({ silent: true })
    // 加载前把「上次被杀时残留的播放意图」清干净：
    // App 被杀时 _wantPlaying 可能还是 true，重开后这里不清，
    // 第一条"未在播"事件就会走进 _resolveRealPause 把 UI 卡在缓冲态。
    this._wantPlaying = false
    this._starting = false
    this.buffering = false
    this.itemId = itemId
    this.tracks = tracks || []
    // 本地缓存映射 { idx: file:// URI }。有缓存的集优先离线播放（不联网也能听），
    // 没缓存的集自动回落到在线流 —— 混着用也没问题。
    // ⚠️ 必须直接赋值，不能 `|| this.localMap`：换书时若新书没传 localMap，
    // 会继承上一本的映射，把 A 书的本地文件当成 B 书的音轨加载。
    this.localMap = localMap || {}
    // 懒解析器（老板 2026-09-13）：本地缓存按集现查，替代"整本书一次查完"的
    // localMap —— 536 集的书旧路径要 1072 次原生桥调用。两者都给时优先 lazy。
    this._localResolver = typeof localResolver === 'function' ? localResolver : null
    this.sessionId = sessionId || null
    this.duration = duration || this.tracks.reduce((a, t) => a + (t.duration || 0), 0)
    this.notification = notification || null
    this._endedFired = false
    this._timeListened = 0
    this._lastSyncAt = Date.now()

    // 家长音量上限（老板 2026-09-14 报「音量限制这个功能你检查下生效没」）：
    // 原实现只在 setVolume() 里封顶，而装书/开播**从不主动设音量** ——
    // _volume 初始 1、原生播放器默认 100%，所以只要孩子不碰音量条，
    // 上限就完全没作用。这里在 load 时读一次上限并立刻应用。
    // 注意：只写 _volumeCap，**不动 _volume** —— 用户想要的音量与家长上限是
    // 两个独立值，封顶在 _effectiveVolume() 里做（否则家长取消上限后音量回不来）。
    this._volumeCap = 1
    try {
      const { volumeCap } = await import('./parental.js')
      this._volumeCap = (await volumeCap()) || 1
    } catch (_) { this._volumeCap = 1 }

    // 审计加固（2026-09-13）：恢复落点合法性校验，必须在 _trackIndexForBookTime 之前做 ——
    // 它遇到 NaN 会一路 false 走到末轨、遇到越界进度会返回不存在的位置。
    // 服务器进度可能越界（currentTime ≥ 总时长：清数据残留 / 上次进度写坏），
    // 越界的表现就是"加载后一动不动"或瞬间 complete。非法落点 → 归零从头播。
    const total = this.tracks.reduce((s2, t2) => s2 + (t2.duration || 0), 0)
    if (!(typeof startBookTime === 'number' && Number.isFinite(startBookTime)
          && startBookTime > 0 && startBookTime < total)) {
      startBookTime = 0
    }
    let idx = this._trackIndexForBookTime(startBookTime)
    // 恢复位置的"结尾贴齐"：如果落点在这一集最后 5 秒内、且还有下一集，
    // 直接对齐到下一集开头。
    // 为什么：进度回写最多滞后 ~10 秒（心跳 3s + 节流 10s），在某一集临近结尾时
    // 退出 App，存下来的位置就是"该集最后几秒"。恢复时忠实定位 → 播不到 1 秒
    // 就 complete 自动跳下一集 —— 用户看到的就是"一回来直接到这集最后边"。
    // 主流播放器（Audible/微信读书）同样在恢复时做尾部对齐。
    // ⚠️ 只在 load（恢复/续播）路径做，seek() 不做 —— 用户手动拖到最后几秒必须尊重。
    let loadIdx = idx
    let loadFileTime = Math.max(0, startBookTime - (this.tracks[idx]?.startOffset || 0))
    const trackDur = this.tracks[idx]?.duration || 0
    if (trackDur > 0 && loadFileTime > trackDur - 5 && idx < this.tracks.length - 1) {
      loadIdx = idx + 1
      loadFileTime = 0
    }
    // 落点所在音轨必须真实存在（防御 idx 越界）
    if (loadIdx < 0 || loadIdx >= this.tracks.length) { loadIdx = 0; loadFileTime = 0 }
    this.trackIndex = loadIdx
    this.currentBookTime = (this.tracks[loadIdx]?.startOffset || 0) + loadFileTime

    if (this.isNativeEngine) {
      await this._nativeLoadTrack(loadIdx, loadFileTime)
    } else {
      await this._webLoadTrack(loadIdx, loadFileTime)
    }
    this._emitTime()
    return this
  }

  /** 开始播放（首次由用户手势触发，iOS 才允许出声） */
  async play() {
    return this._enqueue(async () => {
      this._wantPlaying = true
      this._starting = true
      this._startDeadline = Date.now() + 15000   // 容忍窗口：远程音频冷启动 + 弱网缓冲
      try {
        if (this.isNativeEngine) {
          // iOS：语音识别插件会残留 .playAndRecord + .defaultToSpeaker 会话，
          // 播放前必须把类别抢回 .playback，否则声音被强制送扬声器（蓝牙耳机失效）。
          await BookPlayer.reassertSession()
          // Android：先占住前台服务，否则切后台会被系统掐音频
          await fgStart(this.notification?.title, this.notification?.artist)
          // ⚠️ 必须显式传 time！
          // 插件 play() 的 time 默认是 0（iOS: `call.getDouble(Constant.Time) ?? 0`，
          // Android: `call.getDouble(TIME, 0.0)`），不传就会把播放位置重置到 0。
          // 选章节/拖进度条/从暂停恢复都会因此被"弹回开头"——这就是
          // 「选集点了没用」「历史记录没更新」的共同根因。
          const fileTime = this._fileTimeFor(this.trackIndex)
          await NativeAudio.play({ assetId: this._assetId(this.trackIndex), time: fileTime })
          this._playingAssetIdx = this.trackIndex
        } else if (this._audio) {
          await this._audio.play().catch(e => console.warn('play 失败', e))
        }
      } catch (e) {
        // play 调用失败（asset 没装上/被系统打断）：重装一条再试一次。
        // 之前失败只打日志，用户看到的就是"点了没反应"。
        console.warn('play 失败，重装音轨重试', e)
        try {
          await this._nativeLoadTrack(this.trackIndex, this._fileTimeFor(this.trackIndex))
          const fileTime2 = this._fileTimeFor(this.trackIndex)
          await NativeAudio.play({ assetId: this._assetId(this.trackIndex), time: fileTime2 })
          this._playingAssetIdx = this.trackIndex
        } catch (e2) {
          this._starting = false
          this.buffering = false
          this.playing = false
          this.onState({ state: 'error', isPlaying: false, reason: 'play-failed' })
          throw e2
        }
      }
      // 乐观置位：声音起没起以原生 playbackState 事件为准；
      // 网络音频冷启动要缓冲几秒，期间 UI 不该显示"已暂停"（那是"没按上"的观感来源）
      this.playing = true
      this.onState({ state: 'playing', isPlaying: true })
      this._startWebTickerIfNeeded()
      this._startNativeTicker()
      // 启动看门狗：如果到 _startDeadline 还没收到任何 currentTime 事件
      // （原生层从未真正出声），执行自愈 —— 清插件磁盘流缓存后整体重载重试。
      // 场景：App 被杀时 ExoPlayer 的磁盘流缓存（getCacheDir()/media）留下损坏条目，
      // 重开后同一本书的同一集永远缓冲不出来 —— 表现为「继续听第一本一直正在播放
      // 却加载不出来，其它书都正常」。清缓存 + 重载能救回来。
      this._armStartWatchdog()
    })
  }

  /**
   * 启动看门狗：play() 后若 _startDeadline 内连一次 currentTime 都没收到，
   * 说明原生层从未真正出声（不是慢，是卡死）。执行两级自愈：
   *   1) 清掉插件的磁盘流缓存（App 被杀时可能留下损坏的 SimpleCache 条目，
   *      之后的每次 preload 都会命中坏缓存 → 永远缓冲中）
   *   2) 整体重载当前轨再 play 一次
   * 自愈成功/失败都向 UI 发状态，绝不无限循环（只试一轮）。
   */
  _armStartWatchdog() {
    if (!this.isNativeEngine) return
    clearTimeout(this._startWatchdog)
    this._watchdogFired = false
    this._startWatchdog = setTimeout(async () => {
      if (this._watchdogFired || !this._wantPlaying) return
      // 收到过时间事件 = 真的在播，看门狗无事可做
      if (this._lastTimeEventAt && Date.now() - this._lastTimeEventAt < 5000) return
      this._watchdogFired = true
      console.warn('启动看门狗触发：play 后从未出声，清缓存重载')
      this.onState({ state: 'buffering', isPlaying: true, reason: 'start-watchdog' })
      try {
        try { await NativeAudio.clearCache?.() } catch (_) {}
        await this._nativeLoadTrack(this.trackIndex, this._fileTimeFor(this.trackIndex))
        await NativeAudio.play({ assetId: this._assetId(this.trackIndex), time: this._fileTimeFor(this.trackIndex) })
        this._playingAssetIdx = this.trackIndex
        this._startDeadline = Date.now() + 15000
        this._armStartWatchdog()   // 再观察一轮；仍不出声就真报错
      } catch (e) {
        console.warn('看门狗自愈失败', e)
        this._starting = false
        this.buffering = false
        this.playing = false
        this._wantPlaying = false
        this.onState({ state: 'error', isPlaying: false, reason: 'start-watchdog-failed' })
      }
    // 默认 12 秒：冷启动/弱网真慢给了足够余量，缓存卡死也不至于让用户干等。
    // 测试可通过 this._watchdogMs 注入更短的值（不必真等 12 秒）。
    }, this._watchdogMs ?? 12000)
  }

  async pause() {
    return this._enqueue(async () => {
      this._wantPlaying = false
      this._starting = false
      if (this.isNativeEngine) await NativeAudio.pause({ assetId: this._assetId(this.trackIndex) })
      else if (this._audio) this._audio.pause()
      this.playing = false
      this.buffering = false
      this.onState({ state: 'paused', isPlaying: false })
      this._stopWebTicker()
      // 暂停 = 用户明确停下的位置，立刻回写 ABS。
      // 之前只靠 10s 节流 + complete/finish，"听完这集前的暂停"会把
      // 最后几秒漏在服务端外面，恢复时就贴着集尾（见 load 的结尾贴齐）。
      this._syncProgress(true)
    })
  }

  async toggle() { return this._wantPlaying ? this.pause() : this.play() }

  /** 跳到全书某个时间点 */
  /**
   * 跳转到 bookTime。
   * @param {number} bookTime 整本书的时间位置（秒）
   * @param {object} [opts]
   * @param {boolean} [opts.autoPlay=false] 跳完强制开播。
   *   选集走 true（老板 2026-09-13：「点选一集之后不自动播放」—— 之前语义是
   *   「跟随当前状态」，暂停态点选集就停在暂停，看起来像点了没反应）；
   *   进度条拖拽/±15s 保持默认 false（用户拖到某处不一定要立刻响）。
   */
  async seek(bookTime, opts = {}) {
    const t = Math.max(0, Math.min(bookTime, this.duration || 0))
    const idx = this._trackIndexForBookTime(t)
    const wasPlaying = this.playing || opts.autoPlay === true

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
    // 乱序模式：「下一首」= 随机另一首（否则按钮在乱序下会表现得很"顺序"，很怪）
    if (this.playMode === 'shuffle' && this.tracks.length > 1) {
      await this._gotoTrack(this._randomOtherIndex())
      return
    }
    if (this.trackIndex >= this.tracks.length - 1) return
    await this._gotoTrack(this.trackIndex + 1)
  }

  /** 乱序：随机取一个与当前不同的音轨下标（轨数 ≥2 时保证一定不同） */
  _randomOtherIndex() {
    const n = this.tracks.length
    if (n <= 1) return this.trackIndex
    let i = this.trackIndex
    // 最多试 12 次，避免极端运气下一直转到自己
    for (let k = 0; k < 12 && i === this.trackIndex; k++) i = Math.floor(Math.random() * n)
    if (i === this.trackIndex) i = (this.trackIndex + 1) % n
    return i
  }

  /** 设置播放模式：'order' | 'repeat' | 'shuffle' */
  setPlayMode(mode) {
    this.playMode = ['order', 'repeat', 'shuffle'].includes(mode) ? mode : 'order'
    return this.playMode
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

  /**
   * 实际生效的音量 = min(用户设定的音量, 家长上限)。
   * 所有真正下发到原生层/HTMLAudio 的地方都必须用它，不要直接用 _volume。
   */
  _effectiveVolume() {
    const cap = Number.isFinite(this._volumeCap) ? this._volumeCap : 1
    const v = Number.isFinite(this._volume) ? this._volume : 1
    return Math.max(0.01, Math.min(v, cap))
  }

  /** 音量增减（语音“大声点/小声点”用），0.1~1.0 */
  async setVolume(v, { enforceCap = true } = {}) {
    // 家长音量上限（老板 2026-09-13）：设置过 volumeCap 后，App 内任何音量调整
    // （语音"大声点"、UI）都不会超过上限。系统音量不归我们管。
    //
    // ⚠️ 只刷新上限值、**不把上限写进 _volume**（2026-09-14 修）：
    // 老写法 `v = Math.min(v, cap)` 会把"用户想要的音量"永久限制在上限内，
    // 家长之后取消/调高上限时音量也回不来（实测：设过 0.6 后取消上限仍是 0.6）。
    // 正确做法：_volume = 用户意图，_effectiveVolume() = min(意图, 上限)。
    if (enforceCap) {
      try {
        const { volumeCap } = await import('./parental.js')
        this._volumeCap = await volumeCap()
      } catch (_) {}
    }
    this._volume = Math.max(0.1, Math.min(1, Number(v) || 0))
    const eff = this._effectiveVolume()
    if (this.isNativeEngine) {
      try { await NativeAudio.setVolume({ assetId: this._assetId(this.trackIndex), volume: eff }) } catch (_) {}
    } else if (this._audio) {
      this._audio.volume = eff
    }
  }

  /**
   * 家长改了音量上限后立即生效（不改变用户设定的音量，只重新套一次封顶）。
   */
  async reapplyVolumeCap() {
    try {
      const { volumeCap } = await import('./parental.js')
      this._volumeCap = await volumeCap()
    } catch (_) { return }
    const eff = this._effectiveVolume()
    if (this.isNativeEngine) {
      if (!this._loadedIdx.has(this.trackIndex) && this._playingAssetIdx == null) return
      try { await NativeAudio.setVolume({ assetId: this._assetId(this.trackIndex), volume: eff }) } catch (_) {}
    } else if (this._audio) {
      this._audio.volume = eff
    }
  }

  async nudgeVolume(delta) {
    return this.setVolume((this._volume ?? 1) + delta)
  }

  async stop({ silent = false } = {}) {
    clearTimeout(this._startWatchdog)
    this._stopNativeTicker()
    this._wantPlaying = false
    this._starting = false
    this.buffering = false
    await fgStop()
    if (this.isNativeEngine) {
      // 只卸载「真正装载过」的 asset —— 不要遍历全部音轨！
      // 审计（2026-09-13，老板报「历史记录播放有时不行」）：
      //   《示例长篇》1546 轨，原来这里 for 全表逐个 await unload，
      //   实测 1548 次原生桥调用，真机 0.8~4.6 秒纯等待；这些 assetId 里
      //   除了当前装载的，其余根本没 preload 过（unload 会 reject，白跑一趟）。
      //   表现就是「偶发卡住/点了没反应」，且书越大越容易撞上。
      // 兜底：额外扫一遍 _loadedIdx（历史装载记录），最后再补一发当前轨附近，
      // 防止极早期版本留下的错位 id 残留（只多 2 次调用，与轨数无关）。
      const candidates = new Set([...this._loadedIdx])
      candidates.add(this.trackIndex)
      if (this._playingAssetIdx != null) candidates.add(this._playingAssetIdx)
      for (const i of candidates) {
        if (i == null || i < 0 || i >= this.tracks.length) continue
        await this._killAsset(i)
      }
      this._playingAssetIdx = null
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

  /**
   * 语音识别打断后恢复播放。
   * 语音插件在 iOS 上 setActive(false) 会把整个音频会话关掉，
   * 播放器内部状态可能还是"在播"、但系统层面已经静音 —— 必须重新激活会话。
   *
   * @param {boolean} force 语音开始前确实在播时传 true。
   *   因为系统打断会触发 playbackState 事件把 this.playing 置为 false，
   *   只看 this.playing 会误判成"本来就没播"从而不恢复。
   */
  async resumeAfterVoice(force = false) {
    if (!this.isNativeEngine) return
    if (!force && !this.playing) return
    try {
      // 顺序重要：先 configure 把类别抢回 .playback（蓝牙路由），
      // 再 resume —— 插件 resume() 内部会 activateSession()。
      await BookPlayer.reassertSession()
      await NativeAudio.resume({ assetId: this._assetId(this.trackIndex) })
      this.playing = true
      this.onState({ state: 'playing', isPlaying: true, reason: 'resumeAfterVoice' })
      this._startNativeTicker()
    } catch (_) {}
  }

  // ---------- 内部：原生实现 ----------
  _assetId(trackIdx) { return `${this.assetPrefix}${trackIdx}` }

  /** 当前音轨内的偏移（秒）：全书时间 - 该轨 startOffset */
  _fileTimeFor(idx) {
    const off = this.tracks[idx]?.startOffset || 0
    return Math.max(0, this.currentBookTime - off)
  }

  /**
   * 彻底停掉一条音轨（stop + unload）。
   *
   * ⚠️ 插件里**每个 assetId 就是一个独立的原生播放器实例**。
   * 切集时如果只 preload 新的、不停旧的，旧的那条会继续出声 ——
   * 表现为"选完新集，旧集还在响，两个声音叠在一起"。
   * 所以每次换轨前必须先 stop + unload 旧 assetId。
   */
  async _killAsset(idx) {
    if (idx == null || idx < 0) return
    const assetId = this._assetId(idx)
    try { await NativeAudio.stop({ assetId }) } catch (_) {}
    try { await NativeAudio.unload({ assetId }) } catch (_) {}
    this._loadedIdx.delete(idx)
    if (this._playingAssetIdx === idx) this._playingAssetIdx = null
  }

  /**
   * 只保留 wantIdx 这一条音轨，把其它已装载的全部杀掉。
   * 这是"两个声音同时响"的结构性保证：插件里每个 assetId 是独立播放器，
   * 只要保证同时只有一条存活，就不可能叠音。
   */
  async _keepOnly(wantIdx) {
    const others = [...this._loadedIdx].filter(i => i !== wantIdx)
    for (const i of others) await this._killAsset(i)
    if (this._playingAssetIdx != null && this._playingAssetIdx !== wantIdx) {
      await this._killAsset(this._playingAssetIdx)
    }
  }

  async _nativeLoadTrack(idx, fileTime) {
    const t = this.tracks[idx]
    if (!t) return
    const url = t.url         // 已在 api 层拼好 token
    const assetId = this._assetId(idx)

    // 关键：先保证原生层只剩目标这一条，否则旧音轨会继续出声（叠音）
    await this._keepOnly(idx)
    // 同一条音轨重新载入（seek/重播）也要先彻底停，避免重影
    await this._killAsset(idx)

    // 有本地缓存就用本地文件：不耗流量、无网也能听。
    // 优先走懒解析器（每次一次桥调用），没有才回落整本映射。
    let local = this.localMap?.[idx]
    if (!local && this._localResolver) {
      try { local = await this._localResolver(idx) } catch (_) { local = null }
      if (local) this.localMap[idx] = local
    }
    const useLocal = !!local
    const preloadArgs = {
      assetId,
      assetPath: useLocal ? local : url,
      isUrl: true,
      // 本地文件不要带鉴权头（file:// 传 header 在个别实现上会失败）
      headers: useLocal ? undefined : (t.headers || undefined),
      notificationMetadata: this.notification ? {
        title: this.notification.title,
        artist: this.notification.artist,
        album: this.notification.album,
        artworkUrl: this.notification.artworkUrl,
      } : undefined,
    }
    try {
      await NativeAudio.preload(preloadArgs)
    } catch (firstErr) {
      // 插件对"assetId 已存在"的 preload 直接 reject（ERROR_AUDIO_EXISTS）。
      // 什么时候会发生：App 被系统杀掉时，原生层的 asset 没来得及 unload（前台服务
      // 把进程保活），重开 App 后同一下标的 assetId 与残留的撞车 ——
      // 表现就是「继续听第一本（被杀时正播的那本）永远加载不出来」：
      // preload reject → load() 抛 → playItem 中断 → play() 没执行，
      // 但 UI 已进播放页显示"正在播放"。
      // 修法：先彻底卸载这条 assetId，再重试一次；再失败才真报错。
      try { await NativeAudio.unload({ assetId }) } catch (_) {}
      try { await NativeAudio.stop({ assetId }) } catch (_) {}
      try {
        await NativeAudio.preload(preloadArgs)
      } catch (secondErr) {
        console.warn('preload 两次失败', assetId, firstErr?.message, secondErr?.message)
        throw secondErr
      }
    }
    this._loadedIdx.add(idx)
    if (fileTime > 0.5) {
      try { await NativeAudio.setCurrentTime({ assetId, time: fileTime }) } catch (_) {}
    }
    // ⚠️ 插件的音量是 per-asset 的：新 preload 的 asset 音量是默认 100%，
    // 不在这里重新套上限/当前音量，每次切集/换书音量都会弹回 100%
    // —— 这正是「音量上限不生效」的另一半根因（2026-09-14）。
    if (this._volume < 1 || this._volumeCap < 1) {
      try { await NativeAudio.setVolume({ assetId, volume: this._effectiveVolume() }) } catch (_) {}
    }
  }

  _onNativeTime(ev) {
    // ev: { assetId, currentTime, duration }
    const idx = this._indexFromAssetId(ev.assetId)
    if (idx === null || idx !== this.trackIndex) return
    this._lastTimeEventAt = Date.now()   // 供启动看门狗判断"真的出过声"
    const off = this.tracks[idx]?.startOffset || 0
    this.currentBookTime = off + (ev.currentTime || 0)
    this._timeListened += 1     // currentTime 事件约 1s 一次，近似累计
    this._emitTime()
    this._syncProgress()
  }

  _onNativeState(ev) {
    // 远程控制（锁屏/通知栏）也会触发这里，UI 必须跟着变
    const playing = ev?.state === 'playing'
    if (typeof ev?.currentTime === 'number') {
      const idx = this._indexFromAssetId(ev.assetId)
      if (idx !== null) {
        this.currentBookTime = (this.tracks[idx]?.startOffset || 0) + ev.currentTime
        this._emitTime()
      }
    }

    // ⚠️ "未在播"事件不能盲信：ExoPlayer 缓冲中、音频焦点被短暂抢占时
    // asset.isPlaying() 会闪回 false，插件据此发 paused/stopped ——
    // 但声音实际还在播。历史上这一下把 UI 从暂停键翻回播放键
    // （老板实测："正在播放时中间还是播放键"）。
    // 但也不能盲拒（之前 15s 容忍窗口的教训）：用户按锁屏暂停/拔耳机时
    // 原生层是真停了，UI 必须跟着翻回播放键，否则就是"假播放"。
    // 正确姿势：收到"未在播"→ 立即反查原生层真实状态（asset.isPlaying()），
    // 真停才翻，抖动维持原状。
    if (!playing && this._wantPlaying) {
      this._resolveRealPause(ev)
      return
    }

    this._starting = false
    this.buffering = false
    this.playing = playing
    this.onState({ state: ev?.state || (playing ? 'playing' : 'paused'), isPlaying: playing, reason: ev?.reason })
  }

  /**
   * 收到"未在播"事件后，向原生层核实到底停没停。
   * 核实期间 UI 保持当前状态（不闪），结果回来后一次性校准：
   *   真的停了 → 按暂停处理（用户意图标记一并清掉）
   *   还在播   → 维持播放态，视为缓冲/焦点抖动，UI 不动
   */
  _resolveRealPause(ev) {
    if (this._verifyingPause) return
    this._verifyingPause = true
    // 缓冲观感：短暂转圈比错误地显示"播放键"好 —— 用户知道在干活
    if (!this.buffering && this.playing) {
      this.buffering = true
      this.onState({ state: 'buffering', isPlaying: true, reason: ev?.reason })
    }
    const finish = (reallyPaused) => {
      this._verifyingPause = false
      if (reallyPaused) {
        // 原生层真停了：接受现实（锁屏暂停/拔耳机/系统抢占且未恢复）
        this._starting = false
        this.buffering = false
        this.playing = false
        this.onState({ state: 'paused', isPlaying: false, reason: ev?.reason || 'native-confirmed-pause' })
      } else {
        // 还在播：抖动，维持播放态
        this.buffering = false
        this.playing = true
        this.onState({ state: 'playing', isPlaying: true, reason: 'native-confirmed-playing' })
      }
    }
    let settled = false
    const settle = v => { if (!settled) { settled = true; finish(v) } }
    // 反查原生真值（若反查失败，短超时后按"还在播"兜底 —— 与用户意图一致，
    // 也避免把真在播的会话错杀成暂停）
    try {
      NativeAudio.isPlaying({ assetId: this._assetId(this.trackIndex) })
        .then(r => settle(!!(r && r.isPlaying === false)))
        .catch(() => setTimeout(() => settle(false), 400))
    } catch (_) {
      setTimeout(() => settle(false), 400)
    }
    // 硬超时：防止原生桥卡死让 UI 永远停在转圈
    setTimeout(() => settle(false), 2500)
  }

  /** 返回 Promise，便于调用方（含测试）等待换集真正完成 */
  async _onTrackEnd(ev) {
    // ⚠️ 必须校验 assetId：换集时被停掉的旧音轨可能延迟抛出 complete，
    // 不校验就会把刚选的新集又推进一集（表现为"选集后自己跳走"）。
    if (ev && ev.assetId) {
      const idx = this._indexFromAssetId(ev.assetId)
      if (idx !== null && idx !== this.trackIndex) return
    }
    // 睡眠定时·按章节（老板 2026-09-16）：本集播完算消耗一次，
    // 听满 N 集/首 → 停在这里，**不**推进下一集。
    //
    // ⚠️ 必须在**单曲循环/乱序分支之前**：放在后面时「单曲循环 + 按章节定时」
    // 会永远不计数（repeat 分支先 return 了），定时形同不存在（审计发现）。
    // 语义：每"听完一遍"算一次，无论接下来是循环本曲、随机跳还是顺序接下一集。
    if (this.onBeforeAdvance && this.onBeforeAdvance()) {
      // 本集已经自然播完，这里只需把状态收干净：不推进下一集、不让 UI 继续显示"播放中"。
      // 走 pause() 而不是只手改标志位 —— 它会真正下发原生 pause 并立刻回写进度，
      // 保证"停"是真的停（原生层不会再出声、服务器进度落在本集末尾）。
      // 注：sleep 模块的 firePause() 也会 pause 一次（它那条不 await）—— pause 幂等，
      // 这里再 await 一次是为了确定性（不指望另一条路径的时序）。
      const cur = this.tracks[this.trackIndex]
      this.currentBookTime = (cur?.startOffset || 0) + (cur?.duration || 0)
      try {
        await this.pause()
      } catch (_) {
        // 原生 pause 失败也要把内部状态收干净，否则 UI 停在"播放中"却没声音
        this.playing = false
        this.buffering = false
        this._wantPlaying = false
        this._starting = false
        this.onState({ state: 'paused', isPlaying: false, reason: 'sleep-stop' })
      }
      return
    }
    // 单曲循环（老板 2026-09-14）：本轨播完从头再来这一轨。
    // 注意 seek 用本轨起点（startOffset），autoPlay=true 保证循环不断声。
    if (this.playMode === 'repeat') {
      await this.seek(this.tracks[this.trackIndex]?.startOffset || 0, { autoPlay: true })
      return
    }
    // 乱序播放：自动接续时随机跳一首（手动 nextTrack 同逻辑）。
    // _gotoTrack 内部已按"当前是否在播"决定要不要接着播，这里不要再 play 一次。
    if (this.playMode === 'shuffle' && this.tracks.length > 1) {
      await this._gotoTrack(this._randomOtherIndex())
      return
    }
    // 单条音轨播完 → 自动下一集；最后一集 → 结束
    if (this.trackIndex < this.tracks.length - 1) {
      // 必须 await：否则换集过程中的异常会变成静默的未处理拒绝
      await this._gotoTrack(this.trackIndex + 1)
    } else {
      if (this._endedFired) return
      this._endedFired = true
      this.playing = false
      this.currentBookTime = this.duration
      this._emitTime()
      this.onEnd()
      // 整本听完 → 睡眠定时的剩余计数静默清零（不加这句，残留计数会带到下一本书：
      // 新书刚听 1 集就被莫名暂停 —— 第 4 轮审计发现）
      try { this.onBookEnd && this.onBookEnd() } catch (_) {}
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
    // 家长音量上限：web 回退引擎同样每次装轨都套（见 _nativeLoadTrack 同款修复）
    this._audio.volume = this._effectiveVolume()
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

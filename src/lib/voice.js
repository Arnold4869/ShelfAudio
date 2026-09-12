/**
 * 语音识别 + 语音指令解析
 * 用系统自带识别（iOS SFSpeechRecognizer / Android SpeechRecognizer），免费、中文好、不需要自建服务。
 *
 * ⚠️ 事件模型（插件 8.2.0 实测，README 明确写了）：
 *   partialResults: true 时 `start()` **立即 resolve**，识别结果通过
 *   `partialResults` 监听器流式返回，直到会话结束。
 *   所以 **绝不能** 在 start() 返回后就 stop() —— 那等于刚开口就被掐断
 *   （这正是"话没说完就退出、什么都没识别到"的根因）。
 *
 * 正确流程：
 *   addListener(partialResults) → start() → 等用户说完/静音/超时
 *   → 用最后一次 partial 结果作为识别结果 → stop() → 清理监听
 */
import { SpeechRecognition } from '@capgo/capacitor-speech-recognition'
import { checkVoicePermission, requestVoicePermission } from './permissions.js'

// ---------------- 中文数字解析 ----------------
const CN_DIGIT = { 零: 0, 〇: 0, 一: 1, 壹: 1, 二: 2, 两: 2, 俩: 2, 贰: 2, 三: 3, 叁: 3, 四: 4, 肆: 4, 五: 5, 伍: 5, 六: 6, 陆: 6, 七: 7, 柒: 7, 八: 8, 捌: 8, 九: 9, 玖: 9 }
const CN_UNIT = { 十: 10, 拾: 10, 百: 100, 佰: 100, 千: 1000, 仟: 1000 }

/**
 * 把中文数字串转成数字，支持：
 *   五 → 5 | 十 → 10 | 十五 → 15 | 三十 → 30 | 四十五 → 45
 *   一点五 → 1.5 | 两 → 2 | 半 → 0.5
 * 返回 null 表示无法解析。
 */
export function cnNum(s) {
  if (!s) return null
  s = String(s).trim()
  if (/^\d+(\.\d+)?$/.test(s)) return parseFloat(s)

  const dotIdx = s.indexOf('点')
  if (dotIdx >= 0) {
    const intPart = s.slice(0, dotIdx)
    const fracPart = s.slice(dotIdx + 1)
    const intVal = intPart === '' ? 0 : (cnNum(intPart) ?? 0)
    if (!fracPart) return intVal
    let frac = ''
    for (const ch of fracPart) {
      const d = CN_DIGIT[ch]
      if (d === undefined) return null
      frac += String(d)
    }
    return parseFloat(`${intVal}.${frac}`)
  }

  if (s === '半') return 0.5

  let total = 0, section = 0, found = false
  for (const ch of s) {
    if (ch in CN_DIGIT) { section = CN_DIGIT[ch]; found = true }
    else if (ch in CN_UNIT) {
      total += (section === 0 ? 1 : section) * CN_UNIT[ch]
      section = 0; found = true
    } else return null
  }
  return found ? total + section : null
}

const NUM_CHARS = '0-9零〇一壹二两俩贰三叁四肆五伍六陆七柒八捌九玖十拾百佰千仟点半'

export function voiceSupported() {
  try {
    return !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform())
  } catch (_) { return false }
}

/**
 * 确保有权限。
 * ⚠️ 插件只返回 speechRecognition 字段，没有 microphone 字段
 * （Android 该 alias 底层就是 RECORD_AUDIO；iOS 的 requestPermissions 会连着申请麦克风）。
 *
 * 返回 { granted, needsSettings }
 */
export async function ensurePermission() {
  const cur = await checkVoicePermission()
  if (cur.granted) return { granted: true, needsSettings: false }
  if (cur.canAsk) {
    const req = await requestVoicePermission()
    return { granted: req.granted, needsSettings: !req.granted }
  }
  const retry = await requestVoicePermission()
  return { granted: retry.granted, needsSettings: !retry.granted }
}

/**
 * 解析语音指令
 *  intent: 'search' | 'play' | 'pause' | 'next' | 'prev' | 'louder' | 'quieter' | 'rate' | 'sleep' | 'unknown'
 */
export function parseCommand(text) {
  const t = (text || '').replace(/\s+/g, '').replace(/[，。！？,.!?、；;]/g, '')
  if (!t) return { intent: 'unknown' }

  if (/(大声|声音大|大点声|大一点声|调大|音量加|音量大|大声一点)/.test(t)) return { intent: 'louder' }
  if (/(小声|声音小|小点声|小一点声|调小|音量减|音量小|小声一点)/.test(t)) return { intent: 'quieter' }

  const rateM = t.match(new RegExp(`([${NUM_CHARS}]+)\\s*倍`))
  if (rateM) {
    const v = cnNum(rateM[1])
    if (v !== null && v >= 0.5 && v <= 4) return { intent: 'rate', rate: v }
  }
  if (/(正常速度|原速|正常语速)/.test(t)) return { intent: 'rate', rate: 1 }

  if (/(定时|睡眠|睡后|听完|关闭|关掉|停止|暂停)/.test(t)) {
    const unitM = t.match(new RegExp(`([${NUM_CHARS}]+)\\s*(分钟|小时|钟头)`))
    if (unitM) {
      let n = cnNum(unitM[1])
      if (n !== null) {
        if (unitM[2] !== '分钟') n *= 60
        return { intent: 'sleep', minutes: Math.round(n) }
      }
    }
    if (/半\s*小时/.test(t)) return { intent: 'sleep', minutes: 30 }
  }

  if (/(暂停|停一下|停下|别播了|不听了)/.test(t)) return { intent: 'pause' }
  if (/(上一集|上一条|上一个|前一集|往回)/.test(t)) return { intent: 'prev' }
  if (/(下一集|下一条|下一个|后一集|跳过)/.test(t)) return { intent: 'next' }
  if (/^(继续播放|接着播|继续听|接着听|播放|继续|恢复播放)$/.test(t)) return { intent: 'play' }

  let q = t.replace(/^(我要听|我想听|我想看|播放|放一下|放|找一下|找找|找|搜索|搜|查一下|听|打开|来一段|来一本)/, '')
  if (!q) q = t
  return { intent: 'search', query: q }
}

// ---------------- 识别会话 ----------------
let activeSession = null

function errCodeText(code) {
  const map = {
    'MICROPHONE_PERMISSION_DENIED': '麦克风权限被拒绝',
    'SPEECH_PERMISSION_DENIED': '语音识别权限被拒绝',
    'NO_SPEECH': '没听清，再说一次',
    'NO_MATCH': '没听清，再说一次',
    'RECOGNIZER_NOT_AVAILABLE': '这台设备没有可用的语音识别',
    'ON_DEVICE_RECOGNITION_UNAVAILABLE': '这台设备不支持离线语音识别',
    'NETWORK': '语音识别需要联网',
  }
  return map[code] || null
}

/**
 * 启动一次语音输入（点一下开始说话，说完自动结束）
 *
 * @param {object} opts
 *   onStart()            会话真正开始（已能收音）时回调
 *   onPartial(text)      实时识别文本
 *   onResult(text)       最终结果
 *   onError(msg, meta)   失败；meta.needsSettings=true 表示要去系统设置
 *   durationMs           最长听多久（默认 12000）
 *   silenceMs            说完了判定静音多久（默认 2200）
 */
export async function listen({ onStart, onPartial, onResult, onError, durationMs = 12000, silenceMs = 2200 } = {}) {
  if (!voiceSupported()) { onError?.('设备不支持语音识别', { needsSettings: false }); return }
  const perm = await ensurePermission()
  if (!perm.granted) {
    onError?.(perm.needsSettings ? '麦克风权限被拒绝，需要到系统设置里打开' : '没有麦克风或语音识别权限',
             { needsSettings: perm.needsSettings })
    return
  }

  await forceStopCurrent()

  // 记下语音开始前是否在播放：系统抢占音频会把播放状态打成 paused，
  // 结束后要凭这个"快照"决定是否恢复播放。
  const wasPlayingBefore = (() => {
    try { return !!window.__saPlayer?.playing } catch (_) { return false }
  })()

  const listeners = []
  let lastPartial = ''
  let settled = false
  let sawStarted = false
  let startedAt = 0
  let silenceTimer = null
  let hardTimer = null

  const cleanup = async () => {
    clearTimeout(silenceTimer); clearTimeout(hardTimer)
    for (const l of listeners) { try { await l.remove() } catch (_) {} }
    listeners.length = 0
    try { await SpeechRecognition.stop() } catch (_) {}
    activeSession = null
    // 恢复音频会话：语音识别在 iOS 上会把 AVAudioSession 改成
    // .playAndRecord + .defaultToSpeaker（强制扬声器），不抢回来
    // 之后的有声书播放会一直走外放、蓝牙耳机失效。
    // 动态 import 避免与 player.js 形成静态循环依赖。
    try {
      const { BookPlayer } = await import('./player.js')
      await BookPlayer.reassertSession()
      // 会话被语音打断后需要重新激活，否则"恢复播放"没声音。
      // 传快照：系统打断已把 playing 打成 false，不看快照会漏恢复。
      await window.__saPlayer?.resumeAfterVoice?.(wasPlayingBefore)
    } catch (_) {}
  }

  const finish = async (text, isError, extra) => {
    if (settled) return
    settled = true
    activeSession = null
    // 先取最后一次 partial：插件会缓存，防止静音结束时丢字
    let finalText = text || ''
    if (!isError && !finalText) {
      try {
        const cached = await SpeechRecognition.getLastPartialResult()
        finalText = cached?.text || cached?.matches?.[0] || ''
      } catch (_) {}
    }
    await cleanup()
    if (isError) onError?.(extra?.msg || '语音识别失败', extra)
    else if (finalText) onResult?.(finalText)
    else onError?.('没听清，再说一次', { needsSettings: false })
  }

  // 把会话句柄暴露出去，浮层可以"说完了"提前收尾（且不丢已识别的字）
  activeSession = {
    stopNow: () => finish(lastPartial, false),
    getText: () => lastPartial,
    isSettled: () => settled,
  }

  // 说完后等一小会儿确认没有续词，再定结果
  const armSilence = () => {
    clearTimeout(silenceTimer)
    silenceTimer = setTimeout(() => finish(lastPartial, false), silenceMs)
  }

  try {
    listeners.push(await SpeechRecognition.addListener('partialResults', ev => {
      const text = (ev?.matches?.[0] || ev?.accumulatedText || '').trim()
      if (!text) return
      // 插件返回的可能是"本轮"而非累计，取更长的那个，避免文本变短丢词
      lastPartial = text.length >= lastPartial.length ? text : lastPartial
      onPartial?.(lastPartial)
      if (sawStarted) armSilence()
    }))

    listeners.push(await SpeechRecognition.addListener('listeningState', ev => {
      const st = ev?.state || ev?.status
      if (st === 'started' && !sawStarted) {
        sawStarted = true
        startedAt = Date.now()
        onStart?.()
        // 最长收音时间兜底，避免一直挂着
        hardTimer = setTimeout(() => {
          // 已经拿到文字就出结果，否则提示
          if (lastPartial) finish(lastPartial, false)
          else finish('', true, { msg: '没听到声音，再试一次' })
        }, durationMs)
        armSilence()
      } else if (st === 'stopped') {
        // 系统自然结束（说完/静音）：出结果
        if (!settled) finish(lastPartial, false)
      }
    }))

    listeners.push(await SpeechRecognition.addListener('error', ev => {
      const code = ev?.code || ''
      const msg = errCodeText(code) || ev?.message || '语音识别出错'
      const needsSettings = /PERMISSION_DENIED/.test(code)
      finish('', true, { msg, needsSettings })
    }))

    // start() 在 partialResults:true 时立即 resolve，不代表说完
    await SpeechRecognition.start({
      language: 'zh-CN',
      maxResults: 3,
      partialResults: true,
      popup: false,
    })

    // 兜底：若 listeningState 的 started 事件没来（部分机型），也给个超时保护
    setTimeout(() => {
      if (!settled && !sawStarted) {
        // start 已 resolve 但没收到 started：按开始处理
        sawStarted = true
        startedAt = Date.now()
        onStart?.()
        hardTimer = setTimeout(() => {
          if (lastPartial) finish(lastPartial, false)
          else finish('', true, { msg: '没听到声音，再试一次' })
        }, durationMs)
        armSilence()
      }
    }, 1200)
  } catch (e) {
    const msg = String(e?.message || e)
    if (/no speech|no match/i.test(msg)) finish('', true, { msg: '没听清，再说一次' })
    else if (/denied|permission/i.test(msg)) finish('', true, { msg: '麦克风权限被拒绝', needsSettings: true })
    else finish('', true, { msg: '语音识别失败：' + msg })
  }
}

/** 用户点「说完了」：用当前已识别文本收尾（不会丢掉已经识别出的字） */
export async function finishListening() {
  if (activeSession && !activeSession.isSettled()) {
    activeSession.stopNow()
    return true
  }
  return false
}

/** 取当前已识别文本（浮层预览用） */
export function currentText() {
  return activeSession?.getText?.() || ''
}

/** 硬停：中断当前会话（清理监听 + 释放原生资源） */
export async function forceStopCurrent() {
  activeSession = null
  try { await SpeechRecognition.stop() } catch (_) {}
}

/** 兼容旧调用名 */
export const stopListening = forceStopCurrent

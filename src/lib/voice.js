/**
 * 语音识别 + 语音指令解析
 * 用系统自带识别（iOS SFSpeechRecognizer / Android SpeechRecognizer），免费、中文好、不需要自建服务。
 * 识别结果既可用于搜索，也能识别播放指令。
 */
import { SpeechRecognition } from '@capgo/capacitor-speech-recognition'

let rec = null

export function voiceSupported() {
  try {
    return !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform())
  } catch (_) { return false }
}

export async function ensurePermission() {
  try {
    const perms = await SpeechRecognition.checkPermissions()
    if (perms?.speechRecognition !== 'granted' || perms?.microphone !== 'granted') {
      const req = await SpeechRecognition.requestPermissions()
      if (req?.speechRecognition !== 'granted' || req?.microphone !== 'granted') return false
    }
    return true
  } catch (e) {
    console.warn('语音权限申请失败', e)
    return false
  }
}

/**
 * 解析语音指令
 * 返回 { intent, query, volumeDelta, rate, minutes }
 *  intent: 'search' | 'play' | 'pause' | 'next' | 'prev' | 'louder' | 'quieter' | 'rate' | 'sleep' | 'unknown'
 */
export function parseCommand(text) {
  const t = (text || '').replace(/\s+/g, '').replace(/[，。！？,.!?]/g, '')

  // 音量
  if (/(大声|声音大|大点声|调大|音量加|音量大)/.test(t)) return { intent: 'louder' }
  if (/(小声|声音小|小点声|调小|音量减|音量小)/.test(t)) return { intent: 'quieter' }

  // 倍速
  const rateM = t.match(/([0-9一二三四五六]+)\s*倍/)
  if (rateM) {
    const map = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6 }
    let v = map[rateM[1]] ?? parseFloat(rateM[1])
    if (v > 6) v = v / 10   // "一点五倍" → 15 → 1.5
    if (v >= 0.5 && v <= 3) return { intent: 'rate', rate: v }
  }
  if (/(正常速度|原速)/.test(t)) return { intent: 'rate', rate: 1 }

  // 睡眠定时
  const sleepM = t.match(/([0-9一二三四五六七八九十]+)\s*(分钟|小时)/)
  if (sleepM && /(定时|睡眠|听完|睡后|关掉|关闭|停止)/.test(t)) {
    const map = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 }
    let n = map[sleepM[1]] ?? parseInt(sleepM[1], 10)
    if (sleepM[2] === '小时') n *= 60
    return { intent: 'sleep', minutes: n }
  }

  // 播放控制
  if (/(暂停|停一下|别播了|不听了)/.test(t)) return { intent: 'pause' }
  if (/(上一集|上一个|前一集|往回)/.test(t)) return { intent: 'prev' }
  if (/(下一集|下一个|后一集|跳过|快进到下一)/.test(t)) return { intent: 'next' }
  if (/(继续播放|接着播|继续听|接着听|播放)/.test(t) && t.length <= 6) return { intent: 'play' }

  // 剩下的都当搜索词：去掉动词前缀
  let q = t.replace(/^(我要听|我想听|播放|放一下|找一下|找找|找|搜索|搜|听|打开)/, '')
  if (!q) q = t
  return { intent: 'search', query: q }
}

/**
 * 启动一次语音输入
 * onPartial(text) / onResult(text) / onError(msg)
 */
export async function listen({ onPartial, onResult, onError, language = 'zh-CN' } = {}) {
  if (!voiceSupported()) { onError?.('设备不支持语音识别'); return }
  const ok = await ensurePermission()
  if (!ok) { onError?.('没有麦克风或语音识别权限'); return }

  const listeners = []

  const cleanup = async () => {
    for (const l of listeners) { try { await l.remove() } catch (_) {} }
    try { await SpeechRecognition.stop() } catch (_) {}
  }

  try {
    listeners.push(await SpeechRecognition.addListener('partialResults', d => {
      const text = d?.matches?.[0] || ''
      if (text) onPartial?.(text)
    }))
    listeners.push(await SpeechRecognition.addListener('listeningState', d => {
      if (d?.status === 'stopped') onPartial?.('')
    }))

    const res = await SpeechRecognition.start({
      language,
      maxResults: 3,
      prompt: '',
      partialResults: true,
      popup: false,
    })
    const text = res?.matches?.[0] || ''
    await cleanup()
    if (text) onResult?.(text)
    else onError?.('没听清，再说一次')
  } catch (e) {
    await cleanup()
    const msg = String(e?.message || e)
    if (/no speech|no match|No match/i.test(msg)) onError?.('没听清，再说一次')
    else if (/denied|permission/i.test(msg)) onError?.('麦克风权限被拒绝')
    else onError?.('语音识别失败')
  }
}

export async function stopListening() {
  try { await SpeechRecognition.stop() } catch (_) {}
}

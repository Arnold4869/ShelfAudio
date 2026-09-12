/**
 * 语音识别 + 语音指令解析
 * 用系统自带识别（iOS SFSpeechRecognizer / Android SpeechRecognizer），免费、中文好、不需要自建服务。
 * 识别结果既可用于搜索，也能识别播放指令。
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
  // 已经是阿拉伯数字（含小数）
  if (/^\d+(\.\d+)?$/.test(s)) return parseFloat(s)

  // 小数：X点Y  → 1.5 这种；"点" 前可有中文数字，后为逐位读法
  const dotIdx = s.indexOf('点')
  if (dotIdx >= 0) {
    const intPart = s.slice(0, dotIdx)
    const fracPart = s.slice(dotIdx + 1)
    const intVal = intPart === '' ? 0 : (cnNum(intPart) ?? 0)
    if (!fracPart) return intVal
    // 小数部分逐位：五 → 5 即 .5；二五 → .25
    let frac = ''
    for (const ch of fracPart) {
      const d = CN_DIGIT[ch]
      if (d === undefined) return null
      frac += String(d)
    }
    return parseFloat(`${intVal}.${frac}`)
  }

  // 纯 "半"
  if (s === '半') return 0.5

  // 整数：累加式解析（十=10, 十五=15, 三十=30, 一百二十=120）
  let total = 0, section = 0, found = false
  for (const ch of s) {
    if (ch in CN_DIGIT) {
      section = CN_DIGIT[ch]
      found = true
    } else if (ch in CN_UNIT) {
      const unit = CN_UNIT[ch]
      // "十五"：十前面没有数字时按 1 算
      total += (section === 0 ? 1 : section) * unit
      section = 0
      found = true
    } else {
      return null
    }
  }
  return found ? total + section : null
}

const NUM_CHARS = '0-9零〇一壹二两俩贰三叁四肆五伍六陆七柒八捌九玖十拾百佰千仟点半'

let rec = null

export function voiceSupported() {
  try {
    return !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform())
  } catch (_) { return false }
}

/**
 * 确保有权限。
 * ⚠️ 插件只返回 speechRecognition 字段，没有 microphone 字段
 * （Android 该 alias 底层就是 RECORD_AUDIO；iOS 的 requestPermissions 会连着申请麦克风）。
 * 旧代码判断 `perms.microphone !== 'granted'` → 恒真 → 永远报无权限，已修。
 *
 * 返回 { granted, needsSettings }：needsSettings=true 表示系统不再弹窗，必须去设置里开。
 */
export async function ensurePermission() {
  const cur = await checkVoicePermission()
  if (cur.granted) return { granted: true, needsSettings: false }
  if (cur.canAsk) {
    const req = await requestVoicePermission()
    if (req.granted) return { granted: true, needsSettings: false }
    return { granted: false, needsSettings: true }
  }
  // prompt 之外但非 denied（如 error/web）也再试一次申请，失败就引导设置
  const retry = await requestVoicePermission()
  return { granted: retry.granted, needsSettings: !retry.granted }
}

/**
 * 解析语音指令
 * 返回 { intent, query, volumeDelta, rate, minutes }
 *  intent: 'search' | 'play' | 'pause' | 'next' | 'prev' | 'louder' | 'quieter' | 'rate' | 'sleep' | 'unknown'
 */
export function parseCommand(text) {
  const t = (text || '').replace(/\s+/g, '').replace(/[，。！？,.!?、；;]/g, '')
  if (!t) return { intent: 'unknown' }

  // 音量
  if (/(大声|声音大|大点声|大一点声|调大|音量加|音量大|大声一点)/.test(t)) return { intent: 'louder' }
  if (/(小声|声音小|小点声|小一点声|调小|音量减|音量小|小声一点)/.test(t)) return { intent: 'quieter' }

  // 倍速：X倍 / X倍速（支持 1.5倍、两倍、一倍半）
  const rateM = t.match(new RegExp(`([${NUM_CHARS}]+)\\s*倍`))
  if (rateM) {
    const v = cnNum(rateM[1])
    if (v !== null && v >= 0.5 && v <= 4) return { intent: 'rate', rate: v }
  }
  if (/(正常速度|原速|正常语速)/.test(t)) return { intent: 'rate', rate: 1 }

  // 睡眠定时：X分钟后关闭 / 定时X分钟 / X小时
  if (/(定时|睡眠|睡后|听完|关闭|关掉|停止|暂停)/.test(t)) {
    const unitM = t.match(new RegExp(`([${NUM_CHARS}]+)\\s*(分钟|小时|钟头)`))
    if (unitM) {
      let n = cnNum(unitM[1])
      if (n !== null) {
        if (unitM[2] !== '分钟') n *= 60
        return { intent: 'sleep', minutes: Math.round(n) }
      }
    }
    // "半小时后关闭"
    if (/半\s*小时/.test(t)) return { intent: 'sleep', minutes: 30 }
  }

  // 播放控制
  if (/(暂停|停一下|停下|别播了|不听了)/.test(t)) return { intent: 'pause' }
  if (/(上一集|上一条|上一个|前一集|往回)/.test(t)) return { intent: 'prev' }
  if (/(下一集|下一条|下一个|后一集|跳过)/.test(t)) return { intent: 'next' }
  if (/^(继续播放|接着播|继续听|接着听|播放|继续|恢复播放)$/.test(t)) return { intent: 'play' }

  // 剩下的都当搜索词：去掉动词前缀
  let q = t.replace(/^(我要听|我想听|我想看|播放|放一下|放|找一下|找找|找|搜索|搜|查一下|听|打开|来一段|来一本)/, '')
  if (!q) q = t
  return { intent: 'search', query: q }
}

/**
 * 启动一次语音输入
 * onPartial(text) / onResult(text) / onError(msg)
 */
export async function listen({ onPartial, onResult, onError, language = 'zh-CN' } = {}) {
  if (!voiceSupported()) { onError?.('设备不支持语音识别', { needsSettings: false }); return }
  const perm = await ensurePermission()
  if (!perm.granted) {
    onError?.(perm.needsSettings ? '麦克风权限被拒绝，需要到系统设置里打开' : '没有麦克风或语音识别权限',
             { needsSettings: perm.needsSettings })
    return
  }

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

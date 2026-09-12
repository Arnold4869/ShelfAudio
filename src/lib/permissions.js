/**
 * 麦克风 / 语音识别权限管理
 *
 * ⚠️ 插件返回值只有 speechRecognition 一个字段（实测 @capgo/capacitor-speech-recognition 8.2.0）：
 *   - Android: alias = SPEECH_RECOGNITION，底层就是 RECORD_AUDIO 权限
 *   - iOS: checkPermissions 只返回语音识别状态；requestPermissions 会依次申请
 *          「语音识别」+「麦克风」两项，任一被拒都返回 denied
 *   没有 microphone 字段！早期代码判断 `perms.microphone !== 'granted'` 导致
 *   永远判定为无权限（undefined !== 'granted' 恒真），这是「给了权限仍报没权限」的根因。
 *
 * 状态取值来自 Capacitor PermissionState: 'prompt' | 'prompt-with-rationale' | 'granted' | 'denied'
 *   - prompt / prompt-with-rationale → 还没问过，或还能再弹窗
 *   - denied → 用户拒绝过，系统不再弹窗（iOS 必须去设置里手动开）
 */
import { SpeechRecognition } from '@capgo/capacitor-speech-recognition'
import { NativeSettings, AndroidSettings, IOSSettings } from 'capacitor-native-settings'

export function isNativeShell() {
  try {
    return !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform())
  } catch (_) { return false }
}

/** 只读查询，不弹窗 */
export async function checkVoicePermission() {
  if (!isNativeShell()) return { state: 'web', granted: false, canAsk: false }
  try {
    const res = await SpeechRecognition.checkPermissions()
    const state = res?.speechRecognition || 'prompt'
    return {
      state,
      granted: state === 'granted',
      // prompt / prompt-with-rationale 都还能通过代码弹窗申请
      canAsk: state === 'prompt' || state === 'prompt-with-rationale',
      needsSettings: state === 'denied',
    }
  } catch (e) {
    return { state: 'error', granted: false, canAsk: false, error: String(e?.message || e) }
  }
}

/**
 * 主动申请（会弹系统窗）
 * 返回 { granted, state, needsSettings }
 */
export async function requestVoicePermission() {
  if (!isNativeShell()) return { state: 'web', granted: false, needsSettings: false }
  try {
    const res = await SpeechRecognition.requestPermissions()
    const state = res?.speechRecognition || 'denied'
    return {
      state,
      granted: state === 'granted',
      needsSettings: state === 'denied',
    }
  } catch (e) {
    return { state: 'error', granted: false, needsSettings: true, error: String(e?.message || e) }
  }
}

/** 跳到本 App 的系统设置页（iOS 只有 App 页是官方支持的） */
export async function openSystemSettings() {
  if (!isNativeShell()) return false
  try {
    await NativeSettings.open({
      optionAndroid: AndroidSettings.ApplicationDetails,
      optionIOS: IOSSettings.App,
    })
    return true
  } catch (_) {
    // 退一步：只尝试当前平台
    try {
      await NativeSettings.openAndroid?.({ option: AndroidSettings.ApplicationDetails })
      return true
    } catch (_) {
      try {
        await NativeSettings.openIOS?.({ option: IOSSettings.App })
        return true
      } catch (_) { return false }
    }
  }
}

/** iOS 跳设置后回到前台时，系统权限可能已变，需要重新查 */
export function onAppResume(cb) {
  try {
    document.addEventListener('resume', cb)
    document.addEventListener('visibilitychange', () => { if (!document.hidden) cb() })
  } catch (_) {}
}

/**
 * 触感反馈（iOS 的 Taptic Engine / Android 的振动马达）
 *
 * 为什么单独封装：
 *  1. 插件在浏览器里没有实现，直接调用会抛异常 —— 必须静默降级，不能因为
 *     "震一下"失败就把按钮的主要功能（播放、切集）带崩。
 *  2. 统一语义：tap=轻（普通按钮）、select=中（切换类）、success/warn/error=通知类，
 *     避免每个页面各写一个 impact 风格导致手感不一致。
 *  3. 用户可以在设置里关掉（有些人讨厌手机震）。
 */
import { Haptics, ImpactStyle, NotificationType } from '@capacitor/haptics'
import { store, CONFIG_KEYS } from './store.js'

let enabled = true

/** 启动时读一次用户偏好 */
export async function initHaptics() {
  enabled = (await store.get(CONFIG_KEYS.haptics, '1')) !== '0'
}

export function setHaptics(on) {
  enabled = !!on
  return store.set(CONFIG_KEYS.haptics, on ? '1' : '0')
}

export function hapticsEnabled() { return enabled }

function native() {
  try {
    return !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform())
  } catch (_) { return false }
}

async function fire(kind) {
  if (!enabled || !native()) return
  try {
    if (kind === 'tap') await Haptics.impact({ style: ImpactStyle.Light })
    else if (kind === 'select') await Haptics.impact({ style: ImpactStyle.Medium })
    else if (kind === 'heavy') await Haptics.impact({ style: ImpactStyle.Heavy })
    else if (kind === 'success') await Haptics.notification({ type: NotificationType.Success })
    else if (kind === 'warn') await Haptics.notification({ type: NotificationType.Warning })
    else if (kind === 'error') await Haptics.notification({ type: NotificationType.Error })
  } catch (_) { /* 设备不支持就算了，绝不影响主流程 */ }
}

export const haptic = {
  tap: () => fire('tap'),           // 普通点击
  select: () => fire('select'),     // 切换/选中
  heavy: () => fire('heavy'),       // 长按/删除
  success: () => fire('success'),   // 操作成功
  warn: () => fire('warn'),
  error: () => fire('error'),
}

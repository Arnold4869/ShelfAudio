/**
 * 通知控制（老板 2026-09-13：锁屏控制要能用，普通通知可以关）
 *
 * Android 上有两条通知：
 *  A. 插件 MediaStyle 通知（ID 1001）—— 锁屏/下拉的播放控制（上一集/播放暂停/下一集），
 *     由 @capgo/capacitor-native-audio 的 showNotification 配置控制；
 *  B. App 自建的前台服务常驻通知（ID 8801）—— 只显示"正在播放 书名"，没有按钮，
 *     它的作用是保住前台服务不被系统杀（后台播放的必要条件），不能整个去掉。
 *
 * 「关闭普通通知」的实现：
 *  - A 保留（锁屏控制），B 降到最低存在感：
 *    通知渠道 importance 从 LOW 降到 NONE（无声、不显示在下拉栏，只在设置里可见）。
 *    Android 不允许"前台服务完全无通知"，这是系统限制 —— 但 importance=NONE 的
 *    渠道用户完全感知不到，效果等同关闭。
 *  - 渠道设置在 App 装好后只能改 importance（用户改的除外），改完对已有通知立即生效。
 *
 * 锁屏控制可用性（本文件 2026-09-13 检查结论）：
 *  插件源码（NativeAudio.java）里 MediaSession 已完整接线：
 *    setupMediaSession() 注册 play/pause/stop/rewind/ffwd/seekTo 回调，
 *    通知用 MediaStyle + 三个按钮，由 showNotification:true 打开。
 *    JS 侧监听 remotePlay/remotePause/remoteRewind/remoteFastForward 事件驱动 UI。
 *  ⚠️ 已知短板：onSeekTo/onFastForward 操作的是原生层当前资产，
 *     JS 侧靠 playbackState 事件同步 —— 大书换轨时若桥延迟会有短暂进度漂移，可接受。
 */
import { Capacitor } from '@capacitor/core'
import { registerPlugin } from '@capacitor/core'

/** 是否安卓原生环境（本功能仅 Android 有意义；iOS 通知由系统统一管理） */
export function isAndroid() {
  try { return Capacitor.getPlatform() === 'android' } catch (_) { return false }
}

const Fg = registerPlugin('ForegroundService')

/**
 * 设置通知显示模式。
 * @param {'normal'|'quiet'} mode normal=常驻通知（默认）；quiet=静默（锁屏控制保留）
 *
 * 实现走 App 自建 PlaybackService 的 ACTION_NOTIFICATION_MODE：
 * 服务里改通知渠道 importance。插件那条 MediaStyle 通知不动（那是锁屏控制本体）。
 */
export async function setNotificationMode(mode) {
  if (!isAndroid()) return
  try { await Fg.setNotificationMode({ mode }) } catch (e) {
    console.warn('setNotificationMode 失败', e)
  }
}

/**
 * Wi-Fi 自动缓存正在听的书（0.17.0 快速起播任务3）：
 * Wi-Fi 环境下后台把「正在听的书」当前集+下一集下到离线缓存，
 * 续播直接走本地文件，零网络等待。
 *
 * 设计要点：
 * - 决策集中在 faststart.decideAutoCache（纯函数、有测试），本文件只做接线
 * - 触发点：boot 后 / 进度同步后 / onAppResume / 网络恢复到 Wi-Fi
 * - 节流：同一次会话内最多每 5 分钟尝试一次（AUTO_CACHE_THROTTLE_MS）
 * - 后台串行队列一次一集（downloadTracks 内部逐集 downloadFile），绝不并发轰炸
 * - 正在播放时不触发（active=false 才动）；家长管控拦截时不触发
 * - 浏览器/web 环境 no-op（native=false）
 * - 失败全静默：自动缓存是纯增益，任何异常都不能打扰播放
 * - 不下载整本：每次只确保当前集+下一集（faststart.pickAutoCacheTracks）
 */
import { Network } from '@capacitor/network'
import { store, CONFIG_KEYS } from './store.js'
import { playbackGate } from './parental.js'
import { getItem } from './autocache-item.js'
import { downloadTracks, isTrackCached } from './offline.js'
import { isWifiLike, decideAutoCache, pickAutoCacheTracks } from './faststart.js'
import { state } from '../app.js'

function native() {
  try {
    return !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform())
  } catch (_) { return false }
}

const THROTTLE_KEY = 'autoCacheLastRun'

/** 上次自动缓存触发时间（store 持久化，重启后仍受节流保护） */
async function lastRunTs() {
  try { return Number(await store.get(THROTTLE_KEY, '0')) || 0 } catch (_) { return 0 }
}

/**
 * 自动缓存一轮（触发点都汇到这里；自身幂等、可被高频调用）。
 * 内部串行队列：并发调用排队执行，绝不两轮同时下载。
 */
let _queue = Promise.resolve()
export function autoCacheTick() {
  _queue = _queue.then(runOnce).catch(() => {})
  return _queue
}

async function runOnce() {
  try {
    const native = !!(
      window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform()
    )
    const enabled = (await store.get(CONFIG_KEYS.autoCacheEnabled, '1')) === '1'
    const [gate, net] = await Promise.all([
      playbackGate().catch(() => ({ blocked: true })),   // 管控判不了 → 当拦截（保守）
      native ? Network.getStatus().catch(() => null) : Promise.resolve(null),
    ])
    // 决策（faststart 纯函数）：开关/管控/Wi-Fi/原生/播放中/节流
    const c = state.current
    const go = decideAutoCache({
      enabled,
      gateBlocked: !!gate?.blocked,
      wifi: isWifiLike(net),
      native,
      active: !!(c && state.player && (state.player.playing || state.player._wantPlaying)),
      lastTs: await lastRunTs(),
    })
    if (!go) return
    await store.set(THROTTLE_KEY, String(Date.now()))
    const target = c
    if (!target?.item?.id) return

    // 详情取音轨表（与缓存管理页/播放页下载同口径：audioFiles[].ino 拼直链）
    const detail = await getItem(target.item.id)
    const audioFiles = detail?.media?.audioFiles || []
    if (!audioFiles.length) return
    const trackIndex = state.player?.trackIndex ?? 0
    const inos = pickAutoCacheTracks(trackIndex, audioFiles)
    if (!inos.length) return

    // 同一集不重复下载：索引里已有且文件在 → skipped（isTrackCached 判据与
    // downloadTracks 内部完全一致）。全部已缓存 = 什么都不用做。
    const need = []
    for (let i = 0; i < audioFiles.length; i++) {
      const ino = String(audioFiles[i]?.ino ?? '').trim()
      if (ino && inos.includes(ino) && !(await isTrackCached(target.item.id, i))) need.push(i)
    }
    if (!need.length) return

    const tracks = audioFiles.map((af, i) => ({
      index: i + 1,
      title: af.metaTags?.title || af.title || detail?.media?.chapters?.[i]?.title || `第${i + 1}集`,
      contentUrl: String(target.item?.id || '').startsWith('nd:')
        ? `/rest/stream?id=${encodeURIComponent(af.ino)}`
        : `/api/items/${target.item.id}/file/${af.ino}`,
      duration: af.duration || 0,
    }))
    await downloadTracks(
      target.item.id,
      target.title || detail?.media?.metadata?.title || '',
      tracks,
      need,
    )
  } catch (_) { /* 失败全静默：自动缓存是纯增益，不打扰用户 */ }
}

/** 网络恢复/变化到 Wi-Fi 时触发一轮（App 启动时由 app.js 注册一次） */
export function watchNetworkForAutoCache() {
  try {
    if (!native()) return
    Network.addListener('networkStatusChange', (status) => {
      if (isWifiLike(status)) autoCacheTick()
    })
  } catch (_) { /* 监听失败 = 没有网络恢复触发点，其它触发点仍生效 */ }
}

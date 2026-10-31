/**
 * 快速起播（0.17.0）：本地落点记忆 + 即时预热 + Wi-Fi 自动缓存的**决策层**。
 *
 * 为什么单独拆一个文件：决策逻辑必须能脱离 store / hub / Filesystem 单测
 * （scripts/test-faststart.mjs 直接 import 本文件的纯函数），接线只留薄薄一层。
 *
 * ── 任务1：本地落点记忆 + 启动即时预热 ──
 * 0.15/0.16 的预热链路（app.js warmupFirstContinue）要等 loadHistory()（网络）
 * 才知道「最近在听哪本、播到哪」。这个信息其实每次进度同步时就在手上 —— 存一份
 * 到本地 store（CONFIG_KEYS.lastListenWarm），boot() 里 hub.restore()（纯本地读）
 * 完成后立刻用它发起 warmup：起播预热从「等 3 个网络请求」提前到「登录态恢复即发」。
 * 现有 warmupFirstContinue() 原样保留、在其后照常跑（player.warmup 串行队列后到者赢，
 * 两者的落点来自同一服务器会话，目标不同时自然覆盖，无需去重）。
 *
 * fileTime 口径：与 warmupFirstContinue 的 acc 扫描一致 —— **本集内偏移**，
 * 不是整本书时间（warmup 的 position 直接给 pre-0 seek 用）。
 *
 * ── 任务3：Wi-Fi 自动缓存正在听的书 ──
 * Wi-Fi 下自动把「正在听的书」当前集+下一集下到离线缓存，续播零网络。
 * 触发条件集中在 decideAutoCache()（可测），频控由调用方持上次触发时间。
 */

/** 记录新鲜窗口：7 天没动过的「最近在听」不再当续播落点（可能早就换书/听完了） */
export const LAST_LISTEN_MAX_AGE_MS = 7 * 864e5

/** 自动缓存节流窗口：同一次会话内最多每 5 分钟尝试一次 */
export const AUTO_CACHE_THROTTLE_MS = 5 * 60e3

/** @param {number} v 任意值 → 有限数或 NaN */
function num(v) { const n = Number(v); return Number.isFinite(n) ? n : NaN }

/**
 * 记录是否还新鲜（任务1安全边界：过期直接跳过）。
 * 缺 ts / 非数 / 负数 一律当过期 —— 宁可不暖，不能用坏落点暖错位置。
 */
export function isFreshEnough(rec, now = Date.now()) {
  const ts = num(rec?.ts)
  if (!(ts > 0)) return false
  return now - ts <= LAST_LISTEN_MAX_AGE_MS
}

/**
 * 记录形状校验（缺字段直接跳过）：source 合法、itemId/ino 非空、
 * trackIndex 是非负整数、fileTime 是有限数。
 */
export function isValidLastListen(rec) {
  if (!rec || typeof rec !== 'object' || Array.isArray(rec)) return false
  if (rec.source !== 'abs' && rec.source !== 'nd') return false
  if (!String(rec.itemId || '').trim()) return false
  if (!String(rec.ino ?? '').trim()) return false
  const idx = num(rec.trackIndex)
  if (!Number.isInteger(idx) || idx < 0) return false
  if (!Number.isFinite(num(rec.fileTime))) return false
  return true
}

/**
 * 本地记录 → player.warmup 入参（任务1）。
 * URL 口径与 app.js warmupFirstContinue 完全一致：
 *   ABS: hub.trackUrl(`/api/items/<id>/file/<ino>`) + Bearer headers
 *   ND : hub.downloadUrl(itemId, `/rest/stream?id=<songId>`) + null headers
 * 直链拼不出来（该源未登录 / hub 异常）→ null，调用方跳过（不硬造 URL）。
 *
 * @param {object} rec   lastListenWarm 记录（已过 isValidLastListen）
 * @param {object|null} hub  servers.js 的 hub 门面
 * @returns {{itemId,url,headers,trackIndex,position}|null}
 */
export function buildWarmupPlan(rec, hub) {
  try {
    if (!rec || !hub || typeof hub !== 'object') return null
    const isNd = rec.source === 'nd'
    const rawId = String(rec.ino).trim()
    let url
    if (isNd) {
      url = typeof hub.downloadUrl === 'function'
        ? hub.downloadUrl(rec.itemId, `/rest/stream?id=${encodeURIComponent(rawId)}`)
        : ''
    } else {
      url = typeof hub.trackUrl === 'function'
        ? hub.trackUrl(`/api/items/${rec.itemId}/file/${rawId}`)
        : ''
    }
    if (!url) return null
    const headers = isNd ? null : (typeof hub.authHeaders === 'function' ? hub.authHeaders(rec.itemId) : null)
    return {
      itemId: rec.itemId,
      url,
      headers: isNd ? null : headers,
      trackIndex: Number(rec.trackIndex),
      position: Number(rec.fileTime),
    }
  } catch (_) { return null }
}

/**
 * @capacitor/network 的 ConnectionStatus 是否算 Wi-Fi。
 * 只有明确 connectionType==='wifi' 且已连接才算 —— 流量/未知一律不算
 * （自动缓存是「家里 Wi-Fi 顺手多下两集」，绝不能偷跑用户流量）。
 */
export function isWifiLike(status) {
  try {
    return !!(status && status.connected === true && status.connectionType === 'wifi')
  } catch (_) { return false }
}

/**
 * 自动缓存决策（任务3，纯函数、可测）。
 * @param {object} c
 * @param {boolean} c.enabled      设置开关（默认开）
 * @param {boolean} c.gateBlocked  playbackGate() 拦截（孩子到点/额度用完）
 * @param {boolean} c.wifi         isWifiLike(Network.getStatus())
 * @param {boolean} c.native       原生环境（浏览器 no-op）
 * @param {boolean} c.active       当前正在播放（播放中不下载，不抢播放路径）
 * @param {number}  c.lastTs       上次触发时间戳（0 = 从未触发）
 * @param {number}  [c.now]        注入时钟（测试用）
 */
export function decideAutoCache(c) {
  try {
    if (!c) return false
    if (c.enabled !== true) return false          // 默认开 → 调用方读缺省 '1' 后传 true
    if (c.gateBlocked) return false               // 家长管控拦截 → 绝不发起下载
    if (!c.native) return false                   // 浏览器/web 环境 no-op
    if (!c.wifi) return false                     // 只在 Wi-Fi
    if (c.active) return false                    // 正在播放 → 不抢播放路径
    const last = num(c.lastTs) || 0
    const now = num(c.now) || Date.now()
    if (last > 0 && now - last < AUTO_CACHE_THROTTLE_MS) return false   // 节流
    return true
  } catch (_) { return false }
}

/**
 * 当前集 + 下一集的 ino 候选（任务3，纯函数、可测）。
 * ino trim 归一（ND 的 songId / ABS 的 ino 都可能有空白残留）、剔除缺 ino 的集；
 * trackIndex 越界/负数归 0（与 warmupFirstContinue 的落点兜底同口径）。
 *
 * @param {number} trackIndex 当前集下标（0-based）
 * @param {Array<{ino?:string}>} audioFiles 详情接口的音轨表
 * @returns {string[]} 要确保已缓存的 ino 列表（长度 1~2）
 */
export function pickAutoCacheTracks(trackIndex, audioFiles) {
  try {
    const files = Array.isArray(audioFiles) ? audioFiles : []
    if (!files.length) return []
    let idx = Number(trackIndex)
    if (!Number.isInteger(idx) || idx < 0 || idx >= files.length) idx = 0
    const out = []
    for (let i = idx; i < Math.min(idx + 2, files.length); i++) {
      const ino = String(files[i]?.ino ?? '').trim()
      if (ino) out.push(ino)
    }
    return out
  } catch (_) { return [] }
}

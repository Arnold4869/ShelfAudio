/**
 * 离线缓存：把整本书（或单集）的音频下载到本机，之后不联网也能听。
 *
 * 为什么需要：孩子的场景是「出门在车上听」，家里 Wi-Fi 之外就没网了；
 * 而且外网反代偶尔不稳，缓存过的书能直接兜底。
 *
 * 关键约束（踩过的坑都写在这）：
 *  1. **鉴权**：ABS 的音频直链要 token。downloadFile 支持自定义 header，
 *     所以直接把 Authorization 传下去（不要用 ?token= 放 URL，容易被日志记下来）。
 *  2. **文件名**：audioFiles 的路径可能带中文/空格/斜杠，必须清洗成安全字符，
 *     否则 Filesystem 会报 "invalid path"。
 *  3. **重名**：不同书的同名集数会撞车 —— 目录结构按 bookId/集号，天然隔开。
 *  4. **磁盘**：音频很大（一本几十到几百 MB），下载前先查磁盘、下完再核对大小，
 *     不完整就删掉重下，绝不能留半个文件让播放器崩。
 *  5. **iOS/Android 路径差异**：iOS 的 Directory.Data 是沙盒，Android 也是私有目录，
 *     两者都能被原生播放器用 file:// 访问到 —— 但要 getUri() 拿真实 URI。
 */
import { Filesystem, Directory } from '@capacitor/filesystem'
import { store, CONFIG_KEYS } from './store.js'
import { hub } from './servers.js'

const INDEX_KEY = 'offlineIndex'
const ROOT = 'audio'          // 相对 Directory.Data 的根目录

function native() {
  try {
    return !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform())
  } catch (_) { return false }
}

/** 把任意字符串清洗成安全文件名（保留中文，去掉路径分隔符与保留字符） */
function safeName(s, fallback = 'file') {
  const out = String(s || '')
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')   // 非法字符
    .replace(/^\.+/, '')                          // 开头的点
    .trim()
    .slice(0, 80)
  return out || fallback
}

/** 目录：audio/<bookId>/ */
function bookDir(bookId) { return `${ROOT}/${safeName(bookId, 'book')}` }

/** 集文件名：001-标题.mp3（集号前缀保证顺序，也避免同名） */
function trackFile(idx, title, ext = 'mp3') {
  const n = String(idx + 1).padStart(3, '0')
  return `${n}-${safeName(title, 'track')}.${ext}`
}

/** 从 contentUrl 猜扩展名 */
function extOf(contentUrl = '') {
  const m = String(contentUrl).match(/\.([a-z0-9]{2,5})(?:\?|$)/i)
  const e = (m?.[1] || '').toLowerCase()
  return ['mp3', 'm4a', 'm4b', 'mp4', 'aac', 'ogg', 'opus', 'flac', 'wav'].includes(e) ? e : 'mp3'
}

// ---------------- 索引（本机记录了哪些书已缓存） ----------------
// 结构：{ [bookId]: { title, at, bytes, tracks: { [idx]: { path, size } } } }
async function index() {
  const v = await store.getJSON(INDEX_KEY, {})
  return v && typeof v === 'object' ? v : {}
}
async function setIndex(idx) { await store.setJSON(INDEX_KEY, idx) }

/** 已缓存信息（没有则 null） */
export async function offlineInfo(bookId) {
  const idx = await index()
  return idx[bookId] || null
}

/** 某本书是否已完整缓存 */
export async function isCached(bookId, trackCount) {
  const info = await offlineInfo(bookId)
  if (!info?.tracks) return false
  if (typeof trackCount === 'number' && trackCount > 0) {
    // 所有集都在才算完整缓存
    for (let i = 0; i < trackCount; i++) if (!info.tracks[i]) return false
    return true
  }
  return Object.keys(info.tracks).length > 0
}

/** 取某一集的本地 URI（已缓存才返回，否则 null）—— 播放器用它优先离线播放 */
export async function localTrackUri(bookId, idx) {
  const info = await offlineInfo(bookId)
  const t = info?.tracks?.[idx]
  if (!t?.path) return null
  try {
    // 确认文件真的还在（用户可能在系统里清过 App 数据）
    await Filesystem.stat({ path: t.path, directory: Directory.Data })
    const { uri } = await Filesystem.getUri({ path: t.path, directory: Directory.Data })
    return uri
  } catch (_) {
    // 文件没了 → 顺手把索引里的这条抹掉，避免一直返回坏路径
    if (info) { delete info.tracks[idx]; await setIndex({ ...(await index()), [bookId]: info }) }
    return null
  }
}

/**
 * 该书当前要播的**那一集**的本地 URI（未缓存/文件丢失 → null）。
 *
 * 性能（老板 2026-09-13 报「全缓存的书点历史记录没反应」）：
 * 旧版 localTrackMap 会把全书每一集都 stat+getUri 各一次 —— 536 集的书
 * = 1072 次原生桥调用（真机 0.5~3 秒纯等待），而播放器只会用到其中 1 条。
 * 播放中途换集时也是一次桥调用（player._nativeLoadTrack 内部按需查），
 * 与"提前把全部 536 条查好"相比用户无感知差异。
 */
export async function localTrackUriLazy(bookId, idx) {
  try { return await localTrackUri(bookId, idx) } catch (_) { return null }
}

// ---------------- 下载 ----------------
/** 预估已占用空间（字节） */
export async function cacheSize() {
  const idx = await index()
  return Object.values(idx).reduce((a, b) => a + (b.bytes || 0), 0)
}

/**
 * 下载一本书的全部音轨。
 * @param {object} book   { id, title, tracks:[{index,title,contentUrl,duration}] }
 * @param {(p:{done:number,total:number,pct:number,label:string})=>void} onProgress
 * @returns {Promise<{ok:number, fail:number}>}
 */
export async function downloadBook(book, onProgress = () => {}) {
  if (!native()) throw new Error('离线下载只在手机 App 里可用')
  const tracks = book.tracks || []
  if (!tracks.length) throw new Error('这本书没有音轨')

  const dir = bookDir(book.id)
  // 建目录（已存在会抛，忽略）
  try { await Filesystem.mkdir({ path: dir, directory: Directory.Data, recursive: true }) } catch (_) {}

  const idx = await index()
  const rec = idx[book.id] || { title: book.title || '', at: 0, bytes: 0, tracks: {} }
  rec.tracks = rec.tracks || {}
  rec.title = book.title || rec.title

  let ok = 0, fail = 0, totalBytes = 0

  for (let i = 0; i < tracks.length; i++) {
    const t = tracks[i]
    const n = typeof t.index === 'number' ? t.index - 1 : i   // tracks[].index 是 1-based
    const file = trackFile(n, t.title || `第${n + 1}集`, extOf(t.contentUrl))
    const path = `${dir}/${file}`
    onProgress({ done: i, total: tracks.length, pct: Math.round((i / tracks.length) * 100), label: t.title || `第${n + 1}集` })

    // 已下过且文件在 → 跳过
    try {
      const st = await Filesystem.stat({ path, directory: Directory.Data })
      if (st?.size > 0) {
        rec.tracks[n] = { path, size: st.size }
        totalBytes += st.size
        ok++
        continue
      }
    } catch (_) { /* 不存在，继续下 */ }

    try {
      const res = await Filesystem.downloadFile({
        // 多源（2026-09-14）：按书 id 分派到对应服务器拼直链 ——
        // ABS 是 /api/items/<id>/file/<ino> + Bearer；ND 是 /rest/stream?id=<songId> + URL 凭据。
        url: hub.downloadUrl(book.id, t.contentUrl, t.title),
        path,
        directory: Directory.Data,
        headers: hub.authHeaders(book.id),   // ABS 用 Bearer header；ND 返回空（凭据在 URL）
        connectTimeout: 30000,
        readTimeout: 120000,
      })
      // 核对大小：下载失败有时会留 0 字节文件
      const st = await Filesystem.stat({ path, directory: Directory.Data })
      if (!st?.size) throw new Error('文件为空')
      rec.tracks[n] = { path, size: st.size }
      totalBytes += st.size
      ok++
    } catch (e) {
      fail++
      // 清掉半成品，避免下次误判为"已缓存"
      try { await Filesystem.deleteFile({ path, directory: Directory.Data }) } catch (_) {}
      console.warn('下载失败', file, e)
    }
  }

  rec.bytes = totalBytes
  rec.at = Date.now()
  idx[book.id] = rec
  await setIndex(idx)
  onProgress({ done: tracks.length, total: tracks.length, pct: 100, label: '完成' })
  return { ok, fail }
}

/** 删除一本书的缓存 */
export async function removeBook(bookId) {
  const idx = await index()
  const rec = idx[bookId]
  if (!rec) return
  for (const k of Object.keys(rec.tracks || {})) {
    try { await Filesystem.deleteFile({ path: rec.tracks[k].path, directory: Directory.Data }) } catch (_) {}
  }
  try { await Filesystem.rmdir({ path: bookDir(bookId), directory: Directory.Data, recursive: true }) } catch (_) {}
  delete idx[bookId]
  await setIndex(idx)
}

/** 清空全部缓存 */
export async function clearAll() {
  const idx = await index()
  for (const id of Object.keys(idx)) await removeBook(id)
  try { await Filesystem.rmdir({ path: ROOT, directory: Directory.Data, recursive: true }) } catch (_) {}
  await setIndex({})
}

/** 已缓存的书列表 */
export async function cachedBooks() {
  const idx = await index()
  return Object.entries(idx).map(([id, v]) => ({
    id, title: v.title, bytes: v.bytes || 0, at: v.at || 0,
    count: Object.keys(v.tracks || {}).length,
  })).sort((a, b) => b.at - a.at)
}

export function fmtBytes(b) {
  const n = Number(b) || 0
  if (n >= 1073741824) return (n / 1073741824).toFixed(1) + ' GB'
  if (n >= 1048576) return (n / 1048576).toFixed(1) + ' MB'
  if (n >= 1024) return Math.round(n / 1024) + ' KB'
  return n + ' B'
}

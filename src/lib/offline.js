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
import { t } from './terms.js'

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
// 读失败（Preferences 桥错误 / JSON 解析失败）与「真空索引 {}」必须区分开：
// 前者返回 null（调用方据此报「读取失败」而非「没缓存」，审计 §3.5）。
// NF-1（复审 2026-10-12）：原修法用 store.getJSON——它把桥错误/解析失败全部
// 吞成 fallback，null 分支在生产**不可达**。改走 getJSONStrict（抛错）后才真正生效。
const INDEX_BAK_KEY = 'offlineIndex.bak'   // 损坏索引的备份（store 层会加 shelfaudio. 前缀）

/** 严格读 + 形状归一：键不存在/坏形状 → {}；桥错误/解析失败 → 抛（带 kind/raw） */
async function readIndexStrict() {
  const v = await store.getJSONStrict(INDEX_KEY)
  if (v === null || v === undefined) return {}
  return (v && typeof v === 'object' && !Array.isArray(v)) ? v : {}
}

/** 展示侧读取：读失败（桥错误/JSON 损坏）→ null —— 调用方报「读取失败」而非「没有」 */
async function index() {
  try { return await readIndexStrict() } catch (_) { return null }
}

/**
 * 写入侧读取（mutateIndex / downloadBook / clearAll 的预读共用，NF-1）：
 *  - 桥错误 → 抛（连原始串都拿不到，盲写等于丢数据）；
 *  - JSON 损坏 → **先把损坏的原始串备份到 offlineIndex.bak，再返回 {} 重建**。
 *    损坏串（如写入中途被杀留下的截断 JSON）里可能还有其它书的记录，直接覆写
 *    = 永久丢失、磁盘文件成孤儿；备份后重建让写入总能推进、旧值留底可人工恢复。
 *
 * 与 index() 的分工：展示侧损坏要**报错**（用户得知道清单不可信），写入侧损坏
 * 要**自愈**（备份 + 重建，否则损坏后永远下不了书/清不了缓存，没有自救出口）。
 */
async function readIndexForWrite() {
  try {
    return await readIndexStrict()
  } catch (e) {
    if (e?.kind === 'parse' && typeof e.raw === 'string' && e.raw) {
      try { await store.set(INDEX_BAK_KEY, e.raw) } catch (_) { /* 备份失败也继续重建，至少不再覆盖后丢新进度 */ }
      return {}
    }
    throw e
  }
}
async function setIndex(idx) { await store.setJSON(INDEX_KEY, idx) }

// 2026-10-10 审计修：索引 read-modify-write 无并发保护 —— downloadBook 开头读一次
// idx、整本下完（可能几分钟）后整体写回，期间并发的其它写入（另一本书下载完、
// localTrackUri 自愈、removeBook）都会被覆盖 → 磁盘文件在而索引没有，永久泄漏。
// 所有索引变更走这条串行队列：每次都重新读最新索引、改完立即写回。
// NF-1（复审 2026-10-12）：改用写入侧严格读 —— 桥错误时本次变更跳过（不盲写）；
// JSON 损坏时 readIndexForWrite 已把损坏串备份到 offlineIndex.bak，从空索引重建。
let _idxQueue = Promise.resolve()
function mutateIndex(fn) {
  _idxQueue = _idxQueue.then(async () => {
    const idx = await readIndexForWrite()
    await fn(idx)
    await setIndex(idx)
  }).catch(() => {})
  return _idxQueue
}

/** 已缓存信息（没有则 null；索引读取失败也返回 null —— 播放路径优先不报错） */
export async function offlineInfo(bookId) {
  const idx = await index()
  if (idx === null) return null
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
    if (info) { await mutateIndex(ix => { const r = ix[bookId] || (ix[bookId] = { title: info.title, at: info.at, bytes: info.bytes, tracks: {} }); r.tracks = r.tracks || {}; delete r.tracks[idx] }) }
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
/** 预估已占用空间（字节）。索引读取失败时抛错（调用方据此显示「读取失败」
 *  而不是误报 0，2026-10-12 审计修 §3.5）。 */
export async function cacheSize() {
  const idx = await index()
  if (idx === null) throw new Error('缓存信息读取失败')
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
  if (!tracks.length) throw new Error(t('noAudio'))  // 2026-10-10 修：t 未导入会抛 ReferenceError
  // 进度条单位词（这里先取好：循环内的 `t` 是音轨变量，遮蔽了 terms 的 t）
  const chapterWord = t('chapter')

  const dir = bookDir(book.id)
  // 建目录（已存在会抛，忽略）
  try { await Filesystem.mkdir({ path: dir, directory: Directory.Data, recursive: true }) } catch (_) {}

  // 变更侧预读（NF-1，复审 2026-10-12）：
  //  - 桥错误 → 抛（读不到就不能盲写：要么把已下载的集误判成没下，要么瞎写丢数据）；
  //  - JSON 损坏 → readIndexForWrite 已备份损坏串，从空记录重建（本书全量重下，
  //    旧数据在 .bak 留底）。原实现把损坏也当「读失败」抛 → 损坏后下载永远进不来、
  //    索引永远修不好，用户没有自救出口。
  let idx
  try { idx = await readIndexForWrite() }
  catch (_) { throw new Error('离线索引读取失败') }
  const rec = idx[book.id] || { title: book.title || '', at: 0, bytes: 0, tracks: {} }
  rec.tracks = rec.tracks || {}
  rec.title = book.title || rec.title

  let ok = 0, fail = 0, totalBytes = 0

  for (let i = 0; i < tracks.length; i++) {
    const t = tracks[i]
    const n = typeof t.index === 'number' ? t.index - 1 : i   // tracks[].index 是 1-based
    const file = trackFile(n, t.title || `第${n + 1}集`, extOf(t.contentUrl))
    const path = `${dir}/${file}`
    onProgress({ done: i, total: tracks.length, pct: Math.round((i / tracks.length) * 100), label: t.title || `第${n + 1} ${chapterWord}` })

    // 已下过且文件在 → 跳过
    // 2026-10-10 审计修：只看 size>0 会把强杀 App 留下的半截文件当「已缓存」
    // （离线听到一半就断）。孤儿文件必须与索引记录的大小吻合才算完整。
    // 2026-10-12 审计修（§4.4）：stat 校验只对**索引里记过**的集做 —— 新集不可能
    // 「已下过」，直接下载即可（downloadFile 本来就覆盖目标路径）。原来每集都先
    // stat 一遍，536 集 = 536 次桥调用（真机 0.3~1.6 秒纯等待）。
    if (rec.tracks[n]) {
      try {
        const st = await Filesystem.stat({ path, directory: Directory.Data })
        if (st?.size === rec.tracks[n].size && st.size > 0) {
          rec.tracks[n] = { path, size: st.size }
          totalBytes += st.size
          ok++
          continue
        }
      } catch (_) { /* 文件不在（被清过数据）→ 重新下 */ }
    }

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
  // 走串行队列：与并发的 removeBook / localTrackUri 自愈互不覆盖
  await mutateIndex(ix => { ix[book.id] = rec })
  onProgress({ done: tracks.length, total: tracks.length, pct: 100, label: '完成' })
  return { ok, fail }
}

/** 删除一本书的缓存。桥错误时抛错 —— 静默当成功会让调用方 toast「已删除」
 *  却什么都没删（2026-10-12 审计修 §3.5）。
 *  JSON 损坏时**照删**（NF-1）：要删的目录名只由 bookId 决定，不依赖索引内容 ——
 *  readIndexForWrite 先把损坏串备份到 .bak，再从空索引重建；递归 rmdir 把该书的
 *  文件清干净（播放页的「删除缓存」在索引损坏时也给出路，不用先全清）。 */
export async function removeBook(bookId) {
  let idx
  try { idx = await readIndexForWrite() }
  catch (_) { throw new Error('离线索引读取失败，无法删除') }
  const rec = idx[bookId]
  if (rec) for (const k of Object.keys(rec.tracks || {})) {
    try { await Filesystem.deleteFile({ path: rec.tracks[k].path, directory: Directory.Data }) } catch (_) {}
  }
  // 兜底删目录：索引里没记录（损坏重建 / 记录丢了）也能把文件清掉，不留孤儿
  try { await Filesystem.rmdir({ path: bookDir(bookId), directory: Directory.Data, recursive: true }) } catch (_) {}
  await mutateIndex(ix => { delete ix[bookId] })
}

/** 清空全部缓存。桥错误时抛错（连索引都读不到，盲删不可接受）。
 *  JSON 损坏时**必须能清**（NF-1）：缓存页失败态给用户的自救出口就是「清空后
 *  重新下载」—— readIndexForWrite 先备份损坏串，逐本循环为空，靠递归删 ROOT
 *  把文件清光，再重置索引。 */
export async function clearAll() {
  let idx
  try { idx = await readIndexForWrite() }
  catch (_) { throw new Error('缓存信息读取失败') }
  for (const id of Object.keys(idx)) await removeBook(id)
  try { await Filesystem.rmdir({ path: ROOT, directory: Directory.Data, recursive: true }) } catch (_) {}
  await mutateIndex(ix => { for (const k of Object.keys(ix)) delete ix[k] })
}

/** 已缓存的书列表。索引读取失败时抛错（调用方渲染「读取失败」态，§3.5） */
export async function cachedBooks() {
  const idx = await index()
  if (idx === null) throw new Error('缓存信息读取失败')
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

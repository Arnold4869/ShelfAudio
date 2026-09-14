/**
 * Navidrome（Subsonic API）适配器 —— 输出与 AbsApi 同一套规范化形状
 *
 * 服务端实测（2026-09-14，NAS 4533 端口 navidrome v0.64.0）：
 *  - Subsonic API 1.16.1 + OpenSubsonic（f=json 可用）
 *  - 认证：u + t=md5(password+salt) + s=salt（每次请求新 salt）；也支持 p=明文（不安全，不用）
 *  - 无 token/会话概念，每请求都带完整凭据 → **必须存密码**（本机 Preferences）
 *
 * 模型映射（ND 是音乐库，App 把「专辑」当书、「歌曲」当集）：
 *  - album  → item（media.metadata.title/artistName、duration=累计时长、songCount=集数）
 *  - song   → track（index、duration、title、parent=albumId）
 *  - 进度   → bookmark（createBookmark 按 song 存 position 秒）↔ 全书累计秒互转
 *  - 收藏   → star/unstar（album 级）
 *  - 继续听 → getBookmarks（按 song.updated 排序，聚合到专辑）
 *  - 播放计数 → scrobble(submission=true)（ND 只认这个，stream 不计数）
 */
import { CapacitorHttp } from '@capacitor/core'
import { md5, randomSalt } from './md5.js'

const DEFAULT_TIMEOUT = 20000
const CLIENT = 'ShelfAudio'
const API_VER = '1.16.1'

function isNativeShell() {
  try { return !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform()) } catch (_) { return false }
}

async function rawRequest(url, { method = 'GET', headers = {}, timeout = DEFAULT_TIMEOUT } = {}) {
  if (isNativeShell()) {
    const res = await CapacitorHttp.request({ url, method, headers, readTimeout: timeout, connectTimeout: timeout })
    return { status: res.status, ok: res.status >= 200 && res.status < 300, headers: res.headers || {}, data: res.data }
  }
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeout)
  try {
    const r = await fetch(url, { method, headers, signal: ctrl.signal })
    const text = await r.text()
    let body = text
    try { body = JSON.parse(text) } catch (_) {}
    return { status: r.status, ok: r.ok, headers: Object.fromEntries(r.headers.entries()), data: body }
  } finally { clearTimeout(timer) }
}

function friendlyNetError(e) {
  const msg = String(e?.message || e)
  if (/timeout|timed out|abort/i.test(msg)) return new Error('连接超时：检查服务器地址、网络和反向代理是否正常')
  if (/cleartext|not permitted/i.test(msg)) return new Error('这台设备不允许明文 HTTP，请用 https 地址')
  if (/unable to resolve host|nodename|unknown host/i.test(msg)) return new Error('域名解析失败：检查地址是否写错')
  if (/connect|refused|unreachable|network/i.test(msg)) return new Error('连不上服务器：' + msg)
  return new Error('请求失败：' + msg)
}

const SUBSONIC_ERR = {
  0: '服务器内部错误',
  10: '请求缺少必要参数',
  20: '客户端版本过旧，服务器不支持',
  30: '客户端版本过新',
  40: '用户名或密码不对',
  41: 'Token 认证不被该服务器支持（老版本 Subsonic），改用明文密码或升级服务器',
  50: '当前账号没有这个操作的权限',
}

export class NavidromeApi {
  constructor() {
    this.baseUrl = ''
    this.username = ''  // 认证用（必须始终是字符串！）
    this.password = ''  // Subsonic 协议要密码算 token，必须保存（存本机 Preferences）
    this.user = null    // 最近一次登录的用户信息对象（给 UI 看，不参与认证）
    this.kind = 'navidrome'
  }

  configure(baseUrl, user, password) {
    this.baseUrl = (baseUrl || '').replace(/\/+$/, '')
    if (!/^https?:\/\//.test(this.baseUrl)) throw new Error('服务器地址要以 http:// 或 https:// 开头')
    // 只接受字符串：曾经把 this.user 直接当认证字段用，login() 又把它覆盖成对象，
    // 导致第二次请求 u=[object Object] → 全部 401（单测抓到）。
    this.username = typeof user === 'string' ? user : (user?.username || '')
    this.password = password || ''
  }

  get ready() { return !!(this.baseUrl && this.username && this.password) }

  /** 构造带认证参数的 URL */
  url(path, params = {}) {
    const salt = randomSalt()
    const token = md5(this.password + salt)
    const qs = new URLSearchParams({
      u: this.username,
      t: token,
      s: salt,
      v: API_VER,
      c: CLIENT,
      f: 'json',
      ...Object.fromEntries(Object.entries(params).map(([k, v]) => [k, String(v)])),
    })
    return `${this.baseUrl}${path}?${qs.toString()}`
  }

  /** Subsonic 请求：剥 subsonic-response 壳、翻译错误码 */
  async _sub(path, params = {}, opts = {}) {
    if (!this.baseUrl) throw new Error('未配置 Navidrome 服务器地址')
    let res
    try {
      res = await rawRequest(this.url(path, params), opts)
    } catch (e) { throw friendlyNetError(e) }
    if (res.status === 0) throw new Error('网络不可达，检查网络或被代理拦截')
    const body = res.data
    const sr = body?.['subsonic-response']
    if (!sr) throw new Error(`Navidrome 返回了非预期内容（HTTP ${res.status}），确认地址指向 Navidrome`)
    if (sr.status === 'failed') {
      const err = sr.error || {}
      const msg = SUBSONIC_ERR[err.code] || err.message || `错误码 ${err.code}`
      throw new Error(msg)
    }
    return sr
  }

  // ---- 认证/探活 ----
  /** 探活 + 验证凭据。成功返回用户信息形状（对齐 abs.login 的返回面） */
  async login(origin, username, password) {
    const base = (origin || '').replace(/\/+$/, '')
    if (!/^https?:\/\//.test(base)) throw new Error('服务器地址要以 http:// 或 https:// 开头')
    this.configure(base, username, password)
    let sr
    try {
      sr = await this._sub('/rest/ping', {}, { timeout: 10000 })
    } catch (e) {
      // 还原成「能对用户说人话」的两种：连不上 / 凭据错
      if (/用户名或密码/.test(e.message)) throw e
      if (/缺少必要参数/.test(e.message)) throw new Error('用户名或密码不对')
      throw e
    }
    // ping 成功后再拿一次用户角色（可选，失败不影响登录）
    let user = { username, token: '', type: 'user' }
    try {
      const u = await this._sub('/rest/getUser', { username })
      if (u?.user) user = { username: u.user.username || username, token: '', type: u.user.adminRole ? 'admin' : 'user', raw: u.user }
    } catch (_) {}
    this.user = user
    return user
  }

  async me() {
    try {
      const u = await this._sub('/rest/getUser', { username: this.username })
      return { username: this.username, mediaProgress: [], type: u?.user?.adminRole ? 'admin' : 'user' }
    } catch (_) { return { username: this.username, mediaProgress: [] } }
  }

  // ---- 库 / 书目（专辑=书）----
  async libraries() {
    const sr = await this._sub('/rest/getMusicFolders')
    const folders = sr?.musicFolders?.musicFolder || []
    const list = Array.isArray(folders) ? folders : [folders]
    return list.map(f => ({
      id: f.id,
      name: f.name || '音乐库',
      // 视图按书库渲染，音乐库直接当"书库"用
    }))
  }

  /** 专辑列表 → 对齐 ABS 的 getLibraryItems().results 形状 */
  async getLibraryItems(libraryId, { limit = 200, page = 0, sort = 'name', desc = false } = {}) {
    const type = sort === 'recent' ? 'recent' : 'alphabeticalByName'
    const sr = await this._sub('/rest/getAlbumList2', {
      type,
      size: Math.min(limit, 500),
      offset: page * limit,
      ...(libraryId ? { musicFolderId: libraryId } : {}),
    })
    const albums = sr?.albumList2?.album || []
    return {
      results: albums.map(a => this._albumToItem(a)),
      total: albums.length,
    }
  }

  _albumToItem(a) {
    return {
      id: 'nd:' + a.id,                     // 前缀隔离两套服务器同 id 撞车
      _src: 'navidrome',
      media: {
        metadata: {
          title: a.name || '未命名',
          authorName: a.artist || '',        // 艺术家 → 显示位
          narratorName: '',
          description: a.description || '',
        },
        duration: (Number(a.duration) || 0),
        songCount: Number(a.songCount) || 0,
      },
      _nd: {
        albumId: a.id,
        artistId: a.artistId,
        coverArt: a.coverArt || a.id,
        created: a.created,
        year: a.year,
        genre: a.genre,
        played: a.played,
      },
    }
  }

  /** 专辑详情（含全部歌曲）→ ABS 形状（media.audioFiles / media.chapters） */
  async getItem(ndItemId) {
    const albumId = String(ndItemId).replace(/^nd:/, '')
    const sr = await this._sub('/rest/getAlbum', { id: albumId })
    const a = sr?.album
    if (!a) throw new Error('找不到这个专辑')
    const songs = a.song || []
    const item = this._albumToItem(a)
    // duration 逐首累计 → ABS 的"全书时长"；songCount 即集数
    let acc = 0
    const tracks = songs.map((s, i) => {
      const startOffset = acc
      acc += Number(s.duration) || 0
      return {
        index: i + 1,
        startOffset,                       // 与 ABS 的全书累计起点口径一致
        duration: Number(s.duration) || 0,
        contentUrl: `/rest/stream?id=${encodeURIComponent(s.id)}`,
        title: s.title || `第 ${i + 1} 首`,
        mimeType: s.contentType || 'audio/mpeg',
        _nd: { songId: s.id, track: s.track, suffix: s.suffix, artist: s.artist },
      }
    })
    item.media.audioFiles = songs.map(s => ({
      ino: s.id,                            // 离线缓存按 ino 拼直链 → 这里直接放 songId
      duration: Number(s.duration) || 0,
    }))
    item.media.chapters = tracks.map(t => ({
      title: t.title,
      start: t.startOffset,
      end: t.startOffset + t.duration,
      duration: t.duration,     // 进度换算要按集时长切片，必须带上
      _nd: t._nd,               // 歌曲元数据（album 详情页按 songId 定位播放起点用）
    }))
    item.media.duration = acc
    item._ndSongs = songs
    return item
  }

  /**
   * 搜索：老板 2026-09-14「分成几个的搜索：专辑、作者、歌曲名或者详情，不要混到一块」。
   * 返回三组分开的数据（Subsonic search3 一次请求就带三类结果，不用多发）：
   *   { albums: [书形状], artists: [{id, name}], songs: [{id, albumId, title, artist, duration}] }
   * 歌曲点进去 → 定位到所在专辑从那首开始播（复用专辑详情页）。
   */
  async search3(libraryId, q) {
    const sr = await this._sub('/rest/search3', {
      query: q || '',
      albumCount: 20,
      artistCount: 15,
      songCount: 30,
      ...(libraryId ? { musicFolderId: libraryId } : {}),
    })
    const r = sr?.searchResult3 || {}
    const albums = (r.album || []).map(a => this._albumToItem(a))
    const artists = (r.artist || []).map(a => ({ id: 'ndart:' + a.id, name: a.name, _ndArtistId: a.id }))
    const songs = (r.song || []).map(s => ({
      id: 'nd:' + s.id,
      songId: s.id,
      albumId: s.albumId ? 'nd:' + s.albumId : '',
      album: s.album || '',
      title: s.title || '',
      artist: s.artist || '',
      duration: s.duration || 0,
    }))
    return { albums, artists, songs }
  }

  async searchLibrary(libraryId, q) {
    const sr = await this._sub('/rest/search3', {
      query: q || '',
      albumCount: 20,
      artistCount: 0,
      songCount: 0,
      ...(libraryId ? { musicFolderId: libraryId } : {}),
    })
    const albums = sr?.searchResult3?.album || []
    return albums.map(a => this._albumToItem(a))
  }

  async searchAll(libraries, q) {
    const seen = new Set()
    const out = []
    for (const lib of libraries) {
      const items = await this.searchLibrary(lib.id, q).catch(() => [])
      for (const it of items) {
        if (!seen.has(it.id)) { seen.add(it.id); out.push(it) }
      }
      if (out.length >= 40) break
    }
    return out
  }

  // ---- 收藏（star）----
  async collections() {
    // ND 没有"收藏夹"概念，只有 star。适配成一个固定分组「收藏」。
    const sr = await this._sub('/rest/getStarred2', {})
    const albums = sr?.starred2?.album || []
    const books = albums.map(a => this._albumToItem(a))
    return books.length ? [{ id: 'nd:starred', name: '收藏（Navidrome）', books, _nd: true }] : []
  }

  getCollection(id) {
    // 只有这一个固定"收藏夹"
    return this.collections().then(cols => cols.find(c => c.id === id) || { id, name: '收藏', books: [] })
  }

  async addToCollection(_collectionId, ndItemId) {
    const albumId = String(ndItemId).replace(/^nd:/, '')
    await this._sub('/rest/star', { id: albumId, albumId })
  }

  async removeFromCollection(_collectionId, ndItemId) {
    const albumId = String(ndItemId).replace(/^nd:/, '')
    await this._sub('/rest/unstar', { id: albumId, albumId })
  }

  /** 该专辑是否已 star（给心形按钮用） */
  async isStarred(ndItemId) {
    const albumId = String(ndItemId).replace(/^nd:/, '')
    try {
      const sr = await this._sub('/rest/getAlbumInfo2', { id: albumId })
      return !!(sr?.albumInfo?.starred)
    } catch (_) {
      // 退化：拉 star 列表查
      const cols = await this.collections().catch(() => [])
      return cols.some(c => (c.books || []).some(b => b.id === ndItemId))
    }
  }

  // ---- 进度 ----
  /**
   * ND 的进度粒度是"歌"（bookmark.position = 该歌内秒数）。
   * App 的口径是"全书累计秒"——这里做互转：传全书秒，算出落在哪首歌+歌内偏移，
   * 每首歌都建 bookmark（有进度的那首 + 它之前的全部歌记 completed 整首）。
   * 这样书架上"听 N%"的换算才能对上。
   */
  async updateProgress(ndItemId, bookTime, duration) {
    const item = await this.getItem(ndItemId).catch(() => null)
    if (!item) return null
    const tracks = item.media.chapters || []
    let remain = Math.max(0, Math.min(bookTime, duration || item.media.duration))
    for (let i = 0; i < tracks.length; i++) {
      const t = tracks[i]
      const songId = item._ndSongs?.[i]?.id || t._nd?.songId
      if (!songId) continue
      const inTrack = remain >= t.duration ? t.duration : remain
      if (inTrack > 0) {
        await this._sub('/rest/createBookmark', {
          id: songId,
          position: Math.round(Math.min(inTrack, t.duration)),
        }).catch(() => null)
        remain -= t.duration
      } else break
    }
    return { currentTime: bookTime }
  }

  /** 读进度 → ABS 形状 { currentTime, duration, progress, isFinished }（全书口径） */
  async getProgress(ndItemId) {
    const item = await this.getItem(ndItemId).catch(() => null)
    if (!item) return null
    const sr = await this._sub('/rest/getBookmarks').catch(() => null)
    const bms = sr?.bookmarks?.bookmark || []
    const bySong = new Map(bms.map(b => [b.id, b]))
    let last = null, lastIdx = -1
    for (let i = 0; i < (item._ndSongs || []).length; i++) {
      const sid = item._ndSongs[i].id
      const bm = bySong.get(sid)
      if (bm) { last = bm; lastIdx = i }
    }
    const chapters = item.media.chapters || []
    if (!last || lastIdx < 0) return { currentTime: 0, duration: item.media.duration, progress: 0, isFinished: false }
    const off = chapters[lastIdx]?.start || 0
    const currentTime = off + (Number(last.position) || 0)
    const dur = item.media.duration
    return {
      currentTime,
      duration: dur,
      progress: dur ? currentTime / dur : 0,
      isFinished: dur ? currentTime >= dur - 1 : false,
      _at: last.updated || last.created || 0,
    }
  }

  /** 继续听：ND 的 bookmarks 按更新时间排序 → 聚合回专辑。输出 ABS 形状 libraryItems */
  async itemsInProgress() {
    const sr = await this._sub('/rest/getBookmarks').catch(() => null)
    const bms = sr?.bookmarks?.bookmark || []
    if (!bms.length) return { libraryItems: [] }
    // 按 bookmark.updated 倒序
    const sorted = [...bms].sort((a, b) => new Date(b.updated || b.created || 0) - new Date(a.updated || a.created || 0))
    const out = []
    const seenAlbum = new Set()
    for (const bm of sorted) {
      try {
        const song = await this._sub('/rest/getSong', { id: bm.id }).catch(() => null)
        const albumId = song?.song?.albumId
        if (!albumId || seenAlbum.has(albumId)) continue
        seenAlbum.add(albumId)
        const item = await this.getItem('nd:' + albumId)
        // 标注这本书的"最后活动时间"供排序
        item.progressLastUpdate = new Date(bm.updated || bm.created || 0).getTime()
        out.push(item)
        if (out.length >= 8) break
      } catch (_) {}
    }
    return { libraryItems: out }
  }

  /** removeFromContinue：ND 直接删该专辑全部歌曲的 bookmark */
  async removeFromContinue(ndItemId) {
    const item = await this.getItem(ndItemId).catch(() => null)
    if (!item) return
    for (const s of (item._ndSongs || [])) {
      await this._sub('/rest/deleteBookmark', { id: s.id }).catch(() => null)
    }
  }

  // ---- 播放会话（ND 无会话，合成为 ABS 会话形状；App 层无感）----
  async startPlayback(ndItemId, startTime = 0) {
    const item = await this.getItem(ndItemId)
    const tracks = (item.media.chapters || []).map((ch, i) => {
      const t = ch._nd || {}
      const song = item._ndSongs?.[i]
      return {
        index: i + 1,
        startOffset: ch.start || 0,
        duration: ch.duration || 0,
        contentUrl: `/rest/stream?id=${encodeURIComponent(song.id)}`,
        title: ch.title || `第 ${i + 1} 首`,
        mimeType: 'audio/mpeg',
      }
    })
    return {
      sessionId: 'nd:' + item.id,          // ND 无会话，用 bookId 当占位
      tracks,
      duration: item.media.duration || 0,
      raw: item,
    }
  }

  /** 进度同步：ND 无会话，直接写 bookmark（节流由 App 层负责） */
  syncSession(_sessionId, currentTime, _timeListened, duration) {
    const bookId = String(_sessionId || '').replace(/^nd:nd:/, '').replace(/^nd:/, '')
    if (!bookId) return Promise.resolve(null)
    return this.updateProgress('nd:' + bookId, currentTime, duration).catch(() => null)
  }

  closeSession(sessionId, currentTime, timeListened, duration) {
    // 关会话 = 最后一次 scrobble（记播放次数）+ 已在 sync 里写过 bookmark
    const songAt = this._songAtTime(sessionId, currentTime).catch(() => null)
    return songAt.then(sid => {
      if (!sid) return null
      return this._sub('/rest/scrobble', { id: sid, submission: true }).catch(() => null)
    })
  }

  /** 全书时间 → 当时正在播的那首歌的 songId */
  async _songAtTime(sessionId, bookTime) {
    const bookId = String(sessionId || '').replace(/^nd:/, '')
    if (!bookId) return null
    const item = await this.getItem('nd:' + bookId).catch(() => null)
    if (!item) return null
    const chapters = item.media.chapters || []
    for (let i = chapters.length - 1; i >= 0; i--) {
      if (bookTime >= (chapters[i].start || 0) - 0.001) return item._ndSongs?.[i]?.id || null
    }
    return item._ndSongs?.[0]?.id || null
  }

  // ---- 封面 / 流 ----
  coverUrl(ndItemId, { width = 400 } = {}) {
    const albumId = String(ndItemId || '').replace(/^nd:/, '')
    if (!albumId) return ''
    // 封面同样带完整凭据（ND 对 getCoverArt 也校验认证）
    const salt = randomSalt()
    const token = md5(this.password + salt)
    const qs = new URLSearchParams({
      id: albumId, size: String(width), u: this.username, t: token, s: salt, v: API_VER, c: CLIENT,
    })
    return `${this.baseUrl}/rest/getCoverArt?${qs.toString()}`
  }

  assetUrl(path) { return path ? `${this.baseUrl}${path}` : '' }

  trackUrl(contentUrl) {
    if (!contentUrl) return ''
    if (/^https?:\/\//.test(contentUrl)) return contentUrl
    // ND 的音频流必须每次带凭据（u + t=md5(pw+salt) + s）：
    // 原生播放器带不了自定义 header，所以只能走 URL 认证（Navidrome 官方支持）。
    const m = String(contentUrl).match(/[?&]id=([^&]+)/)
    const songId = m ? decodeURIComponent(m[1]) : String(contentUrl).split('/').pop()
    return this.streamUrl(songId)
  }

  /** 流直链（带完整凭据，原生播放器/下载器直接用 URL） */
  streamUrl(songId) {
    const salt = randomSalt()
    const token = md5(this.password + salt)
    const qs = new URLSearchParams({
      id: String(songId || ''), u: this.username, t: token, s: salt, v: API_VER, c: CLIENT,
    })
    return `${this.baseUrl}/rest/stream?${qs.toString()}`
  }

  authHeaders() { return {} }   // ND 走 URL 认证（原生播放器带不了自定义 header 的场景必须能从 URL 过）

  // ---- 离线下载按 ino（songId）拼直链 ----
  downloadUrl(ino) { return this.streamUrl(ino) }

  // ---- 兼容层：视图直接调 abs.post() 的地方（建收藏夹等），ND 无对应，给安全空实现 ----
  async post(_path, _body) { return null }
}

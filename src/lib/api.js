/**
 * ABS API 客户端（纯 fetch，无依赖）
 * 关键事实（2026-09-12 对 ABS 2.36.0 实测）：
 *  - GET 请求可把 token 放 query: ?token=xxx （文档明确支持）
 *  - POST 用 Authorization: Bearer
 *  - 音频直链 = /api/items/{itemId}/file/{ino}，支持 Range(206)，也认 ?token=
 *  - 进度：POST /api/items/{id}/play 开会话 → /api/session/{sid}/sync 同步 → /close 关闭
 */

const DEFAULT_TIMEOUT = 20000

/**
 * ⚠️ 为什么不用 fetch：
 * ABS 的 CORS 白名单只有 `capacitor://localhost` 和 `http://localhost`（见 ABS
 * server/Server.js），而 WebView 里的页面 origin 是 `https://localhost`（Android）
 * 或 `capacitor://localhost`（iOS）—— 请求你自己的服务器属于跨域，预检 OPTIONS
 * 被拒 → fetch 直接失败，表现成"地址没错但连不上"。
 *
 * 解法：走 Capacitor 的 CapacitorHttp 原生层发请求（http.native 包一层）。
 * 在 capacitor.config.json 里开 `plugins.CapacitorHttp.enabled = true`，
 * Capacitor 会把 window.fetch 自动 patch 成原生实现（绕过 CORS），
 * 这里的封装负责拿到真实的原生错误信息 + 超时控制。
 */
import { CapacitorHttp } from '@capacitor/core'

function nativeHttp() {
  // 用官方导出（@capacitor/core 直接导出 CapacitorHttp），比 window.Capacitor.Plugins 内部路径稳
  return CapacitorHttp || null
}

/** 是否在原生壳里运行 */
function isNativeShell() {
  try {
    return !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform())
  } catch (_) { return false }
}

/** 发一次请求：原生优先，浏览器回退 fetch */
async function request(url, { method = 'GET', headers = {}, data, timeout = DEFAULT_TIMEOUT } = {}) {
  if (isNativeShell() && nativeHttp()) {
    const res = await nativeHttp().request({ url, method, headers, data, readTimeout: timeout, connectTimeout: timeout })
    return {
      status: res.status,
      ok: res.status >= 200 && res.status < 300,
      headers: res.headers || {},
      _data: res.data,
      _native: true,
    }
  }
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeout)
  try {
    const r = await fetch(url, { method, headers, body: data ? JSON.stringify(data) : undefined, signal: ctrl.signal })
    return { status: r.status, ok: r.ok, headers: Object.fromEntries(r.headers.entries()), _res: r, _native: false }
  } finally { clearTimeout(timer) }
}

async function readBody(r) {
  if (r._native) {
    const d = r._data
    if (d === null || d === undefined || d === '') return null
    // 原生层：JSON 响应已被解析成对象，其它是字符串
    if (typeof d === 'object') return d
    try { return JSON.parse(d) } catch (_) { return d }
  }
  const text = await r._res.text()
  if (!text.trim()) return null
  try { return JSON.parse(text) } catch (_) { return text }
}

function errText(r) {
  if (r._native) {
    const d = r._data
    return typeof d === 'string' ? d.slice(0, 300) : JSON.stringify(d || {}).slice(0, 300)
  }
  return ''
}

export class AbsApi {
  constructor() {
    this.baseUrl = ''
    this.token = ''
    this.user = null
  }

  configure(baseUrl, token) {
    this.baseUrl = (baseUrl || '').replace(/\/+$/, '')
    if (!/^https?:\/\//.test(this.baseUrl)) throw new Error('服务器地址要以 http:// 或 https:// 开头')
    this.token = token || ''
  }

  get ready() {
    return !!(this.baseUrl && this.token)
  }

  // ---- 底层请求 ----
  async _fetch(path, { method = 'GET', body, query, raw = false, timeout = DEFAULT_TIMEOUT } = {}) {
    if (!this.baseUrl) throw new Error('未配置服务器地址')
    let url = this.baseUrl + path
    const params = new URLSearchParams(query || {})
    // GET 走 query token（部分场景更省事）；POST 走 header
    if (method === 'GET' && this.token) params.set('token', this.token)
    const qs = params.toString()
    if (qs) url += (url.includes('?') ? '&' : '?') + qs

    const headers = { 'Content-Type': 'application/json' }
    if (method !== 'GET' && this.token) headers['Authorization'] = 'Bearer ' + this.token

    let res
    try {
      res = await request(url, { method, headers, data: body, timeout })
    } catch (e) {
      const msg = String(e?.message || e)
      if (/timeout|timed out|abort/i.test(msg)) throw new Error('连接超时：检查服务器地址、网络和反向代理是否正常')
      if (/cleartext|not permitted/i.test(msg)) throw new Error('这台设备不允许明文 HTTP，请用 https 地址')
      if (/unable to resolve host|nodename nor servname|unknown host/i.test(msg)) throw new Error('域名解析失败：检查地址是否写错')
      if (/connect|refused|unreachable|network/i.test(msg)) throw new Error('连不上服务器：' + msg)
      throw new Error('请求失败：' + msg)
    }

    if (res.status === 0) throw new Error('网络不可达，检查网络或被代理拦截')
    if (res.status === 401) {
      // 登录接口自己处理 401（"用户名或密码不对"），这里只处理已登录后的失效
      if (/^\/login/.test(path)) return null
      throw new Error('登录已失效，请重新登录')
    }
    if (!res.ok) {
      const detail = errText(res)
      // 403 最常见的原因是 ABS 账号权限不足，而不是"没登录"：
      // 改收藏夹需要 update 权限（实测普通账号默认 update=false，会返回纯 "Forbidden"）。
      // 直接说清楚该去哪改，否则用户只看到"请求失败 403"完全无从下手。
      if (res.status === 403) {
        throw new Error('服务器拒绝了这个操作：当前账号没有「修改」权限。'
          + '到 Audiobookshelf 后台 → 用户 → 你的账号，勾上「修改」(Update) 后重试。')
      }
      throw new Error(`请求失败 ${res.status}${detail ? '：' + detail : ''}`)
    }
    if (raw) return res
    return await readBody(res)
  }

  get(path, query, opts = {}) { return this._fetch(path, { method: 'GET', query, ...opts }) }
  post(path, body, opts = {}) { return this._fetch(path, { method: 'POST', body, ...opts }) }

  // ---- 认证 ----
  static async serverStatus(origin) {
    const base = (origin || '').replace(/\/+$/, '')
    let res
    try {
      res = await request(base + '/status', { timeout: 10000 })
    } catch (e) {
      const msg = String(e?.message || e)
      if (/timeout|timed out/i.test(msg)) throw new Error('连接超时：检查地址、网络和反向代理')
      if (/unable to resolve/i.test(msg)) throw new Error('域名解析失败：检查地址是否写错')
      throw new Error('连不上这台服务器，检查地址是否正确、NAS 是否开机')
    }
    if (!res.ok) throw new Error('这台服务器返回了 ' + res.status + '，确认地址指向 Audiobookshelf')
    return await readBody(res)
  }

  async login(origin, username, password) {
    const base = (origin || '').replace(/\/+$/, '')
    if (!/^https?:\/\//.test(base)) throw new Error('服务器地址要以 http:// 或 https:// 开头')
    // 先探活，给出更友好的报错
    await AbsApi.serverStatus(base)

    let res
    try {
      res = await request(base + '/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        data: { username, password },
      })
    } catch (e) {
      throw new Error('登录请求失败：' + String(e?.message || e))
    }
    if (res.status === 401) throw new Error('用户名或密码不对')
    if (!res.ok) throw new Error('登录失败 HTTP ' + res.status + (errText(res) ? '：' + errText(res) : ''))
    const data = await readBody(res)
    const token = data?.user?.token
    if (!token) throw new Error('登录响应里没有 token')
    this.configure(base, token)
    this.user = data.user
    return data.user
  }

  async me() {
    const u = await this.get('/api/me')
    this.user = u
    return u
  }

  // ---- 库 / 书目 ----
  async libraries() {
    const d = await this.get('/api/libraries')
    return d?.libraries || []
  }

  getLibraryItems(libraryId, { limit = 100, page = 0, sort = 'media.metadata.title', desc = false } = {}) {
    return this.get(`/api/libraries/${libraryId}/items`, {
      limit, page, sort, desc: desc ? 1 : 0,
    })
  }

  getItem(itemId) { return this.get(`/api/items/${itemId}`) }

  /** 搜索：ABS 的库搜索接口 */
  async searchLibrary(libraryId, q) {
    try {
      const d = await this.get(`/api/libraries/${libraryId}/search`, { q })
      const books = d?.book || []
      return books.map(b => b.libraryItem).filter(Boolean)
    } catch (_) {
      return []
    }
  }

  /** 全局搜索：跨所有库（实现为逐库搜索后合并） */
  async searchAll(libraries, q) {
    const seen = new Set()
    const out = []
    for (const lib of libraries) {
      const items = await this.searchLibrary(lib.id, q).catch(() => [])
      for (const it of items) {
        if (!seen.has(it.id)) { seen.add(it.id); out.push(it) }
      }
    }
    return out
  }

  getCollection(id) {
    return this.get(`/api/collections/${id}`)
  }

  async collections() {
    const d = await this.get('/api/collections')
    return d?.collections || []
  }

  async itemsInProgress() {
    const d = await this.get('/api/me/items-in-progress')
    return d?.libraryItems || []
  }

  // ---- 封面 ----
  /** 封面直链（img src 直接用；带 token 才能取到） */
  coverUrl(itemId, { width = 400 } = {}) {
    if (!itemId) return ''
    return `${this.baseUrl}/api/items/${itemId}/cover?width=${width}&token=${encodeURIComponent(this.token)}`
  }

  /** 头像/作者图等通用资源 */
  assetUrl(path) {
    if (!path) return ''
    const sep = path.includes('?') ? '&' : '?'
    return `${this.baseUrl}${path}${sep}token=${encodeURIComponent(this.token)}`
  }

  // ---- 播放会话 ----
  /**
   * 开播放会话，返回 { sessionId, tracks:[{index,startOffset,duration,contentUrl,title}] , duration }
   * tracks 的 startOffset 是"全书累计起点"，换算：fileTime = bookTime - startOffset
   */
  async startPlayback(itemId, startTime = 0) {
    const s = await this.post(`/api/items/${itemId}/play`, {
      deviceInfo: { clientName: 'ShelfAudio', clientVersion: '0.1.0', deviceId: 'shelfaudio' },
      supportedMimeTypes: ['audio/mpeg', 'audio/mp4', 'audio/aac', 'audio/ogg', 'audio/flac', 'audio/x-m4a'],
      startTime,
      mediaPlayer: 'ShelfAudio',
    })
    const tracks = (s?.audioTracks || []).map(t => ({
      index: t.index,
      startOffset: t.startOffset || 0,
      duration: t.duration || 0,
      contentUrl: t.contentUrl,
      title: t.title || t.metadata?.relPath || '',
      mimeType: t.mimeType || 'audio/mpeg',
    }))
    return { sessionId: s.id, tracks, duration: s.duration || 0, raw: s }
  }

  syncSession(sessionId, currentTime, timeListened, duration) {
    return this.post(`/api/session/${sessionId}/sync`, { currentTime, timeListened, duration })
      .catch(() => null)   // 进度同步失败不打断播放
  }

  closeSession(sessionId, currentTime, timeListened, duration) {
    return this.post(`/api/session/${sessionId}/close`, { currentTime, timeListened, duration })
      .catch(() => null)
  }

  /** 音频流直链（带 token，供原生播放器/离线下载用） */
  trackUrl(contentUrl) {
    if (!contentUrl) return ''
    if (/^https?:\/\//.test(contentUrl)) return contentUrl
    const sep = contentUrl.includes('?') ? '&' : '?'
    return `${this.baseUrl}${contentUrl}${sep}token=${encodeURIComponent(this.token)}`
  }

  /** 带鉴权头的直链（原生播放器优先用 header，避免文件名特殊字符问题） */
  authHeaders() {
    return this.token ? { Authorization: 'Bearer ' + this.token } : {}
  }

  // ---- 收藏夹操作 ----
  addToCollection(collectionId, itemId) {
    return this.post(`/api/collections/${collectionId}/book`, { id: itemId })
  }
  removeFromCollection(collectionId, itemId) {
    return request(`${this.baseUrl}/api/collections/${collectionId}/book/${itemId}`, {
      method: 'DELETE',
      headers: { Authorization: 'Bearer ' + this.token },
    })
  }

  // ---- 进度 ----
  /** 手动写一条进度（不走会话时用） */
  updateProgress(itemId, currentTime, duration) {
    return this.post(`/api/me/progress/${itemId}`, {
      currentTime, duration, progress: duration ? currentTime / duration : 0,
    }).catch(() => null)
  }

  getProgress(itemId) {
    return this.get(`/api/me/progress/${itemId}`).catch(() => null)
  }

  /**
   * 把一本书从「继续听」移除。
   * 用 ABS 原生端点（GET /api/me/progress/<id>/remove-from-continue-listening），
   * 它只是把 hideFromContinueListening 置 true，进度本身保留 —— 比直接 DELETE 进度温和，
   * 也跟其它 ABS 客户端行为一致（用户在别处还能看到"听了一半"）。
   */
  /**
   * 从「继续听」移除。
   * ⚠️ URL 里要的是 **mediaProgress 的 id**（`/api/me` 里 mediaProgress[].id），
   * 不是 libraryItemId —— 两者不同（实测 libraryItemId 会 404）。
   * 所以这里做一次映射，调用方继续传 libraryItemId（顺手）。
   */
  async removeFromContinue(libraryItemId) {
    const me = await this.me()
    const mp = (me?.mediaProgress || []).find(x =>
      x.libraryItemId === libraryItemId || x.mediaItemId === libraryItemId || x.id === libraryItemId)
    const pid = mp?.id
    if (!pid) throw new Error('这本书没有收听进度记录，无需移除')
    return this.get(`/api/me/progress/${pid}/remove-from-continue-listening`)
  }

  /** 书签（ABS 原生，服务端存储，与其它客户端同步） */
  bookmarks(itemId) {
    return this.get(`/api/me/item/${itemId}/bookmark`).catch(() => null)
  }
  addBookmark(itemId, time, title) {
    return this.post(`/api/me/item/${itemId}/bookmark`, { time, title })
  }
}

export const abs = new AbsApi()

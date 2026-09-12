/**
 * ABS API 客户端（纯 fetch，无依赖）
 * 关键事实（2026-09-12 对 ABS 2.36.0 实测）：
 *  - GET 请求可把 token 放 query: ?token=xxx （文档明确支持）
 *  - POST 用 Authorization: Bearer
 *  - 音频直链 = /api/items/{itemId}/file/{ino}，支持 Range(206)，也认 ?token=
 *  - 进度：POST /api/items/{id}/play 开会话 → /api/session/{sid}/sync 同步 → /close 关闭
 */

const DEFAULT_TIMEOUT = 20000

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
    // GET 走 query token（AWS 等场景下更省事）；POST 走 header
    if (method === 'GET' && this.token) params.set('token', this.token)
    const qs = params.toString()
    if (qs) url += (url.includes('?') ? '&' : '?') + qs

    const headers = { 'Content-Type': 'application/json' }
    if (method !== 'GET' && this.token) headers['Authorization'] = 'Bearer ' + this.token

    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), timeout)
    let res
    try {
      res = await fetch(url, { method, headers, body: body ? JSON.stringify(body) : undefined, signal: ctrl.signal })
    } catch (e) {
      clearTimeout(timer)
      if (e.name === 'AbortError') throw new Error('连接超时，检查服务器地址和网络')
      throw new Error('连不上服务器：' + (e.message || e))
    }
    clearTimeout(timer)

    if (res.status === 401) throw new Error('登录已失效，请重新登录')
    if (!res.ok) {
      let detail = ''
      try { detail = (await res.text()).slice(0, 200) } catch (_) {}
      throw new Error(`请求失败 ${res.status}${detail ? '：' + detail : ''}`)
    }
    if (raw) return res
    const text = await res.text()
    if (!text.trim()) return null
    try { return JSON.parse(text) } catch (_) { return text }
  }

  get(path, query, opts = {}) { return this._fetch(path, { method: 'GET', query, ...opts }) }
  post(path, body, opts = {}) { return this._fetch(path, { method: 'POST', body, ...opts }) }

  // ---- 认证 ----
  static async serverStatus(origin) {
    const base = (origin || '').replace(/\/+$/, '')
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), 10000)
    try {
      const res = await fetch(base + '/status', { signal: ctrl.signal })
      clearTimeout(timer)
      if (!res.ok) throw new Error('HTTP ' + res.status)
      return await res.json()
    } catch (e) {
      clearTimeout(timer)
      throw new Error('连不上这台服务器，检查地址是否正确、NAS 是否开机')
    }
  }

  async login(origin, username, password) {
    const base = (origin || '').replace(/\/+$/, '')
    if (!/^https?:\/\//.test(base)) throw new Error('服务器地址要以 http:// 或 https:// 开头')
    // 先探活，给出更友好的报错
    await AbsApi.serverStatus(base)

    const res = await fetch(base + '/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    })
    if (res.status === 401) throw new Error('用户名或密码不对')
    if (!res.ok) throw new Error('登录失败 HTTP ' + res.status)
    const data = await res.json()
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
    return fetch(`${this.baseUrl}/api/collections/${collectionId}/book/${itemId}`, {
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
}

export const abs = new AbsApi()

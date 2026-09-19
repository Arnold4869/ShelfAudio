/**
 * 服务器中枢（多源适配层）
 *
 * 老板 2026-09-14 需求：
 *  「支持 navidrome…只登录 abs 的时候不显示 nd 的东西，可以再次登录 nd 时把它俩的
 *   东西都显示出来，只不过会分开显示（右上角切换按钮）；如果只登录 nd 也不显示 abs 的东西」
 *
 * 设计（为什么这么做，而不是把 12 个视图全改一遍）：
 *  1. 每个服务器客户端（/api.js 的 AbsApi、/navidrome.js 的 NavidromeApi）都暴露**同一套
 *     方法名**、返回**同一套形状**（书 → {id, media:{metadata, duration, audioFiles, chapters}}）。
 *  2. 本文件是门面（facade）：视图照旧调 `abs.xxx()`，只是 import 来源换成这里。
 *     → 视图改动最小，且以后加第三个服务器（Emby/Jellyfin）只加一个客户端。
 *  3. **按 id 前缀分派**：ND 条目的 id 带 `nd:` 前缀，ABS 不带。所以
 *     `coverUrl(id)` / `getItem(id)` / `startPlayback(id)` 这类"和具体条目有关"的调用
 *     能自动找到对的服务器 —— 两套服务器同时登录也不会串。
 *  4. `libraries()` / `searchAll()` / `collections()` 这类"和当前浏览上下文有关"的调用
 *     走**当前激活源**（activeSource），由右上角切换按钮控制。
 */
import { AbsApi, abs as absRaw } from './api.js'
import { NavidromeApi } from './navidrome.js'
import { store, CONFIG_KEYS } from './store.js'

export const SOURCES = {
  abs: { key: 'abs', label: 'Audiobookshelf', short: 'ABS', icon: 'server' },
  nd: { key: 'nd', label: 'Navidrome', short: 'ND', icon: 'headphones' },
}

/** ND 条目 id 前缀（ABS id 是 32 位 hex，天然不会撞） */
const ND_PREFIX = 'nd:'
export const ndId = id => ND_PREFIX + String(id).replace(/^nd:/, '')

/** 由条目 id 判断来源 */
export function sourceOfId(id) {
  return String(id || '').startsWith(ND_PREFIX) ? 'nd' : 'abs'
}

class ServerHub {
  constructor() {
    this.abs = absRaw            // ABS 客户端（原单例）
    this.nd = new NavidromeApi() // ND 客户端
    this.loggedIn = { abs: false, nd: false }
    this.activeSource = 'abs'
  }

  // ---------------- 登录状态 ----------------
  /** 已登录的源列表（顺序固定：abs 在前） */
  get available() {
    return ['abs', 'nd'].filter(k => this.loggedIn[k])
  }

  get multi() { return this.available.length > 1 }

  /** 当前激活源（若激活源没登录，自动落到第一个可用源） */
  get active() {
    if (this.loggedIn[this.activeSource]) return this.activeSource
    return this.available[0] || 'abs'
  }

  setActive(src) {
    if (this.loggedIn[src]) this.activeSource = src
  }

  /** 取某个源（或某个条目）对应的客户端 */
  clientFor(srcOrId) {
    if (srcOrId === 'nd') return this.nd
    if (srcOrId === 'abs') return this.abs
    return sourceOfId(srcOrId) === 'nd' ? this.nd : this.abs
  }

  /** 当前激活源对应的客户端（视图里"当前库"的调用走它） */
  get cur() { return this.clientFor(this.active) }

  /** 从 store 恢复两个服务器的登录态（boot 阶段调用） */
  async restore() {
    // ABS
    const aServer = await store.get(CONFIG_KEYS.server, '')
    const aToken = await store.get(CONFIG_KEYS.token, '')
    if (aServer && aToken) {
      try { this.abs.configure(aServer, aToken); this.abs.user = { username: await store.get(CONFIG_KEYS.username, '') }; this.loggedIn.abs = true }
      catch (_) { this.loggedIn.abs = false }
    } else this.loggedIn.abs = false

    // ND（Subsonic 要密码算 token，所以密码必须存本机）
    const nServer = await store.get(CONFIG_KEYS.ndServer, '')
    const nUser = await store.get(CONFIG_KEYS.ndUser, '')
    const nPass = await store.get(CONFIG_KEYS.ndPassword, '')
    if (nServer && nUser && nPass) {
      try {
        this.nd.configure(nServer, nUser, nPass)
        this.loggedIn.nd = true
      } catch (_) { this.loggedIn.nd = false }
    } else this.loggedIn.nd = false

    const saved = await store.get(CONFIG_KEYS.activeSource, '')
    if (saved && this.loggedIn[saved]) this.activeSource = saved
    else this.activeSource = this.available[0] || 'abs'
    return this.available
  }

  async setActivePersist(src) {
    this.setActive(src)
    try { await store.set(CONFIG_KEYS.activeSource, this.activeSource) } catch (_) {}
  }

  /** 登录 ABS（原流程）+ 落盘 */
  async loginAbs(origin, username, password) {
    const u = await AbsApi.prototype.login.call(this.abs, origin, username, password)
    await store.set(CONFIG_KEYS.server, this.abs.baseUrl)
    await store.set(CONFIG_KEYS.token, this.abs.token)
    await store.set(CONFIG_KEYS.username, username)
    this.loggedIn.abs = true
    await this.setActivePersist('abs')
    return u
  }

  /** 登录 ND + 落盘（密码要存，Subsonic 协议每次请求都要拿它算 token） */
  async loginNd(origin, username, password) {
    const u = await this.nd.login(origin, username, password)
    await store.set(CONFIG_KEYS.ndServer, this.nd.baseUrl)
    await store.set(CONFIG_KEYS.ndUser, username)
    await store.set(CONFIG_KEYS.ndPassword, password)
    this.loggedIn.nd = true
    // 只登录 ND 时自动切到 ND；两个都登录时保持原激活源
    if (!this.loggedIn.abs) await this.setActivePersist('nd')
    return u
  }

  /** 登出某个源 */
  async logout(src) {
    if (src === 'abs') {
      await store.remove(CONFIG_KEYS.server)
      await store.remove(CONFIG_KEYS.token)
      await store.remove(CONFIG_KEYS.username)
      this.loggedIn.abs = false
      this.abs.baseUrl = ''; this.abs.token = ''
    } else {
      await store.remove(CONFIG_KEYS.ndServer)
      await store.remove(CONFIG_KEYS.ndUser)
      await store.remove(CONFIG_KEYS.ndPassword)
      this.loggedIn.nd = false
      this.nd.baseUrl = ''
    }
    if (this.activeSource === src) await this.setActivePersist(this.available[0] || 'abs')
  }

  // ---------------- 门面：与选中源有关的调用 ----------------
  async libraries() { return this.cur.libraries() }
  getLibraryItems(libId, opts) { return this.cur.getLibraryItems(libId, opts) }
  searchLibrary(libraryId, q) { return this.cur.searchLibrary(libraryId, q) }

  /**
   * 分类搜索（ND 专用；ABS 没有分类 → 回退成"所有结果都在专辑组"）。
   * 老板 2026-09-14：搜索要分「专辑 / 歌手 / 歌曲」，不要混在一起。
   */
  async search3(libraryId, q) {
    if (this.active === 'nd' && typeof this.nd.search3 === 'function') {
      return this.nd.search3(libraryId, q)
    }
    const items = await this.searchLibrary(libraryId, q).catch(() => [])
    return { albums: items, artists: [], songs: [] }
  }
  searchAll(libs, q) { return this.cur.searchAll(libs, q) }
  collections() { return this.cur.collections() }

  /**
   * 收藏状态查询（ND 的 star / ABS 的收藏夹）。老板 2026-09-14 报的
   * 「点播放报 x.isStarred is not a function」—— 播放页调了 hub.isStarred，
   * 但门面忘了透传，只在 clientFor 分派时生效于部分方法。补上。
   * @param {string} itemId 条目 id（nd: 前缀 = ND 专辑）
   */
  isStarred(itemId) {
    const c = this.clientFor(itemId)
    if (typeof c.isStarred !== 'function') {
      // ABS 客户端没有 isStarred —— 用收藏夹列表判断
      return c.collections().then(cols =>
        (cols || []).some(col => (col.books || []).some(b => b.id === itemId))
      ).catch(() => false)
    }
    return c.isStarred(itemId)
  }

  /**
   * 继续听：**只看当前激活源**（老板原话「分开显示」+ 右上角切换按钮）。
   * 不合并两个源 —— 合并会让 ABS 的书和 ND 的专辑混在一张列表里，
   * 那正是老板要避免的"不分开"。
   *
   * ⚠️ 返回值统一成**数组**（2026-09-19 修）：ABS 客户端返回数组，
   * ND 客户端返回 `{ libraryItems }` 对象，门面直接透传 → 调用方 `.map()`
   * 在 ND 下抛 TypeError 被 try/catch 吞掉 → **ND 的「继续听」和「历史记录」
   * 永远空白**（老板 2026-09-19 提「所有出现演唱者的地方」时顺带查出来）。
   * 现在在这里收敛成同一形状，视图侧只认数组。
   */
  async itemsInProgress() {
    const r = await this.cur.itemsInProgress()
    if (Array.isArray(r)) return r
    return (r && r.libraryItems) || []
  }

  /**
   * /api/me 形状（历史页的隐藏过滤用）。
   * ABS 的 mediaProgress 是「用户删除过」的唯一可靠来源；ND 没有对应物 → 返回空。
   */
  async me() {
    if (this.active === 'nd') {
      return { username: this.nd.username, mediaProgress: [] }
    }
    return this.abs.me()
  }

  // ---------------- 门面：与具体条目有关的调用（按 id 前缀分派） ----------------
  getItem(id) { return this.clientFor(id).getItem(id) }

  coverUrl(id, opts) {
    if (!id) return ''
    return this.clientFor(id).coverUrl(id, opts)
  }

  assetUrl(path) { return this.cur.assetUrl(path) }

  startPlayback(id, startTime) { return this.clientFor(id).startPlayback(id, startTime) }
  getProgress(id) { return this.clientFor(id).getProgress(id) }
  updateProgress(id, cur, dur) { return this.clientFor(id).updateProgress(id, cur, dur) }
  removeFromContinue(id) { return this.clientFor(id).removeFromContinue(id) }

  /** ND 无会话概念：直接把 sessionId 交给对应客户端（ABS 是 /api/session/<id>） */
  syncSession(sessionId, currentTime, timeListened, duration) {
    const src = String(sessionId || '').startsWith(ND_PREFIX) ? 'nd' : 'abs'
    return this.clientFor(src).syncSession(sessionId, currentTime, timeListened, duration)
  }

  closeSession(sessionId, currentTime, timeListened, duration) {
    const src = String(sessionId || '').startsWith(ND_PREFIX) ? 'nd' : 'abs'
    return this.clientFor(src).closeSession(sessionId, currentTime, timeListened, duration)
  }

  trackUrl(contentUrl, bookId) {
    // 有 bookId 时按它分派（ND 的 contentUrl 形如 /rest/stream?id=xx，需要用户/密码算 token）
    if (bookId) return this.clientFor(bookId).trackUrl(contentUrl)
    // 没有 bookId：ND 的 /rest/ 路径与 ABS 的 /api/ 路径可区分
    if (/^\/rest\//.test(String(contentUrl || ''))) return this.nd.trackUrl(contentUrl)
    return this.abs.trackUrl(contentUrl)
  }

  authHeaders(bookId) {
    if (bookId) return this.clientFor(bookId).authHeaders()
    return this.abs.authHeaders()
  }

  /**
   * 歌单（老板 2026-09-14）。
   * ND 有 Subsonic 歌单；ABS 没有"歌单"概念（它的对应物是收藏夹 collections）→
   * 返回空数组/空实现，视图按 t('playlist') 文案统一显示。
   */
  async getPlaylists() {
    if (this.active !== 'nd') return []
    return this.nd.getPlaylists().catch(() => [])
  }

  async getPlaylist(id) {
    if (this.active !== 'nd') return null
    return this.nd.getPlaylist(id)
  }

  async createPlaylist(name, songIds = []) {
    if (this.active !== 'nd') return null
    return this.nd.createPlaylist(name, songIds)
  }

  async addSongsToPlaylist(playlistId, songIds = []) {
    if (this.active !== 'nd') return null
    return this.nd.addSongsToPlaylist(playlistId, songIds)
  }

  async removeSongsFromPlaylist(playlistId, songIds = []) {
    if (this.active !== 'nd') return false
    return this.nd.removeSongsFromPlaylist(playlistId, songIds)
  }

  async deletePlaylist(playlistId) {
    if (this.active !== 'nd') return false
    return this.nd.deletePlaylist(playlistId)
  }

  /**
   * 歌词（老板 2026-09-14：点封面切歌词页）。
   * 有歌词即返回 { synced, lines:[{start(秒), value}] }，没有返回 null。
   * ABS 侧没有歌词接口 → null（歌词页在 ABS 下不渲染入口）。
   */
  getLyrics(id) {
    if (sourceOfId(id) !== 'nd') return Promise.resolve(null)
    return this.nd.getLyrics(id)
  }

  /**
   * 歌手详情（老板 2026-09-17：ND 播放页点歌手名 → 看他全部作品）。
   * 只有 ND 有歌手概念；ABS 那边没有 → 返回 null（视图层据此不渲染入口）。
   * ⚠️ 歌手 id 前缀是 `ndart:`（不是 `nd:`）—— sourceOfId() 只认 `nd:`，
   * 直接用它会判成 ABS 返回 null（开发时踩到，测试抓出）。这里显式判两种前缀。
   */
  getArtist(artistId) {
    const id = String(artistId || '')
    if (!id.startsWith('ndart:') && !id.startsWith('nd:')) return Promise.resolve(null)
    return this.nd.getArtist(id)
  }

  /** 歌手头像直链（配自绘兜底；ABS 无 → 空串） */
  artistImageUrl(artistId, opts) {
    if (typeof this.nd.artistImageUrl !== 'function') return ''
    return this.nd.artistImageUrl(artistId, opts)
  }

  // ---- 收藏夹（按 id 分派；ND 只有 star，无收藏夹） ----
  getCollection(id) { return this.clientFor(id).getCollection(id) }
  addToCollection(colId, itemId) { return this.clientFor(itemId).addToCollection(colId, itemId) }
  removeFromCollection(colId, itemId) { return this.clientFor(itemId).removeFromCollection(colId, itemId) }

  /** ABS 专用（建收藏夹等）；ND 客户端有同名空实现 */
  post(path, body) { return this.cur.post(path, body) }
  get(path, q, o) { return this.cur.get(path, q, o) }

  /**
   * 离线下载：按 bookId 分派到对应源拼直链。
   * @param {string} bookId   书 id（nd: 前缀 = ND）
   * @param {string} contentUrl 播放会话给的 contentUrl（ABS=/api/items/x/file/y；ND=/rest/stream?id=songId）
   * @param {string} [title]  未用（保留签名兼容）
   */
  downloadUrl(bookId, contentUrl) {
    const c = this.clientFor(bookId)
    if (c === this.nd) {
      // ND：从 contentUrl 里抠出 songId，拼带凭据的 stream 直链
      const m = String(contentUrl || '').match(/[?&]id=([^&]+)/)
      const songId = m ? decodeURIComponent(m[1]) : String(contentUrl || '').split('/').pop()
      return c.streamUrl(songId)
    }
    return c.trackUrl(contentUrl)
  }

  /**
   * 某个源的书库列表（视图用来知道"当前源有哪些库"）
   * 取不到就返回空数组，不抛（单源登录时另一个源本来就没数据）
   */
  async librariesOf(src) {
    if (!this.loggedIn[src]) return []
    try { return await this.clientFor(src).libraries() } catch (_) { return [] }
  }
}

export const hub = new ServerHub()
export { ServerHub }

/**
 * 视图统一 import 这个 `abs` 名（保持调用处代码不变，只换 import 来源）。
 * 名字沿用 abs 是为了让 12 个视图的最小改动 = 只改 import 路径。
 */
export const abs = hub
export { AbsApi }
export default hub

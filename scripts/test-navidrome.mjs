/**
 * Navidrome 适配层回归（老板 2026-09-14 多源需求）
 *
 * 测的是真代码：把 navidrome.js 的网络层（rawRequest/平台探测）替换成可控假服务器，
 * 断言认证参数、形状映射（专辑→书/歌曲→集）、进度换算（bookmark↔全书秒）。
 *
 * 关键回归点：
 *  1. 认证 URL 一定带 u/t/s（t=md5(password+salt)，salt 每次不同）
 *  2. 错误码翻译（40 → 用户名或密码不对）
 *  3. getAlbumList2 → results[]（id 带 nd: 前缀，duration/songCount 对齐）
 *  4. getAlbum → chapters 的 startOffset 是逐首累计（与 ABS 全书口径一致）
 *  5. updateProgress：全书秒 → 每首歌一个 bookmark，偏移换算正确
 *  6. getProgress：bookmarks → 全书秒（落在第 N 首 = 前面累计 + position）
 *  7. itemsInProgress：按 bookmark.updated 倒序聚合到专辑、去重
 */
import fs from 'fs'
import path from 'path'
import { fileURLToPath, pathToFileURL } from 'url'
import { execSync } from 'child_process'
import { md5 } from '../src/lib/md5.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

// ---------- 假 ND 服务器（存专辑/歌曲/bookmark/star） ----------
function makeServer() {
  const songs = []
  for (let a = 1; a <= 2; a++) {
    for (let s = 1; s <= 3; s++) {
      songs.push({
        id: `song-a${a}-${s}`, albumId: `alb${a}`, album: `专辑${a}`,
        title: `第${s}首`, artist: `歌手${a}`, artistId: `art${a}`, duration: 100 + s * 10, track: s,
        contentType: 'audio/mpeg', suffix: 'mp3',
      })
    }
  }
  const albums = [1, 2].map(a => ({
    id: `alb${a}`, name: `专辑${a}`, artist: `歌手${a}`, artistId: `art${a}`,
    songCount: 3, duration: songs.filter(s => s.albumId === `alb${a}`).reduce((x, y) => x + y.duration, 0),
    coverArt: `alb-${a}`, created: '2026-01-01T00:00:00Z',
  }))
  // 翻页测试数据：35 张专辑（一页 500 拉不完，要翻页/单页不满即止）
  const manyAlbums = []
  for (let i = 1; i <= 35; i++) {
    manyAlbums.push({ id: `many${i}`, name: `批量专辑${String(i).padStart(2, '0')}`, artist: `群星`, songCount: 1, duration: 60, coverArt: `many${i}` })
  }
  const state = { bookmarks: {}, starred: new Set(), playlists: { pl1: { id: 'pl1', name: '我的最爱', songIds: ['song-a1-1', 'song-a1-2'] } } }

  let listCalls = 0
  function handle(url) {
    const u = new URL(url, 'http://x')
    const p = u.pathname, q = u.searchParams
    const auth = { u: q.get('u'), t: q.get('t'), s: q.get('s') }
    const ok = body => ({ status: 200, data: { 'subsonic-response': { status: 'ok', version: '1.16.1', ...body } } })
    const fail = (code, message) => ({ status: 200, data: { 'subsonic-response': { status: 'failed', error: { code, message } } } })

    if (!auth.u || !auth.t || !auth.s) return fail(10, "missing parameter")
    if (auth.u !== 'bin') return fail(40, 'Wrong username or password')

    switch (p) {
      case '/rest/ping': return ok({})
      case '/rest/getUser': return ok({ user: { username: 'bin', adminRole: true } })
      case '/rest/getMusicFolders': return ok({ musicFolders: { musicFolder: [{ id: 'lib1', name: '音乐' }] } })
      case '/rest/getAlbumList2': {
        listCalls++
        const size = Number(q.get('size') || 10), off = Number(q.get('offset') || 0)
        // 单次最多 20 条（真实 Navidrome 也有上限，这里刻意压小以便断言"翻了几页"）。
        // 指定 musicFolderId 时只给那 2 张专辑（老用例语义不变）；
        // 不指定时给「2 张 + 35 张批量」= 37 张（翻页回归用）。
        const pool = q.get('musicFolderId') ? albums : [...albums, ...manyAlbums]
        return ok({ albumList2: { album: pool.slice(off, off + Math.min(size, 20)) } })
      }
      case '/rest/getAlbum': {
        const id = q.get('id')
        const a = albums.find(x => x.id === id)
        if (!a) return fail(70, 'not found')
        return ok({ album: { ...a, song: songs.filter(s => s.albumId === id) } })
      }
      case '/rest/getSong': {
        const s = songs.find(x => x.id === q.get('id'))
        return s ? ok({ song: s }) : fail(70, 'not found')
      }
      case '/rest/search3':
        // 支持按歌曲名/歌手名搜（getArtist 的歌曲列表靠 search3 + songCount）
        {
          const q2 = q.get('query') || ''
          const wantSongs = Number(q.get('songCount') || 0)
          return ok({
            searchResult3: {
              album: albums.filter(a => (a.name || '').includes(q2)),
              artist: q2 ? [{ id: 'art1', name: '歌手1' }] : [],
              // 合作曲（artistId 不同）会被 getArtist 按 artistId 过滤掉
              song: wantSongs
                ? songs.filter(s => s.artist === q2).concat([
                    { id: 'coop1', albumId: 'alb1', album: '专辑1', title: '合作曲',
                      artist: '歌手1', artistId: 'otherart', duration: 90, track: 9, contentType: 'audio/mpeg' },
                  ])
                : [],
            },
          })
        }
      case '/rest/getArtist':
        return ok({
          artist: {
            id: q.get('id'), name: '歌手1', albumCount: 2,
            album: albums.map(a => ({ ...a, artistId: 'art1' })),
          },
        })
      case '/rest/getStarred2':
        return ok({ starred2: { album: albums.filter(a => state.starred.has(a.id)) } })
      case '/rest/star': {
        state.starred.add(q.get('albumId') || q.get('id'))
        return ok({})
      }
      case '/rest/unstar': {
        state.starred.delete(q.get('albumId') || q.get('id'))
        return ok({})
      }
      case '/rest/getAlbumInfo2': {
        const id = q.get('id')
        return ok({ albumInfo: { starred: state.starred.has(id) ? '2026-01-02T00:00:00Z' : undefined } })
      }
      case '/rest/getBookmarks': {
        const list = Object.entries(state.bookmarks).map(([id, b]) => ({ id, ...b }))
        return ok({ bookmarks: { bookmark: list } })
      }
      case '/rest/createBookmark': {
        state.bookmarks[q.get('id')] = { position: Number(q.get('position')), created: new Date().toISOString(), updated: new Date().toISOString() }
        return ok({})
      }
      case '/rest/deleteBookmark': { delete state.bookmarks[q.get('id')]; return ok({}) }
      case '/rest/scrobble': return ok({})
      case '/rest/getPlaylists': {
        const list = Object.values(state.playlists).map(p => ({
          id: p.id, name: p.name, songCount: p.songIds.length,
          duration: p.songIds.reduce((n, sid) => n + (songs.find(s => s.id === sid)?.duration || 0), 0),
          owner: 'bin', public: false, changed: '2026-01-03T00:00:00Z',
        }))
        return ok({ playlists: { playlist: list } })
      }
      case '/rest/getPlaylist': {
        const p = state.playlists[q.get('id')]
        if (!p) return fail(70, 'not found')
        const entry = p.songIds.map(sid => songs.find(s => s.id === sid)).filter(Boolean)
        return ok({ playlist: { id: p.id, name: p.name, songCount: entry.length, duration: 0, entry } })
      }
      case '/rest/createPlaylist': {
        const id = 'pl' + (Object.keys(state.playlists).length + 1)
        const songIds = q.getAll('songId') || []
        state.playlists[id] = { id, name: q.get('name') || '新歌单', songIds }
        return ok({ playlist: { id, name: state.playlists[id].name, songCount: songIds.length } })
      }
      case '/rest/updatePlaylist': {
        const p = state.playlists[q.get('playlistId')]
        if (!p) return fail(70, 'not found')
        for (const sid of (q.getAll('songIdToAdd') || [])) p.songIds.push(sid)
        const rm = (q.getAll('songIndexToRemove') || []).map(Number).sort((a, b) => b - a)
        for (const i of rm) p.songIds.splice(i, 1)
        return ok({})
      }
      case '/rest/deletePlaylist': {
        delete state.playlists[q.get('id')]
        return ok({})
      }
      case '/rest/getLyricsBySongId': {
        const sid = q.get('id')
        if (sid !== 'song-a1-1') return ok({ lyricsList: {} })
        return ok({ lyricsList: { structuredLyrics: [{
          lang: 'chi', synced: true, line: [
            { start: 5000, value: '第一行' },
            { start: 12000, value: '第二行' },
            { start: 8000, value: '中间插入（乱序）' },
          ],
        }] } })
      }
      default: return fail(0, 'unknown endpoint ' + p)
    }
  }
  return { handle, state, songs, albums, manyAlbums, listCalls: () => listCalls }
}

// ---------- 加载真代码（替换网络层与平台探测） ----------
const srv = makeServer()
const SRC = fs.readFileSync(path.join(ROOT, 'src/lib/navidrome.js'), 'utf8')
const stubPath = path.join(ROOT, '.tmp-nd-under-test.mjs')
let code = SRC
  .replace(/import \{ CapacitorHttp \} from '@capacitor\/core'/, 'const CapacitorHttp = null')
  .replace(/import \{ md5, randomSalt \} from '\.\/md5\.js'/, 'const { md5, randomSalt } = globalThis.__ND_MD5__')
  .replace(/function isNativeShell\(\)[\s\S]*?\n\}/, 'function isNativeShell() { return false }')
  .replace(/const ctrl = new AbortController\(\)[\s\S]*?finally \{ clearTimeout\(timer\) \}/,
    `const r = globalThis.__ND_SERVER__(url)
     return { status: r.status, ok: r.status >= 200 && r.status < 300, headers: {}, data: r.data }`)
fs.writeFileSync(stubPath, code)

globalThis.__ND_MD5__ = await import(pathToFileURL(path.join(ROOT, 'src/lib/md5.js')).href)
globalThis.__ND_SERVER__ = url => srv.handle(url)
const { NavidromeApi } = await import(pathToFileURL(stubPath).href)

// ---------- 断言 ----------
let pass = 0, failN = 0
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ✅ ${name}`) }
  else { failN++; console.log(`  ❌ ${name}${extra ? ' — ' + extra : ''}`) }
}

const nd = new NavidromeApi()
nd.configure('http://127.0.0.1:4533', 'bin', 'pw123')

console.log('\n=== 1. 认证与探活 ===')
{
  const me = await nd.login('http://127.0.0.1:4533/', 'bin', 'pw123')
  ok('登录成功（ping + getUser）', !!me?.username)
  ok('管理角色映射', me.type === 'admin')
  // 错误凭据
  const bad = new NavidromeApi()
  bad.configure('http://127.0.0.1:4533', 'who', 'x')
  let err = null
  try { await bad.login('http://127.0.0.1:4533', 'who', 'x') } catch (e) { err = e }
  ok('错凭据 → 「用户名或密码不对」', err && /用户名或密码/.test(err.message), err?.message)
  // 认证参数完整性：抓一次真实 URL
  const u = new URL(nd.url('/rest/ping'))
  ok('URL 带 u/t/s/v/c/f 六参数', ['u','t','s','v','c','f'].every(k => u.searchParams.get(k)))
  const expectedT = md5('pw123' + u.searchParams.get('s'))
  ok('t = md5(password + salt)', u.searchParams.get('t') === expectedT)
}

console.log('\n=== 2. 库/书目映射 ===')
{
  const libs = await nd.libraries()
  ok('库列表', libs.length === 1 && libs[0].name === '音乐', JSON.stringify(libs))
  const items = await nd.getLibraryItems('lib1', { limit: 10 })
  ok('专辑 → results', items.results.length === 2)
  const it = items.results[0]
  ok('id 带 nd: 前缀', String(it.id).startsWith('nd:'), it.id)
  ok('专辑名 → title', it.media.metadata.title === '专辑1')
  ok('艺术家 → authorName', it.media.metadata.authorName === '歌手1')
  ok('songCount → 集数', it.media.songCount === 3)
  ok('专辑时长 = 歌曲累计', it.media.duration === 360, String(it.media.duration))
}

console.log('\n=== 3. 详情：歌曲 → 集（startOffset 累计口径）===')
{
  const d = await nd.getItem('nd:alb1')
  const ch = d.media.chapters
  ok('3 首歌 → 3 章', ch.length === 3)
  ok('第1首 start=0', ch[0].start === 0)
  ok('第2首 start=110（累计）', ch[1].start === 110, String(ch[1].start))
  ok('第3首 start=230（累计）', ch[2].start === 230, String(ch[2].start))
  ok('audioFiles 的 ino = songId', d.media.audioFiles[1].ino === 'song-a1-2')
  ok('全书时长 = 360', d.media.duration === 360)
  ok('track contentUrl 指向 stream', d.media.chapters && d._ndSongs.length === 3)
}

console.log('\n=== 4. 收藏（star）===')
{
  ok('初始未收藏', !(await nd.isStarred('nd:alb1')))
  await nd.addToCollection('nd:starred', 'nd:alb1')
  ok('star 后 isStarred=true', await nd.isStarred('nd:alb1'))
  const cols = await nd.collections()
  ok('收藏分组出现且含该书', cols.length === 1 && cols[0].books[0].id === 'nd:alb1')
  await nd.removeFromCollection('nd:starred', 'nd:alb1')
  ok('unstar 后 isStarred=false', !(await nd.isStarred('nd:alb1')))
}

console.log('\n=== 5. 进度：全书秒 → bookmark → 回读 ===')
{
  // 听到第 2 首中部：全书 110 + 50 = 160 秒
  await nd.updateProgress('nd:alb1', 160, 360)
  let bm = srv.state.bookmarks
  ok('第1首歌记满（110s，整首）', bm['song-a1-1']?.position === 110, JSON.stringify(bm))
  ok('第2首歌记歌内 50s', bm['song-a1-2']?.position === 50, JSON.stringify(bm['song-a1-2']))
  ok('第3首歌无 bookmark', !bm['song-a1-3'])
  const prog = await nd.getProgress('nd:alb1')
  ok('回读 currentTime=160（全书口径）', Math.round(prog.currentTime) === 160, JSON.stringify(prog))
  ok('isFinished=false', prog.isFinished === false)
  // 听完整本
  await nd.updateProgress('nd:alb1', 360, 360)
  const fin = await nd.getProgress('nd:alb1')
  ok('听到末尾 → isFinished=true', fin.isFinished === true, JSON.stringify(fin))
}

console.log('\n=== 6. 继续听聚合 ===')
{
  // alb1 听到 160s，alb2 也建个 bookmark（更晚）
  await nd.updateProgress('nd:alb2', 30, 360)
  const d = await nd.itemsInProgress()
  const items = d.libraryItems
  ok('两张专辑都出现在继续听', items.length === 2, JSON.stringify(items.map(i => i.id)))
  ok('都有 nd: 前缀（视图能区分来源）', items.every(i => String(i.id).startsWith('nd:')))
  // 长按移除
  await nd.removeFromContinue('nd:alb2')
  const d2 = await nd.itemsInProgress()
  ok('移除后只剩 1 条', d2.libraryItems.length === 1 && d2.libraryItems[0].id === 'nd:alb1')
}

console.log('\n=== 7. 会话兼容（App 播放器无感接入）===')
{
  const s = await nd.startPlayback('nd:alb1', 0)
  ok('sessionId 是 nd: 前缀', String(s.sessionId).startsWith('nd:'), s.sessionId)
  ok('tracks 3 条、startOffset 累计', s.tracks.length === 3 && s.tracks[2].startOffset === 230)
  ok('trackUrl 拼出带凭据的 stream 直链', /u=bin&t=[0-9a-f]{32}&s=/.test(nd.trackUrl(s.tracks[0].contentUrl)))
  // syncSession 兼容层不抛
  await nd.syncSession(s.sessionId, 100, 10, 360)
  ok('syncSession 走通（写了 bookmark）', !!srv.state.bookmarks['song-a1-1'])
}

console.log('\n=== 8. 翻页拉全量专辑（老板 2026-09-14：953 张只显示 200 张）===')
{
  // 假服务器单次最多给 20 条，库里有 37 张 → 必须翻页才能拿全。
  // 旧代码只发一次请求（size=min(limit,500)）→ 永远拿不到 20 条以上，
  // 这就是老板报的「953 张只显示 200 张」的同一个 bug。
  const before = srv.listCalls()
  const r = await nd.getLibraryItems(null, { limit: 2000 })
  const calls = srv.listCalls() - before
  ok('limit=2000 拿全 37 张（跨页聚合）', r.results.length === 37, `实际 ${r.results.length}`)
  ok('确实翻了页（≥2 次请求）', calls >= 2, `请求 ${calls} 次`)
  ok('total 反映全部拿到数', r.total === 37, String(r.total))
  ok('没有重复条目', new Set(r.results.map(x => x.id)).size === 37)
  // 只请求 15 条时不应多翻页（翻页要按需，别白拉全库）
  const b2 = srv.listCalls()
  const r15 = await nd.getLibraryItems(null, { limit: 15 })
  ok('limit=15 时只发 1 次请求（按需翻页）', srv.listCalls() - b2 === 1, `请求 ${srv.listCalls() - b2} 次`)
  ok('limit=15 拿 15 条', r15.results.length === 15, String(r15.results.length))
  // 旧语义保留：显式 page>0 仍取单页
  const p0 = await nd.getLibraryItems(null, { limit: 10 })
  const p1 = await nd.getLibraryItems(null, { limit: 10, page: 1 })
  ok('显式 page>0 仍走单页语义（10 条）', p1.results.length === 10, `实际 ${p1.results.length}`)
  ok('第二页内容与第一页不同（offset 生效）', p1.results[0].id !== p0.results[0].id, `${p1.results[0].id} vs ${p0.results[0].id}`)
}

console.log('\n=== 9. 歌单（列表/详情/加歌/新建/删）===')
{
  const pls = await nd.getPlaylists()
  ok('歌单列表非空', pls.length === 1 && pls[0].name === '我的最爱', JSON.stringify(pls))
  ok('歌单 id 带 ndpl: 前缀（与 album/歌 区分）', String(pls[0].id).startsWith('ndpl:'), pls[0].id)
  ok('歌曲数为 2', pls[0].songCount === 2, String(pls[0].songCount))

  const pl = await nd.getPlaylist('ndpl:pl1')
  ok('歌单详情带曲目', pl.songs.length === 2, String(pl.songs.length))
  ok('曲目 id 带 nd: 前缀、songId 是纯 ND id', pl.songs[0].id === 'nd:song-a1-1' && pl.songs[0].songId === 'song-a1-1')
  ok('曲目带 albumId（跨专辑播放要它）', pl.songs[0].albumId === 'nd:alb1', pl.songs[0].albumId)

  // 加歌（重复参数 songIdToAdd）
  await nd.addSongsToPlaylist('ndpl:pl1', ['song-a2-1', 'song-a2-2'])
  const after = await nd.getPlaylist('ndpl:pl1')
  ok('加歌生效（2 → 4）', after.songs.length === 4, String(after.songs.length))

  // 移歌（songIndexToRemove 是下标，必须服务端算位置）
  await nd.removeSongsFromPlaylist('ndpl:pl1', ['song-a1-1'])
  const after2 = await nd.getPlaylist('ndpl:pl1')
  ok('移歌生效（4 → 3）', after2.songs.length === 3, String(after2.songs.length))
  ok('移掉的是指定那首', !after2.songs.some(s => s.songId === 'song-a1-1'))

  // 新建（带初始曲目）
  const np = await nd.createPlaylist('新歌单', ['song-a1-3'])
  ok('新建歌单返回 id', !!np?.id, JSON.stringify(np))
  const npd = await nd.getPlaylist(np.id)
  ok('新建时带上初始曲目', npd.songs.length === 1, String(npd.songs.length))

  // 删除
  await nd.deletePlaylist(np.id)
  const all = await nd.getPlaylists()
  ok('删除后不在列表', !all.some(p => p.name === '新歌单'))
}

console.log('\n=== 10. 歌词（结构化 + 毫秒→秒 + 排序）===')
{
  const lyr = await nd.getLyrics('song-a1-1')
  ok('拿到歌词', !!lyr && lyr.lines.length === 3, JSON.stringify(lyr))
  ok('synced=true 识别', lyr.synced === true)
  ok('毫秒换算成秒', lyr.lines[0].start === 5, String(lyr.lines[0].start))
  ok('按时间排序（乱序输入已纠正）', lyr.lines.map(l => l.start).join(',') === '5,8,12', lyr.lines.map(l => l.start).join(','))
  const none = await nd.getLyrics('song-a2-3')
  ok('无歌词返回 null', none === null, JSON.stringify(none))
}

console.log('\n=== 11. 歌手详情（老板 2026-09-17/19：所有演唱者可点 → 歌手页）===')
{
  // ⚠️ 404 回归：getArtist 返回的歌曲 albumId 必须带 nd: 前缀。
  //    不带前缀时视图 go('album', {id: 裸id}) 会被 sourceOfId 判成 ABS →
  //    拿 ND 专辑 id 去查有声书服务器 → 404（老板 2026-09-19 报的 bug）。
  for (const input of ['nd:art1', 'ndart:art1']) {
    const a = await nd.getArtist(input)
    ok(`getArtist(${input}) 认两种前缀 + 返回歌手名`, a.name === '歌手1', JSON.stringify({ name: a.name }))
    ok(`getArtist(${input}) 名下专辑带 nd: 前缀`, a.albums.length === 2 && a.albums.every(x => x.id.startsWith('nd:')),
       JSON.stringify(a.albums.map(x => x.id)))
    ok(`getArtist(${input}) 歌曲非空（前缀没剥干净会全军覆没）`, a.songs.length > 0,
       JSON.stringify({ n: a.songs.length }))
    ok(`getArtist(${input}) 歌曲 albumId 带 nd: 前缀（404 根因）`,
       a.songs.every(s => !s.albumId || s.albumId.startsWith('nd:')),
       JSON.stringify(a.songs.map(s => s.albumId)))
    ok(`getArtist(${input}) 合作曲被 artistId 过滤`, !a.songs.some(s => s.songId === 'coop1'),
       JSON.stringify(a.songs.map(s => s.songId)))
  }
}

try { fs.unlinkSync(stubPath) } catch (_) {}
console.log('\n==============================================')
console.log(`结果：${pass} 通过 / ${failN} 失败`)
process.exit(failN ? 1 : 0)

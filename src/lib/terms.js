/**
 * 术语（老板 2026-09-14）
 *
 * 「在 ND 那个界面，所有的提示你也注意一下，它不是书了，它是歌曲」
 *
 * 背景：ABS 是**有声书**（一本书=多集），ND 是**音乐/专辑**（一张专辑=多首歌）。
 * 界面文案里写死的"书 / 本书 / 听这本书"在 ND 下全是错的。
 *
 * 用法：文案里不要写死名词，走 t('book') / t('books') 这种取词函数。
 * 单一入口（hub.active）决定用哪套词，视图不用自己判断来源。
 */
import { hub } from './servers.js'

const WORDS = {
  abs: {
    book: '书', books: '本',              // 「没有收藏的书」「3 本」
    item: '书', items: '本书',
    library: '书库', libraryEmpty: '这个账号没有可用的书库',
    shelf: '书架', shelfEmpty: '书架是空的', shelfLoading: '正在加载书架…',
    all: '全部书籍',
    noResult: q => `没找到${q ? '「' + q + '」' : ''}相关的书`,
    noAudio: '这本书没有音频文件',
    openFail: '打不开这本书',
    notPlaying: '还没有在播放的书',
    goShelf: '去书架',
    favorites: '收藏的书',
    cached: n => `已缓存 ${n} 本书`,
    cacheEmpty: '还没有缓存的书',
    history: '开始听一本书，这里就会留下记录',
    // 章节/集
    chapter: '章节', chapters: '章节',
    finished: '这本听完啦',
    // 歌单（ABS 没有歌单概念；仅 ND 暴露入口，词放这里兜底）
    playlist: '歌单', playlists: '歌单',
    playlistEmpty: '还没有歌单',
    song: '歌曲', songs: '首',
    addToPlaylist: '添加到歌单', newPlaylist: '新建歌单',
  },
  nd: {
    book: '专辑', books: '张',            // ND 里一张专辑 = ABS 里的一本书
    item: '专辑', items: '张专辑',
    library: '音乐库', libraryEmpty: '这个账号没有可用的音乐库',
    shelf: '音乐库', shelfEmpty: '音乐库是空的', shelfLoading: '正在加载音乐…',
    all: '全部专辑',
    noResult: q => `没找到${q ? '「' + q + '」' : ''}相关的专辑或歌曲`,
    noAudio: '这张专辑没有音频文件',
    openFail: '打不开这张专辑',
    notPlaying: '还没有在播放的歌曲',
    goShelf: '去音乐库',
    favorites: '收藏的专辑',
    cached: n => `已缓存 ${n} 张专辑`,
    cacheEmpty: '还没有缓存的专辑',
    history: '开始听一首歌，这里就会留下记录',
    chapter: '歌曲', chapters: '歌曲',
    finished: '这张专辑听完啦',
    // 歌单（老板 2026-09-14）
    playlist: '歌单', playlists: '歌单',
    playlistEmpty: '还没有歌单，在播放页或搜索页可以把歌加进来',
    song: '歌曲', songs: '首',
    addToPlaylist: '添加到歌单', newPlaylist: '新建歌单',
  },
}

/**
 * 取词。中文里「书/专辑」这类词做量词时位置不同（"3 本书" vs "3 张专辑"），
 * 所以用 count + noun 组合而不是硬拼。
 * @param {string} key WORDS 里的键
 * @param {object} [opts] 需要参数的键（如 noResult 的 q、cached 的 n）
 */
export function t(key, opts) {
  const set = WORDS[hub.active] || WORDS.abs
  const v = set[key]
  if (v === undefined) return WORDS.abs[key]
  return typeof v === 'function' ? v(opts) : v
}

/** 数量 + 单位：「3 本」/「3 张」 */
export function count(n) {
  return `${n} ${t('books')}`
}

/** 名词 + 数量（用于"收藏的书 3 本"这类副标题） */
export function noun() { return t('book') }

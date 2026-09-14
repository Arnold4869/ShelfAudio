/** 书架：大卡片网格 + 继续听（只有一种模式，见 2026-09-12 老板要求取消模式分类） */
import { hub as abs } from '../lib/servers.js'   // 多源门面：按 id 前缀分派 ABS / Navidrome
import { t } from '../lib/terms.js'

/** 点列表条目：ND 专辑进详情页自己选歌；ABS 书保持原行为（直接续听） */
async function openOrPlay(it, { resumeAt } = {}) {
  if (String(it.id).startsWith('nd:')) { await go('album', { id: it.id }); return }
  try { await playItem(it, resumeAt === undefined ? {} : { startTime: resumeAt }) }
  catch (e) { toast(e.message || t('openFail')) }
}
   // 术语：ND 下「书」→「专辑」（老板 2026-09-14）
import { state, go, toast, esc, fmtDur, playItem, requireParentPin, updateMini, resetForSourceSwitch } from '../app.js'
import { openVoiceOverlay } from '../lib/voice-ui.js'
import { fallbackCover, wireCoverFallback } from '../lib/cover.js'
import { listContinueLocal } from '../lib/continue-local.js'
import { voiceHidden, uiPrefsReady } from '../lib/ui-prefs.js'
import { icon } from '../lib/icons.js'
import { kidTabsHTML, wireKidTabs } from '../lib/nav.js'
import { haptic } from '../lib/haptics.js'
import { sourceSwitchHTML, wireSourceSwitch } from '../lib/source-switch.js'
import { hub } from '../lib/servers.js'

let cache = { items: [], at: 0, libraryId: null }

export async function renderShelf(root) {
  // 只有一种模式了（老板要求取消儿童/成人分类）。保留 kid 常量便于阅读，恒为 true。
  const kid = true
  root.innerHTML = `<div class="empty"><div class="glyph">${icon('loader', 40, 'spin')}</div>${t('shelfLoading')}</div>`

  if (!state.libraryId) {
    try {
      const libs = await abs.libraries()
      state.libraries = libs
      state.libraryId = libs[0]?.id
    } catch (e) { }
  }
  if (!state.libraryId) {
    root.innerHTML = `<div class="empty"><div class="glyph">${icon('books', 44)}</div>${t('libraryEmpty')}</div>`
    return
  }

  // 缓存键带源名：切到另一台服务器时不能吃到上一台的缓存
  const cacheKey = hub.active + ':' + state.libraryId

  let items = []
  try {
    // 缓存策略（2026-09-13 性能审计后重定）：
    // 纯靠短 TTL 不行 —— 3 秒几乎永不命中（回书架都要重新 4 个请求、白等几百毫秒），
    // 60 秒又不刷新进度（2026-09-13 老板报过"刚听完的书回到书架还显示旧进度"）。
    // 方案：列表本体缓存 60 秒（书单很少变），但进度显示一律以随后的
    // me() 实时结果为准（progressMap 每次都新拉，22ms 级），两全。
    // 长按删除等改数据的操作已自带 cache.at = 0 强制失效。
    if (cache.libraryId === cacheKey && Date.now() - cache.at < 60000 && cache.items.length) {
      items = cache.items
    } else {
      const d = await abs.getLibraryItems(state.libraryId, { limit: 200, sort: 'media.metadata.title' })
      items = d?.results || []
      cache = { items, at: Date.now(), libraryId: cacheKey }
    }
  } catch (e) {
    root.innerHTML = `<div class="empty"><div class="glyph">${icon('warning', 44)}</div>${esc(e.message)}</div>`
    return
  }
  state.items = items

  if (!items.length) {
    root.innerHTML = `<div class="empty"><div class="glyph">${icon('books', 44)}</div>${t('shelfEmpty')}</div>`
    return
  }

  // 继续听：按「最后播放时间」倒序（最近听的在最前）。
  // ABS 的 /api/me/items-in-progress 不保证顺序（实测同一个库返回顺序稳定但与时间无关），
  // 所以本地按 progressLastUpdate 再排一次；该字段缺失时退回 mediaProgress.lastUpdate。
  let inProgress = []
  let progressMapEarly = {}
  // 性能（2026-09-13 审计）：me() 和 itemsInProgress() 原来串行（两次 RTT 相加），
  // 两者互不依赖 → Promise.all 并行，书架渲染少等一个往返。
  const localCont = await listContinueLocal()   // 本地读，先做（极快）
  const _meP = abs.me().catch(() => null)
  const _ipP = abs.itemsInProgress().catch(() => null)
  const me = await _meP
  for (const mp of (me?.mediaProgress || [])) {
    const id = mp.libraryItemId || mp.mediaItemId
    if (id) progressMapEarly[id] = mp
  }
  const serverIds = new Set()
  try {
    const raw = await _ipP
    inProgress = (raw || [])
      .map(it => {
        const mp = progressMapEarly[it.id]
        const ts = it.progressLastUpdate || mp?.lastUpdate || mp?.finishedAt || 0
        return { it, ts: Number(ts) || 0 }
      })
      .sort((a, b) => b.ts - a.ts)      // 最近听的排最前
      .map(x => x.it)
      .slice(0, 8)
    for (const it of inProgress) serverIds.add(it.id)
  } catch (_) { }
  // 本地补记里，已被用户在服务端隐藏的书也不再显示（否则「删了又回来」）
  const hiddenIds = new Set(
    Object.values(progressMapEarly)
      .filter(mp => mp.hideFromContinueListening)
      .map(mp => mp.libraryItemId || mp.mediaItemId)
      .filter(Boolean)
  )
  //  审计发现（2026-09-13，真实服务器实测）：ABS 的 /api/me/items-in-progress
  // **会返回已标记 hideFromContinueListening 的书**（实测「示例故事乙1」「示例科普」
  // 两本 hide=true 却仍在列表里）。所以「长按删除」看着没生效 —— 服务端确实记了隐藏，
  // 但列表接口照样把它吐回来。必须客户端自己按 mediaProgress 过滤。
  inProgress = inProgress.filter(it => !hiddenIds.has(it.id))
  const localOnly = localCont.filter(x => !serverIds.has(x.id) && !hiddenIds.has(x.id))
    .map(x => ({ id: x.id, media: { metadata: { title: x.title, authorName: x.author }, duration: x.duration } }))
  inProgress = [...localOnly, ...inProgress]

  const progressMap = progressMapEarly

  const cardHTML = (it, big) => {
    const m = it.media?.metadata || {}
    const title = m.title || '未命名'
    const prog = progressMap[it.id]
    const pct = prog && prog.duration ? Math.min(100, Math.round((prog.currentTime || 0) / prog.duration * 100)) : 0
    const cover = abs.coverUrl(it.id, { width: big ? 420 : 200 })
    const done = prog?.isFinished
    return `
      <div class="book-card" data-id="${it.id}">
        <div class="cover-slot">
          ${fallbackCover({ title, author: m.authorName || m.narratorName, cls: 'cover-ph-card' })}
          <img class="book-cover" data-cover src="${cover}" alt="" loading="lazy">
        </div>
        ${prog && (prog.currentTime > 30) ? `<div class="book-badge">${done ? '已听完' : '听 ' + pct + '%'}</div>` : ''}
        <div class="book-meta">
          <div class="book-title">${esc(title)}</div>
          <div class="book-sub">${esc(m.authorName || m.narratorName || fmtDur(it.media?.duration))}</div>
        </div>
        ${pct > 0 && pct < 100 ? `<div class="book-progress"><i style="width:${pct}%"></i></div>` : ''}
      </div>`
  }

  // 设置入口只留底栏那个（右上角不再放齿轮，避免两个入口重复）
  // 页头：标题 + 右上角服务器切换（只有两台都登录时才出现）
  const srcLabel = hub.multi ? ` <small>· ${hub.active === 'nd' ? 'Navidrome' : 'Audiobookshelf'}</small>` : ''
  // ND 下标题带「音乐库」而不是「首页」（老板 2026-09-14：ND 界面不能说"书"）。
  // 单源 ND 时用库名更直白；双源时保留"首页"避免标题过长，源名在右上角按钮上。
  const pageTitle = hub.active === 'nd'
    ? (hub.multi ? '首页' : t('shelf'))
    : '首页'
  const head = `<div class="page-head">
         <div class="page-title">${pageTitle}${srcLabel}</div>
         ${sourceSwitchHTML('kidhome')}
       </div>`

  // 两个入口按钮并排等大（老板 2026-09-13）：「历史记录」「我的收藏」
  const entBtn = (id, ico, label) => `<button class="entry-btn" id="${id}" aria-label="${label}">
        <span class="entry-ic">${icon(ico, 22)}</span><span class="entry-label">${label}</span>
      </button>`
  const entryHTML = `<div class="entry-row">
      ${entBtn('historyEntryCard', 'list', '历史记录')}
      ${entBtn('favEntryCard', 'heart', '我的收藏')}
    </div>`
  // 继续听：**列表形式**（老板 2026-09-13 拍板）。
  // 之前是横排卡片，问题：不同书封面比例不一 → 卡片一高一矮；
  // 无封面的书只显示占位图的一小截，带图标的又不一样，观感很乱。
  // 沿用 App 里通用的 .list-item 列表样式（与收藏/缓存/搜索结果一致），
  // 高度统一、信息一行一列，不依赖封面比例。
  //  首页不再放历史记录预览列表（老板 2026-09-13：「首页现在有两个历史记录，
  // 把第二个那个占用大的历史记录去掉」）。原来这里是「入口按钮 + 小节标题 + 3 条预览」，
  // 等于同一件事出现两次，而且预览列表很占竖向空间。现在只留顶部那两枚入口按钮，
  // 点「历史记录」进完整清单页。
  const continueHTML = entryHTML

  // （原来这里有一套"成人模式紧凑列表"分支，随模式分类一起移除了）
  const rowHTML = (it) => {
    const m = it.media?.metadata || {}
    const title = m.title || '未命名'
    const prog = progressMap[it.id]
    const pct = prog && prog.duration ? Math.min(100, Math.round((prog.currentTime || 0) / prog.duration * 100)) : 0
    const done = prog?.isFinished
    const dur = fmtDur(it.media?.duration)
    const who = m.authorName || m.narratorName || ''
    const tail = done ? '已听完' : (pct > 0 ? pct + '%' : icon('play', 15))
    return `
      <div class="list-item" data-id="${it.id}">
        <div class="cover-slot">
          ${fallbackCover({ title, author: who, cls: 'cover-ph-list' })}
          <img class="list-cover" data-cover src="${abs.coverUrl(it.id, { width: 160 })}" alt="" loading="lazy">
        </div>
        <div class="list-main">
          <div class="list-title">${esc(title)}</div>
          <div class="list-sub">${esc(who)}${who && dur ? ' · ' : ''}${esc(dur)}</div>
        </div>
        <div class="list-pct">${tail}</div>
      </div>`
  }

  root.innerHTML = head + continueHTML +
    `<div class="shelf-grid">${items.map(it => cardHTML(it, true)).join('')}</div>`

  await uiPrefsReady()   // 先确保偏好读完，按钮显隐不闪
  // 语音按钮：设置页可隐藏（老板 2026-09-13：「加个开关…可以隐藏语音按钮」）
  root.insertAdjacentHTML('beforeend',
    (voiceHidden() ? '' : `<button class="voice-fab" data-voice="1" aria-label="语音搜索">${icon('mic', 28)}</button>`)
    + kidTabsHTML('kidhome'))
  wireKidTabs(root, { go, requireParentPin })
  // 服务器切换（只有两台都登录时才有这个按钮）。切换后必须重置 libraryId/items，
  // 否则书架还拿上一台的库 id 去请求新服务器（表现为切过去一片空白 —— 实测踩到）。
  wireSourceSwitch(root, {
    go,
    rerender: async () => {
      await resetForSourceSwitch()
      await renderShelf(root)
    },
  })

  // 收藏入口（首页直达）
  root.querySelector('#favEntryCard')?.addEventListener('click', () => { haptic.tap(); go('favorites') })
  root.querySelector('#historyEntryCard')?.addEventListener('click', () => { haptic.tap(); go('history') })

  // 无封面的书用占位封面兜底
  wireCoverFallback(root)

  // 语音
  root.querySelectorAll('[data-voice]').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation()
      openVoiceOverlay({ onSearch: (q) => go('search', { q }) })
    })
  })

  // 点击书籍
  root.querySelectorAll('[data-id]').forEach(el => {
    el.addEventListener('click', async () => {
      if (el._longPressed) { el._longPressed = false; return }   // 长按已处理，别再当点击
      haptic.tap()
      const id = el.dataset.id
      const it = state.items.find(x => x.id === id) || inProgress.find(x => x.id === id)
      if (!it) return
      // 有进度就接着听（卡片上有"听 N%"徽标，从头播会丢进度）。
      //  阈值不能是 >5 秒：孩子的书单集很短、随手点开就退出，
      // 听 2~5 秒也是真实进度，归零会"重听一遍"（老板 2026-09-13）。
      // ND 专辑：进详情页自己选歌（老板 2026-09-14「点进专辑，我自己选个单曲播放」）
      // ABS 书：保持原有行为（有进度续听）
      const prog = progressMap[it.id]
      const resumeAt = (prog && !prog.isFinished) ? undefined : 0
      await openOrPlay(it, { resumeAt })
    })
  })

  updateMini()
}

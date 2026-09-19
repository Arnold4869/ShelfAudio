/**
 * 演唱者可点助手（老板 2026-09-19：所有出现演唱者的地方都可以点进歌手页）
 *
 * 用法（在视图渲染完之后调用一次）：
 *   wireArtistLinks(root)
 *
 * 约定：任何需要「歌手名可点」的元素，加上
 *   data-artist-id="nd:art123"  （hub.getArtist 能直接用的 id，带前缀）
 *   可选 data-artist-name="歌手名"（无障碍用）
 * helper 会给它绑 click → go('artist', { id })，并保证 ≥44px 触摸目标。
 *
 * 为什么用事件委托而不是逐个绑：
 *  - 视图列表都是 innerHTML 一次渲染，逐个绑容易漏（歌单详情/搜索/歌手页三处吃过亏）；
 *  - 点行 = 播放、点歌手名 = 进歌手页，两个 handler 都挂在行内不同元素上，
 *    委托里 stopPropagation 保证只触发其中一个。
 */
import { hub } from './servers.js'
import { go } from '../app.js'
import { haptic } from './haptics.js'

export function wireArtistLinks(root) {
  if (!root) return
  // 幂等：同一个容器只挂一次（app.js 的 go() 每次切页都会调一遍，而 #view 元素
  // 本身是复用的，重复 addEventListener 会让一次点击触发 N 次跳转）。
  if (root._saArtistWired) return
  root._saArtistWired = true
  // ⚠️ 必须用**捕获阶段**：列表行自己的 onclick（点行=播放/进专辑）挂在行元素上，
  // 冒泡阶段先后顺序是行 → root，委托挂在 root 上会来不及拦，结果点歌手名
  // 会同时触发「进歌手页」和「播放这首歌」。捕获阶段从 root 往下走，先到先拦。
  root.addEventListener('click', e => {
    const el = e.target.closest('[data-artist-id]')
    if (!el) return
    const id = el.dataset.artistId
    if (!id) return
    e.preventDefault()
    e.stopPropagation()
    haptic.tap()
    go('artist', { id })
  }, true)
}

/** 歌手名 HTML（可点 span）。无 artistId 时退化为纯文本（不可点、无死链）。 */
export function artistLink(name, artistId) {
  const n = String(name || '').trim()
  if (!n) return ''
  const id = normArtistId(artistId)
  return id
    ? `<span class="artist-link" data-artist-id="${escAttr(id)}" data-artist-name="${escAttr(n)}">${escAttr(n)}</span>`
    : `<span class="artist-name">${escAttr(n)}</span>`
}

/**
 * 从条目取「歌手 id」—— 各视图共用一个入口，避免到处写前缀判断。
 * 数据来源：ND 的 media.metadata.artistId（_albumToItem 里已塞）或 _nd.artistId。
 * ABS 条目没有该字段 → 返回空串 → 渲染成不可点纯文本（ABS 侧零行为变化）。
 */
export function artistIdOf(item) {
  const raw = item?._nd?.artistId
    || item?.media?.metadata?.artistId
    || (item?.media?.chapters || []).find(c => c?._nd?.artistId)?._nd?.artistId
    || ''
  return normArtistId(raw)
}

/** 统一成 `nd:<nid>` 形式（hub.getArtist 认 nd: / ndart: 两种前缀） */
export function normArtistId(v) {
  const s = String(v || '').trim()
  if (!s) return ''
  const n = s.replace(/^(ndart:|nd:)/, '')
  return n ? 'nd:' + n : ''
}

function escAttr(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
}

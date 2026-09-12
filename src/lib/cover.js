/**
 * 无封面书籍的占位封面
 *
 * 背景：ABS 库里有些书没刮削到封面（`media.coverPath` 为 null），
 * 这时 /api/items/{id}/cover 返回 404，页面上就露出一个破图或一个孤零零的 emoji —— 很难看。
 *
 * 做法：用书名的哈希挑一套固定配色，画一张「像真书封面」的占位图：
 *   纯 CSS（无网络请求、无外部图片），左侧书脊竖条 + 居中书名 + 底部作者，
 *   文字用衬线感排版。配色偏深饱和 + 米白字，接近实体书封面而不是网页卡片。
 *
 * 同一个书名永远得到同一张封面（哈希决定），不会每次刷新都变色。
 */

/** 8 套书封配色：深底 + 米白/浅色字（避开纯黑、荧光色、SaaS 灰） */
const PALETTES = [
  { bg: ['#3B4E8C', '#243057'], ink: '#F2EEE4', accent: '#C9A24B' }, // 靛蓝 + 旧金
  { bg: ['#7A3B45', '#4A1F28'], ink: '#F6EFE6', accent: '#D8A25E' }, // 酒红 + 琥珀
  { bg: ['#2F5D50', '#1B3A32'], ink: '#EEF3EC', accent: '#C4A46A' }, // 墨绿 + 黄铜
  { bg: ['#4A3A78', '#2A1F48'], ink: '#F1EDF8', accent: '#BFA6E0' }, // 紫罗兰
  { bg: ['#8A5A2B', '#543415'], ink: '#FAF3E6', accent: '#E7C486' }, // 焦糖棕
  { bg: ['#2C4A6B', '#16293E'], ink: '#EAF1F7', accent: '#8FB8D8' }, // 深青蓝
  { bg: ['#6B3556', '#3D1B30'], ink: '#F7EDF3', accent: '#D79BC0' }, // 紫红
  { bg: ['#44543A', '#252F1F'], ink: '#F0F3EA', accent: '#AFC088' }, // 橄榄绿
]

/** 稳定的字符串哈希（djb2），同名恒定 */
function hash(s) {
  let h = 5381
  const str = String(s || '')
  for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) | 0
  return Math.abs(h)
}

export function coverPalette(seed) {
  return PALETTES[hash(seed) % PALETTES.length]
}

/**
 * 占位封面尺寸表：容器实际尺寸（px，按 390pt 手机估）与留白比例。
 * 用它们把字号算成 cqi（容器宽度的百分比）——cqi 与容器同比例缩放，
 * 所以一套公式在 58px 缩略图和 290px 大图上都成立。
 */
const SIZES = {
  // cls 片段 -> { w, h } 容器尺寸
  list: { w: 58, h: 58 },
  continue: { w: 200, h: 120 },
  player: { w: 281, h: 281 },
  card: { w: 171, h: 171 },
}

/**
 * 生成占位封面 HTML
 * @param {object} opts
 *   title   书名（必填，用于配色与文字）
 *   author  作者/演播
 *   cls     额外 class（用于适配不同尺寸：书卡 / 继续听 / 列表 / 播放页）
 */
export function fallbackCover({ title = '', author = '', cls = '' } = {}) {
  const p = coverPalette(title)
  let name = String(title).trim() || '未命名'
  const isTiny = cls.includes('list')      // 列表里只有 58px，全标题必然糊
  if (isTiny) {
    // 只留前 6 个字（小尺寸下勉强可辨），并去掉结尾的孤立标点/括号
    name = [...name].slice(0, 6).join('').replace(/[\s·・:：,，。.、\[\]【】()（）\-—_]+$/g, '') || name.slice(0, 6)
  }

  const chars = [...name].length
  // 行数：短名 1 行、中等 2 行、长名 3 行
  const lines = chars <= 4 ? 1 : chars <= 8 ? 2 : 3
  const perLine = Math.max(1, Math.ceil(chars / lines))
  // 空格会被当作换行点，所以每个空格分隔的片段必须能单独放进一行 ——
  // 否则会出现「太空历险记」这种整段放不下、横向溢出 5px 的情况。
  const tokens = name.split(/\s+/).filter(Boolean)
  const longestRun = Math.max(perLine, ...tokens.map(t => [...t].length))
  // 容器尺寸（按 cls 选），换算成 cqi 后与实际像素无关，可跨尺寸复用
  const box = cls.includes('list') ? SIZES.list
            : cls.includes('continue') ? SIZES.continue
            : cls.includes('player') ? SIZES.player
            : SIZES.card
  // 横向约束：每行字数 × 字号 ≤ 可用宽度（留出 padding 与书脊）
  // 纵向约束：行数 × 行高 × 字号 ≤ 可用高度
  const WIDTH_SAFE = 66, HEIGHT_SAFE = 56, LINE_H = 1.25
  const byWidth = WIDTH_SAFE / longestRun
  const byHeight = (HEIGHT_SAFE / (lines * LINE_H)) * (box.h / box.w)
  const fsCqi = Math.max(7, Math.min(34, Math.min(byWidth, byHeight)))

  const sub = String(author || '').trim().slice(0, 12)

  return `<div class="cover-ph ${cls}" aria-hidden="true"
    style="--ph-a:${p.bg[0]};--ph-b:${p.bg[1]};--ph-ink:${p.ink};--ph-accent:${p.accent};--ph-fs:${fsCqi.toFixed(2)}cqi">
    <span class="cover-ph-spine"></span>
    <span class="cover-ph-rule"></span>
    <span class="cover-ph-title">${escapeHTML(name)}</span>
    ${sub ? `<span class="cover-ph-sub">${escapeHTML(sub)}</span>` : ''}
  </div>`
}

function escapeHTML(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
}

/** 在容器上挂 onerror 兜底：真封面挂了就显示占位图 */
export function wireCoverFallback(container) {
  if (!container) return
  container.querySelectorAll('img[data-cover]').forEach(img => {
    const swap = () => {
      const ph = img.parentElement?.querySelector('.cover-ph')
      if (ph) { img.style.display = 'none'; ph.style.display = 'flex' }
      else img.style.visibility = 'hidden'
    }
    if (img.complete && img.naturalWidth === 0) swap()
    img.addEventListener('error', swap, { once: true })
  })
}

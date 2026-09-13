/**
 * 自绘 SVG 图标库
 *
 * 为什么不用 emoji：⏮ ▶ ⏭ ⚙️ 📚 🔍 🎤 这些字符在不同系统上由各自的 emoji 字体渲染，
 * iOS 会画成彩色 3D 立体小图，Android 又是另一套，风格跟界面完全不搭（上一版就是这个毛病）。
 * 自绘 SVG 用 currentColor，颜色/大小全部由 CSS 控制，任何平台都长一样。
 *
 * 用法：icon('play', 20)  →  一段 <svg> 字符串，直接插进模板。
 *       CSS 里用 color 控制颜色（SVG 用 currentColor）。
 */

// 齿轮轮廓：用代码算，保证齿形规整（手写路径很容易歪）
function cogPath(rOut = 9.5, rIn = 7.3, teeth = 8, cx = 12, cy = 12) {
  const step = (Math.PI * 2) / teeth
  const th = step * 0.23   // 齿顶半宽
  const gap = step * 0.07  // 齿顶到齿谷的过渡
  const pt = (r, a) => [cx + r * Math.cos(a), cy + r * Math.sin(a)]
  const f = ([x, y]) => `${x.toFixed(2)} ${y.toFixed(2)}`
  const pts = []
  for (let i = 0; i < teeth; i++) {
    const c = i * step - Math.PI / 2
    pts.push(pt(rOut, c - th), pt(rOut, c + th), pt(rIn, c + th + gap), pt(rIn, c + step - th - gap))
  }
  return 'M' + pts.map(f).join(' L') + ' Z'
}

// 24×24 画布。线宽统一 1.9，圆角端点，视觉重量一致。
const BODY = {
  // ---- 播放控制 ----
  play: '<path d="M8.2 5.3a1 1 0 0 1 1.53-.85l9.2 5.9a1 1 0 0 1 0 1.7l-9.2 5.9a1 1 0 0 1-1.53-.85z" fill="currentColor"/>',
  pause: '<rect x="7.2" y="5" width="3.4" height="14" rx="1.5" fill="currentColor"/><rect x="13.4" y="5" width="3.4" height="14" rx="1.5" fill="currentColor"/>',
  // 上一集：竖条 + 左三角（标准"跳到上一首"）
  prev: '<rect x="5" y="6" width="2.2" height="12" rx="1.1" fill="currentColor"/><path d="M19 6.9v10.2a1 1 0 0 1-1.54.84l-8-5.1a1 1 0 0 1 0-1.68l8-5.1A1 1 0 0 1 19 6.9z" fill="currentColor"/>',
  next: '<rect x="16.8" y="6" width="2.2" height="12" rx="1.1" fill="currentColor"/><path d="M5 6.9v10.2a1 1 0 0 0 1.54.84l8-5.1a1 1 0 0 0 0-1.68l-8-5.1A1 1 0 0 0 5 6.9z" fill="currentColor"/>',
  // 15 秒前后：开口圆弧 + 箭头（数字由 HTML 另外渲染在下方）
  back15: '<path d="M12 6.2a5.9 5.9 0 1 1-5.6 4" fill="none"/><path d="M12 3.2 8.9 6.2 12 9.2" fill="none"/>',
  forward15: '<path d="M12 6.2a5.9 5.9 0 1 0 5.6 4" fill="none"/><path d="M12 3.2 15.1 6.2 12 9.2" fill="none"/>',

  // ---- 导航 ----
  books: '<path d="M4.4 5.2h4.2a2 2 0 0 1 2 2v12a1.6 1.6 0 0 0-1.6-1.6H4.4z" fill="none"/><path d="M19.6 5.2h-4.2a2 2 0 0 0-2 2v12a1.6 1.6 0 0 1 1.6-1.6h4.6z" fill="none"/>',
  search: '<circle cx="10.8" cy="10.8" r="6.2" fill="none"/><path d="m15.4 15.4 4 4" fill="none"/>',
  cog: `<path fill-rule="evenodd" d="${cogPath()} M12 14.6a2.6 2.6 0 1 0 0-5.2 2.6 2.6 0 0 0 0 5.2z" fill="currentColor"/>`,
  back: '<path d="M14.6 5.6 8.2 12l6.4 6.4" fill="none"/>',
  forward: '<path d="M9.4 5.6 15.8 12l-6.4 6.4" fill="none"/>',
  more: '<circle cx="5.6" cy="12" r="1.7" fill="currentColor"/><circle cx="12" cy="12" r="1.7" fill="currentColor"/><circle cx="18.4" cy="12" r="1.7" fill="currentColor"/>',

  // ---- 功能 ----
  mic: '<rect x="9.2" y="2.8" width="5.6" height="11" rx="2.8" fill="none"/><path d="M5.6 11.4a6.4 6.4 0 0 0 12.8 0" fill="none"/><path d="M12 17.8V21" fill="none"/>',
  headphones: '<path d="M4.2 14.4v-2.6a7.8 7.8 0 0 1 15.6 0v2.6" fill="none"/><rect x="2.8" y="13.4" width="4.4" height="7.4" rx="2.2" fill="none"/><rect x="16.8" y="13.4" width="4.4" height="7.4" rx="2.2" fill="none"/>',
  timer: '<circle cx="12" cy="13.6" r="7.4" fill="none"/><path d="M12 9.6v4" fill="none"/><path d="M12 13.6h2.9" fill="none"/><path d="M9.6 3.2h4.8" fill="none"/>',
  list: '<path d="M8.6 6.6h11" fill="none"/><path d="M8.6 12h11" fill="none"/><path d="M8.6 17.4h11" fill="none"/><circle cx="4.8" cy="6.6" r="1.5" fill="currentColor"/><circle cx="4.8" cy="12" r="1.5" fill="currentColor"/><circle cx="4.8" cy="17.4" r="1.5" fill="currentColor"/>',
  heart: '<path d="M12 20.6 4.75 13.35a4.6 4.6 0 0 1 6.5-6.5l.75.75.75-.75a4.6 4.6 0 0 1 6.5 6.5z" fill="none"/>',
  info: '<circle cx="12" cy="12" r="8.6" fill="none"/><path d="M12 11v5.4" fill="none"/><circle cx="12" cy="7.9" r="1.15" fill="currentColor"/>',
  check: '<path d="m5.4 12.6 4.4 4.4 8.8-9.6" fill="none"/>',
  lock: '<rect x="4.8" y="10.4" width="14.4" height="10" rx="3" fill="none"/><path d="M8.2 10.4V7.8a3.8 3.8 0 0 1 7.6 0v2.6" fill="none"/>',
  person: '<circle cx="12" cy="8" r="3.8" fill="none"/><path d="M4.8 20.2a7.2 7.2 0 0 1 14.4 0" fill="none"/>',
  child: '<circle cx="12" cy="7.4" r="3.6" fill="none"/><path d="M5.6 20.4a6.4 6.4 0 0 1 12.8 0" fill="none"/><path d="M9.4 4.2 8 2.4M14.6 4.2 16 2.4" fill="none"/>',
  server: '<rect x="3.4" y="4.4" width="17.2" height="6.4" rx="2" fill="none"/><rect x="3.4" y="13.2" width="17.2" height="6.4" rx="2" fill="none"/><circle cx="7.2" cy="7.6" r="1.1" fill="currentColor"/><circle cx="7.2" cy="16.4" r="1.1" fill="currentColor"/>',
  refresh: '<path d="M20 12a8 8 0 1 1-2.4-5.7" fill="none"/><path d="M20.2 4v4.4h-4.4" fill="none"/>',
  exit: '<path d="M14.6 4.6H6.2a1.8 1.8 0 0 0-1.8 1.8v11.2a1.8 1.8 0 0 0 1.8 1.8h8.4" fill="none"/><path d="M15.4 8.4 19 12l-3.6 3.6" fill="none"/><path d="M19 12H9.6" fill="none"/>',
  warning: '<path d="M12 3.8 21 19.4H3z" fill="none"/><path d="M12 9.7v4.3" fill="none" stroke-width="2.5"/><circle cx="12" cy="16.7" r="1.15" fill="currentColor" stroke="none"/>',
  sparkle: '<path d="M12 3.4 13.9 9l5.6 1.9-5.6 1.9L12 18.4 10.1 12.8 4.5 10.9 10.1 9z" fill="currentColor"/>',
  loader: '<circle cx="12" cy="12" r="8.4" fill="none" stroke-width="2.4" stroke-dasharray="44 8.8"/>',
  empty: '<path d="M3.8 9.3 5.7 4.9h12.6l1.9 4.4" fill="none"/><path d="M3.8 9.3h4.5l1.2 2.5h5l1.2-2.5h4.5" fill="none"/><path d="M4.9 9.3v8.3a1.8 1.8 0 0 0 1.8 1.8h10.6a1.8 1.8 0 0 0 1.8-1.8V9.3" fill="none"/>',

  // ---- 收藏 / 管理 / 统计 / 缓存 ----
  bookmark: '<path d="M6.6 3.8h10.8a1 1 0 0 1 1 1v15.4l-6.4-4-6.4 4V4.8a1 1 0 0 1 1-1z" fill="none"/>',
  trash: '<path d="M4.6 7.2h14.8" fill="none"/><path d="M9.4 7.2V5.4a1.2 1.2 0 0 1 1.2-1.2h2.8a1.2 1.2 0 0 1 1.2 1.2v1.8" fill="none"/><path d="M6.6 7.2l.9 12a1.6 1.6 0 0 0 1.6 1.5h5.8a1.6 1.6 0 0 0 1.6-1.5l.9-12" fill="none"/><path d="M10.4 10.8v6.2M13.6 10.8v6.2" fill="none"/>',
  chart: '<path d="M4 20.2h16" fill="none"/><rect x="5.6" y="12" width="3.4" height="6.6" rx="1.2" fill="none"/><rect x="10.3" y="7.2" width="3.4" height="11.4" rx="1.2" fill="none"/><rect x="15" y="10" width="3.4" height="8.6" rx="1.2" fill="none"/>',
  bell: '<path d="M18.4 15.6V10a6.4 6.4 0 1 0-12.8 0v5.6l-1.8 2.6h16.4z" fill="none"/><path d="M10 20.6a2.2 2.2 0 0 0 4 0" fill="none"/>',
  clock: '<circle cx="12" cy="12" r="8.6" fill="none"/><path d="M12 7.2V12l3.4 2.2" fill="none"/>',
  download: '<path d="M12 3.8v11.4" fill="none"/><path d="m7.6 11 4.4 4.4 4.4-4.4" fill="none"/><path d="M4.6 18.6a1.6 1.6 0 0 0 1.6 1.6h11.6a1.6 1.6 0 0 0 1.6-1.6" fill="none"/>',
}

// 线描类（fill:none + stroke）；其余为实心填充类
const STROKE = new Set([
  'back15', 'forward15', 'books', 'search', 'back', 'forward', 'mic', 'headphones',
  'timer', 'list', 'heart', 'info', 'check', 'lock', 'person', 'child', 'server',
  'refresh', 'exit', 'warning', 'loader', 'empty',
  'bookmark', 'trash', 'chart', 'download', 'bell', 'clock',
])

/**
 * 取图标 SVG
 * @param {string} name  BODY 里的键
 * @param {number} size  像素尺寸（宽高相同）
 * @param {string} cls   额外 class
 */
export function icon(name, size = 22, cls = '') {
  const body = BODY[name]
  if (!body) return ''
  const attrs = STROKE.has(name)
    ? ' fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"'
    : ''
  return `<svg class="ic-svg ${cls}" width="${size}" height="${size}" viewBox="0 0 24 24" aria-hidden="true" focusable="false"${attrs}>${body}</svg>`
}

export const ICON_NAMES = Object.keys(BODY)

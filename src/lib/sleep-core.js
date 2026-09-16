/**
 * 睡眠定时的纯逻辑（无 DOM、无 store、无插件依赖 —— 便于 node 单测）
 *
 * 老板 2026-09-16 要求：
 *  ① 定时入口只留播放页一个（⋯ 菜单里的睡眠入口删掉）
 *  ② 定时按钮本身就是倒计时
 *  ③ 除了时间定时，还要能「按章节/按歌曲」定时：听 N 集/首后自动关闭；
 *     按章节那种，按钮上的倒计时 = 这几集/首的总时长
 *
 * 两种模式的状态都由 lib/sleep.js 持有，这里只做纯计算：
 *   time   模式：deadline（ms 时间戳）→ 真实时钟倒计时
 *   tracks 模式：还需播完 N 集/首（含当前正在播的这一集）→ 播放时长倒计时
 */

/**
 * 倒计时文案：`9:05` / `1:02:30`
 * 不用 fmtTime（那个是「当前播放位置」，语义不同，分开更好维护）
 */
export function formatCountdown(sec) {
  const s0 = Math.max(0, Math.round(Number(sec) || 0))
  const h = Math.floor(s0 / 3600)
  const m = Math.floor((s0 % 3600) / 60)
  const s = s0 % 60
  const p = n => String(n).padStart(2, '0')
  return h > 0 ? `${h}:${p(m)}:${p(s)}` : `${m}:${p(s)}`
}

/**
 * tracks 模式还剩多少秒。
 *
 * 口径：**当前这一集听到结尾的剩余时间** + 之后 (remain-1) 首的完整时长。
 * 也就是说 remain=3 表示「当前这首 + 再听 2 首」——即总共听完 3 首后停。
 *
 * 为什么用「算位置」而不是「累加播放秒数」：
 * 暂停时倒计时自然停住（用户直觉），拖动/切集后立刻重算，不会越走越偏。
 *
 * @param {object} player 播放器（取 trackIndex / tracks / position()）
 * @param {number} remain 还需播完的集数（含当前集）
 * @returns {number} 剩余秒数
 */
export function tracksCountdown(player, remain) {
  const n = Math.floor(Number(remain) || 0)
  if (!player || n <= 0) return 0
  const tracks = player.tracks || []
  const i = Math.max(0, Math.min(player.trackIndex || 0, Math.max(0, tracks.length - 1)))
  const cur = tracks[i] || {}
  const off = cur.startOffset || 0
  const pos = Number(player.position?.()?.currentTime)
  const played = Number.isFinite(pos) ? Math.max(0, pos - off) : 0
  let total = Math.max(0, (cur.duration || 0) - played)
  // 之后的 (remain - 1) 首按完整时长计入。队列不够长（听到最后一张专辑）就只算有的
  for (let k = 1; k < n; k++) {
    const t = tracks[i + k]
    if (!t) break
    total += t.duration || 0
  }
  return total
}

/**
 * 一集/一首播完后的推进（老板 2026-09-16）。
 * @param {number} remain 当前还剩几集
 * @returns {{remain:number, done:boolean}} done=true 表示该暂停了
 */
export function afterTrackComplete(remain) {
  const left = Math.max(0, Math.floor(Number(remain) || 0) - 1)
  return { remain: left, done: left === 0 }
}

/**
 * 校验「自定义分钟」输入：整数、1~1440（24 小时）。
 * 超上限**拒绝**（返回 0 + 调用方提示），不静默截断 —— 静默改值会让用户
 * 以为设成了 99999 分钟，实际只生效 1440（2026-09-16 测试抓出的坑）。
 * @returns {number} 合法值；0 表示非法（含空/非数字/越界）
 */
export function normalizeMinutes(n) {
  const v = Math.floor(Number(n) || 0)
  if (!Number.isFinite(v) || v < 1 || v > 1440) return 0
  return v
}

/**
 * 校验「按章节/按歌曲定时」的输入：整数、1~99。
 * 同上：越界拒绝，不截断。
 */
export function normalizeTrackCount(n) {
  const v = Math.floor(Number(n) || 0)
  if (!Number.isFinite(v) || v < 1 || v > 99) return 0
  return v
}

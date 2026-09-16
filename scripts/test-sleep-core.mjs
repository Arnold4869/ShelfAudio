#!/usr/bin/env node
/**
 * sleep-core 纯逻辑单测（老板 2026-09-16 新增功能）
 *
 * 覆盖：
 *   - formatCountdown：分秒 / 时分秒 / 负数与脏值兜底
 *   - tracksCountdown：当前集剩余 + 之后 N-1 首完整时长；暂停态不涨；队列不够长；
 *     remain=1 就是"这一首放完停"
 *   - afterTrackComplete：递减 + 到 0 判 done
 *   - normalizeMinutes / normalizeTrackCount：边界与非法输入
 *
 * 这些都是"按章节定时"的核心算法（错了就是多听几集/少听几集），必须有单测兜住。
 * 直接 import 真源码，不复制逻辑。
 */
import { formatCountdown, tracksCountdown, afterTrackComplete, normalizeMinutes, normalizeTrackCount }
  from '../src/lib/sleep-core.js'

let pass = 0, fail = 0
function ok(name, cond, extra = '') {
  if (cond) { pass++; console.log('  ✅ ' + name) }
  else { fail++; console.log('  ❌ ' + name + (extra ? '  [' + extra + ']' : '')) }
}
function eq(name, got, want) { ok(name, got === want, `got=${JSON.stringify(got)} want=${JSON.stringify(want)}`) }

// 假播放器：3 集，每集 100 秒，startOffset 0/100/200
function mkPlayer(trackIndex, bookTime, tracks) {
  const ts = tracks || [
    { startOffset: 0, duration: 100 },
    { startOffset: 100, duration: 100 },
    { startOffset: 200, duration: 100 },
  ]
  return { trackIndex, tracks: ts, position: () => ({ currentTime: bookTime }) }
}

console.log('=== 1. formatCountdown ===')
eq('0 秒', formatCountdown(0), '0:00')
eq('59 秒', formatCountdown(59), '0:59')
eq('60 秒', formatCountdown(60), '1:00')
eq('9 分 5 秒', formatCountdown(545), '9:05')
eq('59:59', formatCountdown(3599), '59:59')
eq('1 小时', formatCountdown(3600), '1:00:00')
eq('1 小时 2 分 30 秒', formatCountdown(3750), '1:02:30')
eq('负数兜底为 0', formatCountdown(-5), '0:00')
eq('脏值 NaN 兜底', formatCountdown('abc'), '0:00')
eq('小数四舍五入', formatCountdown(59.6), '1:00')

console.log('=== 2. tracksCountdown（按章节定时的核心口径）===')
// 第 0 集播到第 10 秒，剩 90；remain=1 → 只算这一集
eq('remain=1（这一集放完停）', tracksCountdown(mkPlayer(0, 10), 1), 90)
// remain=3 → 90 + 第二集 100 + 第三集 100 = 290
eq('remain=3（本集剩余+后两集整曲）', tracksCountdown(mkPlayer(0, 10), 3), 290)
// 第 1 集播到 150（集内 50 秒，剩 50）+ 第三集 100 = 150
eq('第 2 集播到中途', tracksCountdown(mkPlayer(1, 150), 2), 150)
// 第 2 集（最后一集）播到 250，remain=3 但后面没有集了 → 只剩 50
eq('队列不够长只算存在的', tracksCountdown(mkPlayer(2, 250), 3), 50)
// remain=0 / 负数 → 0
eq('remain=0 → 0', tracksCountdown(mkPlayer(0, 10), 0), 0)
eq('null player → 0', tracksCountdown(null, 3), 0)
// 位置非法（NaN/越界）不能算出负倒计时
eq('位置 NaN 兜底为整曲', tracksCountdown({ trackIndex: 0, tracks: [{ startOffset: 0, duration: 100 }], position: () => ({ currentTime: NaN }) }, 1), 100)
eq('位置超过集尾 → 不为负', tracksCountdown(mkPlayer(0, 999), 1), 0)
// 暂停态：位置不变 → 倒计时不变（不自行流逝）
const p = mkPlayer(1, 120)
eq('暂停态倒计时不变（第 1 次）', tracksCountdown(p, 1), 80)
eq('暂停态倒计时不变（第 2 次）', tracksCountdown(p, 1), 80)

console.log('=== 3. afterTrackComplete ===')
ok('3 → 2 未到点', JSON.stringify(afterTrackComplete(3)) === JSON.stringify({ remain: 2, done: false }))
ok('1 → 0 到点', JSON.stringify(afterTrackComplete(1)) === JSON.stringify({ remain: 0, done: true }))
ok('0 不会再变负', afterTrackComplete(0).remain === 0)
ok('脏值兜底', afterTrackComplete(undefined).remain === 0)

console.log('=== 4. normalizeMinutes ===')
eq('1 分钟合法', normalizeMinutes(1), 1)
eq('30 分钟合法', normalizeMinutes(30), 30)
eq('1440 上限合法', normalizeMinutes(1440), 1440)
eq('超上限拒绝（不静默截断）', normalizeMinutes(99999), 0)
eq('0 非法', normalizeMinutes(0), 0)
eq('负数非法', normalizeMinutes(-5), 0)
eq('空串非法', normalizeMinutes(''), 0)
eq('非数字非法', normalizeMinutes('abc'), 0)
eq('小数取整', normalizeMinutes('12.9'), 12)
eq('字符串数字合法', normalizeMinutes('45'), 45)

console.log('=== 5. normalizeTrackCount ===')
eq('1 首合法', normalizeTrackCount(1), 1)
eq('10 首合法', normalizeTrackCount(10), 10)
eq('99 上限合法', normalizeTrackCount(99), 99)
eq('超上限拒绝（不静默截断）', normalizeTrackCount(1000), 0)
eq('0 非法', normalizeTrackCount(0), 0)
eq('负数非法', normalizeTrackCount(-1), 0)
eq('空串非法', normalizeTrackCount(''), 0)
eq('字符串数字合法', normalizeTrackCount('5'), 5)

console.log()
if (fail) { console.log(`❌ ${fail} 项失败 / ${pass + fail}`); process.exit(1) }
console.log(`✅ 全部通过（${pass} 项）`)

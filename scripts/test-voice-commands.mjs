/**
 * 语音指令解析回归（纯逻辑，无依赖）。
 * 重点覆盖 2026-09-15 审计发现的 bug：说「关闭定时/取消定时/定时关闭」
 * 曾掉进搜索分支（去搜"关闭定时"），语音无法关闭睡眠定时。
 */
import { parseCommand } from '../src/lib/voice.js'

let pass = 0, fails = []
function ok(name, cond, extra = '') {
  if (cond) { pass++ } else { fails.push(name + (extra ? `  [${extra}]` : '')) }
}

// ---- 睡眠定时：设定 ----
const setCases = [
  ['三十分钟后关闭', 30], ['十五分钟后停止', 15], ['定时30分钟', 30],
  ['定时30分钟', 30], ['三分钟后暂停', 3], ['半小时后关', 30], ['一小时后关', 60],
  ['睡后二十分钟', 20],
]
for (const [text, min] of setCases) {
  const r = parseCommand(text)
  ok(`"${text}" → sleep ${min}分钟`, r.intent === 'sleep' && r.minutes === min, JSON.stringify(r))
}

// ---- 睡眠定时：关闭（2026-09-15 修复的 bug）----
const offCases = ['关闭定时', '关掉定时', '取消定时', '定时关闭', '关闭睡眠',
  '停止定时', '关闭倒计时', '解除定时', '不要定时']
for (const text of offCases) {
  const r = parseCommand(text)
  ok(`"${text}" → sleep 0（关闭）`, r.intent === 'sleep' && r.minutes === 0, JSON.stringify(r))
}

// ---- 不误伤：含"关"字但与定时无关的话仍走搜索 ----
const negCases = ['我要听示例故事甲', '关闭后台', '关掉什么', '找一下关闭门的小说',
  '大点声', '暂停', '下一集', '打开设置', '示例科普']
for (const text of negCases) {
  const r = parseCommand(text)
  ok(`"${text}" 不误判为 sleep`, r.intent !== 'sleep', JSON.stringify(r))
}

// ---- 其它既有指令不回归 ----
const misc = [
  ['暂停', 'pause'], ['停一下', 'pause'], ['下一集', 'next'], ['跳过', 'next'],
  ['上一集', 'prev'], ['继续播放', 'play'], ['大声点', 'louder'], ['小声一点', 'quieter'],
]
for (const [text, intent] of misc) {
  const r = parseCommand(text)
  ok(`"${text}" → ${intent}`, r.intent === intent, JSON.stringify(r))
}
const rt = parseCommand('一点五倍')
ok('"一点五倍" → rate 1.5', rt.intent === 'rate' && rt.rate === 1.5, JSON.stringify(rt))
const q = parseCommand('我要听示例故事甲')
ok('搜索词剥离动词', q.intent === 'search' && q.query === '示例故事甲', JSON.stringify(q))

console.log(`语音指令解析：${pass} 通过 / ${fails.length} 失败`)
if (fails.length) { console.log(fails.map(f => '  ❌ ' + f).join('\n')); process.exit(1) }
console.log('✅ 全部通过')

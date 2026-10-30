#!/usr/bin/env node
/**
 * 视图历史栈回归（P1 §3.2，2026-10-12 审计修）
 *
 * 核心契约（审计建议原文）：goBack 的「原地重渲染」用 replace + keep 语义 ——
 * 「忽略传入 params，用栈顶已存 params」，只更新 name 不动 params。
 * 修复前（HEAD 207705e）replace 分支是合并语义 {...top.params, ...params}，
 * goBack 把上一页自己的渲染入参再洗一遍栈内参数 —— 本测试的 keep 断言
 * 在旧代码上会失败（回归可证伪）。
 *
 * 覆盖：
 *  1. keep：无论传入什么 params（含会洗掉旧键的 undefined 值），栈顶参数不动
 *  2. goBack 完整序列：album → player → 返回，album 栈内参数原样保留
 *  3. album 一次性参数 songId 在返回时被剥离（不二次起播）
 *  4. 普通 replace 仍是合并（0.14.0 深链参数修复不回退）
 *  5. 页签清空历史；同页换参不灌历史；快照/回滚
 *
 * 直接 import 真源码（src/lib/view-stack.js），不复制逻辑。
 * 用法: node scripts/test-view-stack.mjs
 */
import {
  rememberView, popForBack, snapshotViewStack, restoreViewStack, topView,
  currentView, viewHistory, resetViewStack,
} from '../src/lib/view-stack.js'

let pass = 0, fail = 0
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ✅ ${name}`) }
  else { fail++; console.log(`  ❌ ${name}${extra ? ' — ' + extra : ''}`) }
}
const eq = (name, got, want) => ok(name, JSON.stringify(got) === JSON.stringify(want), `got=${JSON.stringify(got)} want=${JSON.stringify(want)}`)

/** 模拟 goBack 的导航半程（go() 里 rememberView 那一步），可注入「渲染入参」 */
function goLike(name, params, opts = {}) { rememberView(name, params, opts) }

console.log('\n=== 1. keep 契约：栈顶参数不被传入 params 洗掉（可证伪核心）===')
{
  resetViewStack()
  rememberView('kidhome', {})
  rememberView('stats', { day: '2026-10-01', cal: 1 })
  // goBack 重渲染 stats 时传「另一个 day + cal:undefined」——
  // 旧代码（合并语义）会得到 {day:'1999-01-01', cal:undefined}（cal 被洗掉）；
  // keep 必须原样保留 {day:'2026-10-01', cal:1}。
  rememberView('stats', { day: '1999-01-01', cal: undefined }, { replace: true, keep: true })
  eq('keep：day 不被传入值洗掉', topView().params, { day: '2026-10-01', cal: 1 })
  // 传全新的外来键也一样：栈顶参数纹丝不动
  rememberView('stats', { foo: 'bar' }, { replace: true, keep: true })
  ok('keep：外来键不写入', topView().params?.foo === undefined, JSON.stringify(topView().params))
  ok('keep：name 仍更新', topView().name === 'stats', topView().name)
  // 空栈时 keep 退化为普通落栈
  resetViewStack()
  rememberView('stats', { day: 'x' }, { replace: true, keep: true })
  eq('keep：空栈时落一条', topView(), { name: 'stats', params: { day: 'x' } })
}

console.log('\n=== 2. goBack 完整序列：带参页返回后栈内参数原样 ===')
{
  resetViewStack()
  rememberView('kidhome', {})
  rememberView('album', { id: 'nd:alb1' })
  rememberView('player', {})
  // 返回：pop player → prev=album → go(prev.name, prev.params, {replace,keep})
  const prev = popForBack()
  goLike(prev.name, prev.params, { replace: true, keep: true })
  eq('返回后栈顶是 album', topView(), { name: 'album', params: { id: 'nd:alb1' } })
  eq('历史栈少了一层', viewHistory(), ['kidhome', 'album'])
  // stats 场景（审计复现路径）：带 day/cal 的统计页 → 返回 → 重渲染
  resetViewStack()
  rememberView('settings', {})
  rememberView('parents', {})
  rememberView('stats', { day: '2026-10-01', cal: 1 })
  const p2 = popForBack()
  goLike(p2.name, p2.params, { replace: true, keep: true })
  eq('返回 parents（无参）', topView(), { name: 'parents', params: {} })
}

console.log('\n=== 3. album 的一次性 songId 返回时被剥离（不二次起播）===')
{
  resetViewStack()
  rememberView('kidhome', {})
  rememberView('album', { id: 'nd:alb1', songId: 'song-x' })
  rememberView('player', {})
  const back = popForBack()
  ok('回专辑页 id 保留', back.params?.id === 'nd:alb1', JSON.stringify(back.params))
  ok('songId 已剥离（安静地看专辑）', back.params?.songId === undefined, JSON.stringify(back.params))
  goLike(back.name, back.params, { replace: true, keep: true })
  ok('重渲染后 songId 仍不在', topView().params?.songId === undefined, JSON.stringify(topView().params))
  // 非 album 页的 songId 不剥（只针对一次性起播指令）
  resetViewStack()
  rememberView('kidhome', {})
  rememberView('stats', { day: 'x', songId: 'keep-me' })
  rememberView('player', {})
  const s = popForBack()
  ok('非 album 页 songId 不误剥', s.params?.songId === 'keep-me', JSON.stringify(s.params))
}

console.log('\n=== 4. 普通 replace 仍是合并（0.14.0 深链参数修复不回退）===')
{
  resetViewStack()
  rememberView('album', { id: 'nd:alb1', songId: 'song-x' })
  rememberView('album', { foo: 'bar' }, { replace: true })
  const top = topView()
  ok('replace 合并：旧 id 保留', top.params?.id === 'nd:alb1', JSON.stringify(top.params))
  ok('replace 合并：新 foo 写入', top.params?.foo === 'bar', JSON.stringify(top.params))
}

console.log('\n=== 5. 页签清空历史 / 同页换参不灌历史 / 快照回滚 ===')
{
  resetViewStack()
  rememberView('kidhome', {})
  rememberView('album', { id: 'x' })
  rememberView('settings', {})            // 页签是根 → 清空
  eq('切页签后历史只剩 settings', viewHistory(), ['settings'])
  rememberView('stats', { day: 'a' })
  rememberView('stats', { day: 'b' })     // 同页换参 → 不 push
  eq('同页换参不灌历史', viewHistory(), ['settings', 'stats'])
  eq('同页换参更新了 day', topView().params, { day: 'b' })
  const snap = snapshotViewStack()
  rememberView('player', {})
  eq('快照后 push', viewHistory(), ['settings', 'stats', 'player'])
  restoreViewStack(snap)
  eq('回滚恢复快照', viewHistory(), ['settings', 'stats'])
  eq('currentView 回滚', currentView(), 'stats')
}

console.log('\n==============================================')
console.log(`结果：${pass} 通过 / ${fail} 失败`)
process.exit(fail ? 1 : 0)

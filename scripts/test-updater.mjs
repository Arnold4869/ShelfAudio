#!/usr/bin/env node
/**
 * 检测更新：版本比较逻辑单测。
 * 关键点是不能用字符串比较（"0.10.0" < "0.9.9" 是错的）。
 */
import { compareVer, updateSupported } from '../src/lib/updater.js'

// updater.js 引用了构建期常量 __APP_VERSION__，node 直跑时未定义 → 打桩
globalThis.__APP_VERSION__ = '0.4.1'
// updateSupported() 读 window.Capacitor → node 里打桩
globalThis.window = globalThis.window || {}

let pass = 0, fail = 0
function ok(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  ✅ ${name}`) }
  else { fail++; console.log(`  ❌ ${name} ${extra}`) }
}

const cases = [
  ['0.4.2', '0.4.1', 1, '补丁号更大'],
  ['0.4.1', '0.4.1', 0, '完全相同'],
  ['0.4.0', '0.4.1', -1, '补丁号更小'],
  ['0.5.0', '0.4.9', 1, '次版本更大'],
  ['1.0.0', '0.99.99', 1, '主版本更大'],
  ['0.10.0', '0.9.9', 1, '两位数次版本（字符串比较会错）'],
  ['v0.4.2', '0.4.1', 1, '带 v 前缀'],
  ['1.2.3 ', '1.2.3', 0, '尾部空格'],
  ['bad', '0.4.1', null, '非法输入返回 null'],
]
for (const [a, b, exp, desc] of cases) {
  const got = compareVer(a, b)
  ok(desc, got === exp, `compareVer(${a},${b})=${got} 期望 ${exp}`)
}

// 检测更新只在 Android 出现（iOS 走 Sideloadly 侧载，App 内下载安装无意义）
globalThis.window.Capacitor = { getPlatform: () => 'android' }
ok('Android 支持检测更新', updateSupported() === true)
globalThis.window.Capacitor = { getPlatform: () => 'ios' }
ok('iOS 不支持（不显示该行）', updateSupported() === false)
globalThis.window.Capacitor = undefined
ok('web 预览不支持', updateSupported() === false)

console.log('\n' + '='.repeat(40))
console.log(`结果：${pass} 通过 / ${fail} 失败`)
process.exit(fail ? 1 : 0)

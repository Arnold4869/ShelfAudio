/**
 * md5.js 单测（接 CI）：与系统 md5sum 口径完全一致才允许构建。
 *
 * 背景：Subsonic/Navidrome 认证 = md5(password + salt)，md5 错一个字节
 * 登录就永远 401。这里用固定用例 + 长度边界（55/56/63/64 字节跨块）+
 * 中文/多字节，全覆盖。
 */
import { execSync } from 'child_process'
import { md5, randomSalt } from '../src/lib/md5.js'

const cases = [
  '', 'a', 'ab', 'abc', 'abcd', 'abcde', 'abcdef', 'abcdefg',
  'password', 'hello world',
  'The quick brown fox jumps over the lazy dog',
  '中文测试', '密碼測試 mixed password 中文123',
  // 55/56/63/64 字节：正好压在 MD5 分块边界上（padding 规则的分界点）
  'A'.repeat(55), 'A'.repeat(56), 'A'.repeat(63), 'A'.repeat(64), 'A'.repeat(119), 'A'.repeat(120),
  'p'.repeat(40) + '盐盐盐',          // 模拟真实用途：password+salt，中英混合
]

let fail = 0
for (const s of cases) {
  const expected = execSync(`printf '%s' "${s.replace(/'/g, `'\\''`)}" | md5sum | cut -d' ' -f1`).toString().trim()
  const got = md5(s)
  const ok = got === expected
  if (!ok) {
    fail++
    console.log(`❌ md5(${JSON.stringify(s.length > 40 ? s.slice(0, 20) + `…(${s.length}B)` : s)}) = ${got}，期望 ${expected}`)
  }
}
// salt：长度、字符集
const salt = randomSalt(12)
if (!/^[A-Za-z0-9]{12}$/.test(salt)) { fail++; console.log('❌ randomSalt 格式不对:', salt) }
if (randomSalt(12) === randomSalt(12)) { fail++; console.log('❌ randomSalt 不随机') }

if (fail) { console.log(`❌ ${fail} 项失败`); process.exit(1) }
console.log(`✅ md5 ${cases.length} 用例 + salt 全部通过`)

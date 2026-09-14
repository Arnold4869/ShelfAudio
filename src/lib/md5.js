/**
 * MD5（Subsonic / Navidrome 认证用）
 *
 * 为什么自己带一个：Subsonic 认证要求 t = md5(password + salt)，而 Web Crypto
 * （crypto.subtle）**没有 MD5**（只有 SHA 系）；为一个函数引第三方包不值当。
 *
 * 写法说明（重要，别再手抄 64 行）：
 * 早先版本手抄了 RFC 1321 的 64 行 step 调用表，抄错后**空串能过、非空串全错**，
 * 排查很费劲。现在改用标准「公式化」写法：
 *   - 轮函数用 i 的分段判断（i<16 / <32 / <48 / else）
 *   - 消息字下标用公式：g = i / (5i+1)%16 / (3i+5)%16 / (7i)%16
 *   - 常量表 K[i] = floor(abs(sin(i+1)) * 2^32) —— 由代码算，不手写
 * 这样没有可抄错的长表。已验证与系统 md5sum 完全一致（见 scripts/test-md5.mjs）。
 */

/** 字符串 → UTF-8 字节数组 */
function utf8Bytes(str) {
  const out = []
  for (let i = 0; i < str.length; i++) {
    let c = str.codePointAt(i)
    if (c > 0xffff) i++            // 代理对已被 codePointAt 合并成一个码点
    if (c < 0x80) out.push(c)
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63))
    else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63))
    else out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63))
  }
  return out
}

/* eslint-disable no-bitwise */
export function md5(input) {
  const bytes = utf8Bytes(String(input))
  const len = bytes.length
  const bitLen = len * 8

  // 补位：0x80 + 若干 0，最后 8 字节放原始位长（小端）。
  // (((len + 8) >> 6) + 1) << 6 = 不小于 len+9 的最小 64 倍数
  const total = (((len + 8) >> 6) + 1) << 6
  const buf = new Uint8Array(total)
  for (let i = 0; i < len; i++) buf[i] = bytes[i]
  buf[len] = 0x80
  const dv = new DataView(buf.buffer)
  dv.setUint32(total - 8, bitLen >>> 0, true)
  dv.setUint32(total - 4, Math.floor(bitLen / 4294967296), true)

  // 每轮的左移位数（RFC 1321）
  const S = [
    7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
    5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
    4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
    6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
  ]
  // K[i] = floor(abs(sin(i+1)) * 2^32)（由代码算，不手写常量表）
  const K = new Int32Array(64)
  for (let i = 0; i < 64; i++) K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296) | 0

  let a0 = 0x67452301 | 0
  let b0 = 0xefcdab89 | 0
  let c0 = 0x98badcfe | 0
  let d0 = 0x10325476 | 0

  const M = new Int32Array(16)
  for (let off = 0; off < total; off += 64) {
    for (let i = 0; i < 16; i++) M[i] = dv.getInt32(off + i * 4, true)

    let A = a0, B = b0, C = c0, D = d0
    for (let i = 0; i < 64; i++) {
      let F, g
      if (i < 16) { F = (B & C) | (~B & D); g = i }
      else if (i < 32) { F = (D & B) | (~D & C); g = (5 * i + 1) % 16 }
      else if (i < 48) { F = B ^ C ^ D; g = (3 * i + 5) % 16 }
      else { F = C ^ (B | ~D); g = (7 * i) % 16 }

      F = (F + A + K[i] + M[g]) | 0
      A = D; D = C; C = B
      B = (B + ((F << S[i]) | (F >>> (32 - S[i])))) | 0
    }
    a0 = (a0 + A) | 0
    b0 = (b0 + B) | 0
    c0 = (c0 + C) | 0
    d0 = (d0 + D) | 0
  }

  // 输出：每个 32 位字按小端转 hex
  const hex32 = n => {
    let s = ''
    for (let i = 0; i < 4; i++) {
      s += ((n >>> (i * 8 + 4)) & 15).toString(16) + ((n >>> (i * 8)) & 15).toString(16)
    }
    return s
  }
  return hex32(a0) + hex32(b0) + hex32(c0) + hex32(d0)
}

/** 随机 salt（Subsonic 认证要求每次请求一个新 salt） */
export function randomSalt(len = 12) {
  const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
  const arr = new Uint8Array(len)
  if (typeof crypto !== 'undefined' && crypto.getRandomValues) crypto.getRandomValues(arr)
  else for (let i = 0; i < len; i++) arr[i] = Math.floor(Math.random() * 256)
  let out = ''
  for (let i = 0; i < len; i++) out += chars[arr[i] % chars.length]
  return out
}

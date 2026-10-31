/**
 * 快速起播 0.17.0：本地落点记忆 + 即时预热 + Wi-Fi 自动缓存（纯函数决策测试）
 *
 * 测的是真代码：直接 import src/lib/faststart.js，不复制逻辑。
 * - recordLastListen / buildWarmupPlan：任务1（最近在听 → boot 即时预热）
 * - decideAutoCache / pickAutoCacheTracks：任务3（Wi-Fi 自动缓存决策）
 * - isWifiLike：@capacitor/network 的 ConnectionStatus 判定
 *
 * 决策函数是纯函数（不碰 store / hub / Filesystem），可在未接线前先红后绿。
 */
import assert from 'assert'

const mod = await import('../src/lib/faststart.js')
const {
  isFreshEnough, isValidLastListen, buildWarmupPlan, isWifiLike,
  decideAutoCache, pickAutoCacheTracks,
} = mod

let pass = 0, fail = 0
const ok = (name, cond, extra = '') => {
  if (cond) { pass++ }
  else { fail++; console.error(`  ❌ ${name}${extra ? ' — ' + extra : ''}`) }
}

console.log('=== 1. isFreshEnough：记录过期判定（默认 7 天） ===')
ok('30 分钟前的记录算新鲜', isFreshEnough({ ts: Date.now() - 30 * 60e3 }, Date.now()) === true)
ok('正好 7 天边界内算新鲜', isFreshEnough({ ts: Date.now() - 7 * 864e5 + 600e3 }, Date.now()) === true)
ok('超过 7 天算过期', isFreshEnough({ ts: Date.now() - 8 * 864e5 }, Date.now()) === false)
ok('缺 ts → 过期（不暖）', isFreshEnough({}, Date.now()) === false)
ok('ts 为字符串数字也能判', isFreshEnough({ ts: String(Date.now() - 1000) }, Date.now()) === true)
ok('负/非数 ts → 过期', isFreshEnough({ ts: 'abc' }, Date.now()) === false)

console.log('=== 2. isValidLastListen：记录形状校验（缺字段直接跳过） ===')
ok('完整记录有效', isValidLastListen({ source: 'abs', itemId: 'b1', ino: 'ino9', trackIndex: 2, fileTime: 12.5, ts: Date.now() }) === true)
ok('ND 记录（ino=songId）有效', isValidLastListen({ source: 'nd', itemId: 'nd:al1', ino: 's7', trackIndex: 0, fileTime: 0, ts: Date.now() }) === true)
ok('缺 itemId 无效', isValidLastListen({ source: 'abs', ino: 'x', trackIndex: 0, fileTime: 0, ts: Date.now() }) === false)
ok('缺 ino 无效（拼不出直链）', isValidLastListen({ source: 'abs', itemId: 'b1', trackIndex: 0, fileTime: 0, ts: Date.now() }) === false)
ok('trackIndex 负数无效', isValidLastListen({ source: 'abs', itemId: 'b1', ino: 'x', trackIndex: -1, fileTime: 0, ts: Date.now() }) === false)
ok('trackIndex 非数无效', isValidLastListen({ source: 'abs', itemId: 'b1', ino: 'x', trackIndex: 'a', fileTime: 0, ts: Date.now() }) === false)
ok('fileTime 非数无效', isValidLastListen({ source: 'abs', itemId: 'b1', ino: 'x', trackIndex: 0, fileTime: 'x', ts: Date.now() }) === false)
ok('null/undefined/非对象无效', isValidLastListen(null) === false && isValidLastListen('x') === false && isValidLastListen([]) === false)
ok('source 缺失无效', isValidLastListen({ itemId: 'b1', ino: 'x', trackIndex: 0, fileTime: 0, ts: Date.now() }) === false)
ok('source 非法值无效', isValidLastListen({ source: 'ftp', itemId: 'b1', ino: 'x', trackIndex: 0, fileTime: 0, ts: Date.now() }) === false)

console.log('=== 3. buildWarmupPlan：记录 → warmup 入参（URL 口径与 app.js warmupFirstContinue 一致） ===')
{
  const p = buildWarmupPlan(
    { source: 'abs', itemId: 'b1', ino: 'ino9', trackIndex: 2, fileTime: 120, ts: Date.now() },
    { trackUrl: (u) => `https://abs.example.com${u}`, authHeaders: () => ({ Authorization: 'Bearer t' }) },
  )
  ok('ABS：url = /api/items/<id>/file/<ino>', p?.url === 'https://abs.example.com/api/items/b1/file/ino9', JSON.stringify(p))
  ok('ABS：headers 走 authHeaders(itemId)', p?.headers?.Authorization === 'Bearer t')
  ok('ABS：trackIndex 原样下发', p?.trackIndex === 2)
  ok('ABS：position = 本集内偏移', p?.position === 120)
  ok('ABS：itemId 原样下发', p?.itemId === 'b1')
}
{
  const p = buildWarmupPlan(
    { source: 'nd', itemId: 'nd:al1', ino: 's7', trackIndex: 0, fileTime: 30, ts: Date.now() },
    { downloadUrl: (id, u) => `https://nd.example.com${u}`, authHeaders: () => null },
  )
  ok('ND：url = downloadUrl + /rest/stream?id=<songId>', p?.url === 'https://nd.example.com/rest/stream?id=s7', JSON.stringify(p))
  ok('ND：headers = null（凭据在 URL）', p?.headers === null)
}
{
  const p = buildWarmupPlan(
    { source: 'abs', itemId: 'b1', ino: 'ino9', trackIndex: 3, fileTime: 5, ts: Date.now() },
    { trackUrl: () => '' },   // 未登录该源 → trackUrl 拿不到直链
  )
  ok('直链拿不到 → 返回 null（跳过，不硬造 URL）', p === null, JSON.stringify(p))
}
{
  const p = buildWarmupPlan({ source: 'abs', itemId: 'b1', ino: 'ino9', trackIndex: 0, fileTime: 0, ts: Date.now() }, null)
  ok('hub 缺失 → null（不抛）', p === null)
}

console.log('=== 4. isWifiLike：@capacitor/network ConnectionStatus 判定 ===')
ok('wifi → true', isWifiLike({ connected: true, connectionType: 'wifi' }) === true)
ok('cellular → false（流量不自动缓存）', isWifiLike({ connected: true, connectionType: 'cellular' }) === false)
ok('none → false', isWifiLike({ connected: false, connectionType: 'none' }) === false)
ok('connected 但类型未知 → false', isWifiLike({ connected: true, connectionType: 'unknown' }) === false)
ok('null/undefined → false', isWifiLike(null) === false && isWifiLike(undefined) === false)

console.log('=== 5. decideAutoCache：自动缓存决策（可测纯函数） ===')
{
  const base = {
    now: Date.now(),
    lastTs: Date.now() - 6 * 60e3,
    gateBlocked: false,
    enabled: true,
    wifi: true,
    native: true,
    active: false,
  }
  ok('全条件满足 → 允许', decideAutoCache(base) === true)
  ok('设置关闭 → 拒绝', decideAutoCache({ ...base, enabled: false }) === false)
  ok('家长管控拦截 → 拒绝', decideAutoCache({ ...base, gateBlocked: true }) === false)
  ok('非 Wi-Fi → 拒绝', decideAutoCache({ ...base, wifi: false }) === false)
  ok('浏览器/web 环境 → 拒绝', decideAutoCache({ ...base, native: false }) === false)
  ok('正在播放 → 拒绝（不抢播放路径）', decideAutoCache({ ...base, active: true }) === false)
  ok('节流窗口内 → 拒绝', decideAutoCache({ ...base, lastTs: Date.now() - 60e3 }) === false)
  ok('节流窗口刚好过线 → 允许', decideAutoCache({ ...base, lastTs: Date.now() - 6 * 60e3 }) === true)
  ok('缺 lastTs（从未触发过）→ 允许', decideAutoCache({ ...base, lastTs: 0 }) === true)
}

console.log('=== 6. pickAutoCacheTracks：当前集+下一集（同一集不重复下载） ===')
{
  const files = Array.from({ length: 5 }, (_, i) => ({ ino: `ino${i}`, duration: 100 }))
  ok('集 2 → 候选 [ino2,ino3]', JSON.stringify(pickAutoCacheTracks(2, files)) === '["ino2","ino3"]',
    JSON.stringify(pickAutoCacheTracks(2, files)))
  ok('最后一集 → 只有本集', JSON.stringify(pickAutoCacheTracks(4, files)) === '["ino4"]')
  ok('越界 trackIndex → 归 0', JSON.stringify(pickAutoCacheTracks(9, files)) === '["ino0","ino1"]')
  ok('负 trackIndex → 归 0', JSON.stringify(pickAutoCacheTracks(-2, files)) === '["ino0","ino1"]')
  ok('空音轨表 → 空候选', JSON.stringify(pickAutoCacheTracks(0, [])) === '[]')
  ok('缺 ino 的集被剔除', JSON.stringify(pickAutoCacheTracks(0, [{ duration: 1 }, { ino: 'a' }])) === '["a"]')
  ok('ino 两端 trim 归一', JSON.stringify(pickAutoCacheTracks(0, [{ ino: ' x ' }, { ino: 'y' }])) === '["x","y"]')
}

console.log(`\nfaststart 决策测试：${pass} 通过，${fail} 失败`)
if (fail) process.exit(1)

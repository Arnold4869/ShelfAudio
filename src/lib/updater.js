/**
 * 检测更新
 *
 * 老板 2026-09-12：希望 App 里能一键「检测更新」——新版本放到固定位置就能检测到。
 * 固定位置 = 本仓库的 GitHub Release（CI 每次发布自动上传 ipa / apk）。
 * 仓库是 public，读 Release 不需要 token。
 *
 * 比较规则：按 x.y.z 数值比大小（不用字符串比较，"0.10.0" 比 "0.9.0" 大）。
 */
import { CapacitorHttp } from '@capacitor/core'

const REPO = 'Arnold4869/ShelfAudio'
const API = `https://api.github.com/repos/${REPO}/releases/latest`

/** 当前 App 版本（构建时由 vite define 注入） */
export function currentVersion() {
  return typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : '0.0.0'
}

/** 解析 "v1.2.3" / "1.2.3" → [1,2,3]；解析不了返回 null */
function parseVer(s) {
  const m = String(s || '').trim().replace(/^v/i, '').match(/^(\d+)\.(\d+)\.(\d+)/)
  if (!m) return null
  return [Number(m[1]), Number(m[2]), Number(m[3])]
}

/** a 比 b 新 → 1；相同 → 0；更旧 → -1；无法比较 → null */
export function compareVer(a, b) {
  const x = parseVer(a), y = parseVer(b)
  if (!x || !y) return null
  for (let i = 0; i < 3; i++) {
    if (x[i] > y[i]) return 1
    if (x[i] < y[i]) return -1
  }
  return 0
}

/**
 * 自定义更新地址（可选）。
 * 设置后优先查它，查不到再回落 GitHub Release。
 * 支持两种返回格式：
 *   1) GitHub Release API 原始 JSON（tag_name + assets[]）
 *   2) 简易清单 { "version": "0.5.0", "apk": "https://.../x.apk", "ipa": "...", "notes": "..." }
 * 这样「指定位置」可以换成自己的服务器 / NAS，而不用改代码。
 */
const CUSTOM_KEY = 'updateUrl'

export function customUpdateUrl() {
  try { return localStorage.getItem(CUSTOM_KEY) || '' } catch (_) { return '' }
}

export function setCustomUpdateUrl(url) {
  try { url ? localStorage.setItem(CUSTOM_KEY, url) : localStorage.removeItem(CUSTOM_KEY) } catch (_) {}
}

/** 归一化：不管是 GitHub 原始响应还是简易清单，都变成同一个形状 */
function normalize(d, cur, sourceUrl) {
  const latest = String(d.tag_name || d.version || d.name || '').replace(/^v/i, '')
  const assets = d.assets || []
  const apkUrl = d.apk || assets.find(a => /\.apk$/i.test(a.name || ''))?.browser_download_url || null
  const ipaUrl = d.ipa || assets.find(a => /\.ipa$/i.test(a.name || ''))?.browser_download_url || null
  return {
    ok: true,
    current: cur,
    latest,
    hasUpdate: compareVer(latest, cur) === 1,
    apk: apkUrl,
    ipa: ipaUrl,
    notes: d.body || d.notes || '',
    url: d.html_url || sourceUrl || '',
  }
}

/**
 * 查询最新版本。
 * @returns {Promise<{ok:boolean, latest?:string, apk?:string, ipa?:string, notes?:string,
 *                    url?:string, error?:string, hasUpdate?:boolean}>}
 */
export async function checkUpdate() {
  const cur = currentVersion()
  const custom = customUpdateUrl()
  if (custom) {
    const r = await fetchOne(custom)
    if (r.ok) return r
    // 自定义地址不通就回落 GitHub（避免老板换地址后填错就彻底查不了）
  }
  return fetchOne(API)
}

async function fetchOne(url) {
  const cur = currentVersion()
  try {
    const res = await CapacitorHttp.get({
      url,
      headers: { Accept: 'application/vnd.github+json' },
      connectTimeout: 12000,
      readTimeout: 15000,
    })
    if (res.status === 404) return { ok: false, error: url === API ? '还没有发布过任何版本' : '更新清单不存在（404）' }
    if (res.status !== 200) return { ok: false, error: `服务器返回 ${res.status}` }
    const d = typeof res.data === 'string' ? JSON.parse(res.data) : res.data
    return normalize(d, cur, url)
  } catch (e) {
    const msg = String(e?.message || e)
    // 无网 / 服务器不可达 是最常见情况，给个人话
    if (/timeout|network|failed|unreachable|UnknownHost/i.test(msg)) {
      return { ok: false, error: '网络不通，检查网络后重试' }
    }
    return { ok: false, error: '检测失败：' + msg.slice(0, 60) }
  }
}

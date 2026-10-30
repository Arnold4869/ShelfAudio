/**
 * 本机收藏（服务器写入被拒时的兜底）
 *
 * 背景：ABS 里**改收藏夹需要 update 权限**。实测普通用户账号的
 * permissions.update = false，调 POST /api/collections/<id>/book 直接返回 403
 * （纯 "Forbidden"，没有任何细节）。老板点收藏就报 403 —— 功能等于不可用。
 *
 * 处理策略（不替用户改服务器配置，也不让功能哑掉）：
 *  1. 优先写服务器（换设备也在，跟其它 ABS 客户端共享）——这是正路。
 *  2. 服务器拒绝（403）时**退到本机收藏**，功能可用，并在界面上标明"只在这台手机"。
 *  3. 服务器能写时，把本机收藏顺带上同步过去（升级权限后自动补齐）。
 *
 * 特意不做的事：不静默失败、不假装已同步 —— 界面上必须能看出来源。
 */
import { store, CONFIG_KEYS } from './store.js'

const KEY = 'localFavs'

/** 本机收藏条目：[{ id, title, author, duration, at }] */
export async function listLocal() {
  const v = await store.getJSON(KEY, [])
  return Array.isArray(v) ? v : []
}

export async function hasLocal(id) {
  if (!id) return false
  return (await listLocal()).some(x => x.id === id)
}

export async function addLocal(item) {
  if (!item?.id) return
  // §4.7（2026-10-12）：RMW 走 store.mutateJSON 串行队列 —— addLocal 可能在
  // 收藏页批量操作/播放页连点时并行触发，无队列会互相覆盖丢条目。
  await store.mutateJSON(KEY, list => {
    const cur = Array.isArray(list) ? list : []
    if (cur.some(x => x.id === item.id)) return undefined
    cur.unshift({
      id: item.id,
      title: item.title || '未命名',
      author: item.author || '',
      duration: item.duration || 0,
      at: Date.now(),
    })
    return cur
  })
}

export async function removeLocal(id) {
  await store.mutateJSON(KEY, list =>
    (Array.isArray(list) ? list : []).filter(x => x.id !== id))
}

/** 本机收藏的 id 集合（给播放页判断心形状态用） */
export async function localIdSet() {
  return new Set((await listLocal()).map(x => x.id))
}

/**
 * 把本机收藏同步到 ABS 服务器（在能写的时候调用）。
 * 目的是：用户去 ABS 后台给了 update 权限之后，之前"存在本机"的收藏能自动补齐。
 * ⚠️ 多源（2026-09-14）：只补记 ABS 的条目（本机收藏来自 ABS 播放页）；
 * ND 的收藏走 star，另一条链路。
 * @returns {number} 成功同步的条数
 */
export async function syncToServer(abs) {
  const list = (await listLocal()).filter(x => !String(x.id || '').startsWith('nd:'))
  if (!list.length) return 0
  let ok = 0
  let cols = []
  try { cols = await abs.collections() } catch (_) { return 0 }
  const col = cols?.[0]
  if (!col) return 0
  for (const it of list) {
    // 已经在服务器收藏夹里的就不用管
    if ((col.books || []).some(b => b.id === it.id)) { ok++; continue }
    try {
      await abs.addToCollection(col.id, it.id)
      ok++
    } catch (_) { break }   // 还是没权限，别再试了
  }
  // 全部补齐了才清掉本机记录，否则保留（没同步成功的不能丢）。
  // NF-4（复审 2026-10-12）：原来的 `() => []` 虽然走了串行队列，但队列只保证
  // 读写不交错，挡不住「清空整个键」把快照之后并发 addLocal 的新收藏一并冲掉
  // （last-write-wins）。改成**只删快照里已同步的那些 id**：并发新增天然保留，
  // 注释宣称的「不冲掉并发新增」这才真成立。
  if (ok >= list.length) {
    const synced = new Set(list.map(x => x.id))
    await store.mutateJSON(KEY, cur =>
      (Array.isArray(cur) ? cur : []).filter(x => !synced.has(x.id)))
  }
  return ok
}

/**
 * 继续听（本地补记层）
 *
 * 背景（老板 2026-09-13）：「我播放一个东西，返回到页面，它不会直接增加，
 * 应该在第一时间播放时就添加到里边，排到最上边」。
 *
 * 为什么 ABS 做不到：继续听列表来自 ABS 的 items-in-progress，
 * 但新书第一次播放要等会话同步后才出现在服务端（可能几十秒后），
 * 「返回页面就看到」必须本地补记。
 *
 * 设计：playItem 成功起播时记一条 { id, ts, title, author, duration }；
 * 渲染继续听时与服务端列表**合并**：本地的在前（刚播放的排最上），
 * 去重按 id。上限 20 条，够回看且不膨胀。
 *
 * 写入一律走 store.mutateJSON 串行队列（§4.7，2026-10-12）：recordContinue
 * 在 playItem 里是不 await 的并行写，快速连点两本书时两次「读-改-写」交错
 * 会丢先写的那条 —— 与离线索引同款问题，统一串行化。
 */
import { store } from './store.js'

const KEY = 'continueLocal'
const MAX = 20

export function recordContinue(entry) {
  if (!entry?.id) return Promise.resolve()
  return store.mutateJSON(KEY, list => {
    const cur = Array.isArray(list) ? list : []
    return [{ id: entry.id, ts: Date.now(), ...entry }, ...cur.filter(x => x.id !== entry.id)].slice(0, MAX)
  })
}

export function removeContinueLocal(id) {
  return store.mutateJSON(KEY, list =>
    (Array.isArray(list) ? list : []).filter(x => x.id !== id))
}

export async function listContinueLocal() {
  const list = (await store.getJSON(KEY, [])) || []
  return list.sort((a, b) => b.ts - a.ts)
}

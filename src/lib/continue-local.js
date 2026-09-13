/**
 * 继续听（本地补记层）
 *
 * 背景（老板 2026-09-14）：「我播放一个东西，返回到页面，它不会直接增加，
 * 应该在第一时间播放时就添加到里边，排到最上边」。
 *
 * 为什么 ABS 做不到：继续听列表来自 ABS 的 items-in-progress，
 * 但新书第一次播放要等会话同步后才出现在服务端（可能几十秒后），
 * 「返回页面就看到」必须本地补记。
 *
 * 设计：playItem 成功起播时记一条 { id, ts, title, author, duration }；
 * 渲染继续听时与服务端列表**合并**：本地的在前（刚播放的排最上），
 * 去重按 id。上限 20 条，够回看且不膨胀。
 */
import { store } from './store.js'

const KEY = 'continueLocal'
const MAX = 20

export async function recordContinue(entry) {
  if (!entry?.id) return
  const list = (await store.getJSON(KEY, [])) || []
  const next = [{ id: entry.id, ts: Date.now(), ...entry }, ...list.filter(x => x.id !== entry.id)]
  await store.setJSON(KEY, next.slice(0, MAX))
}

export async function removeContinueLocal(id) {
  const list = (await store.getJSON(KEY, [])) || []
  await store.setJSON(KEY, list.filter(x => x.id !== id))
}

export async function listContinueLocal() {
  const list = (await store.getJSON(KEY, [])) || []
  return list.sort((a, b) => b.ts - a.ts)
}

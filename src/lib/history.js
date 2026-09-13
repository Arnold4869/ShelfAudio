/**
 * 历史记录数据层（首页预览与历史页共用同一口径）
 *
 * 数据源 = 服务端 items-in-progress + 本地补记（continue-local），合并去重，
 * 并**必须过滤 hideFromContinueListening**（审计发现 ABS 列表接口会返回已隐藏的书，
 * 不过滤就会「长按删了又回来」——老板 2026-09-13 实测反馈）。
 *
 * 产出条目：{ id, media, pct, finished, raw }，raw 保留原 item 供 playItem 用。
 */
import { abs } from './api.js'
import { listContinueLocal, removeContinueLocal } from './continue-local.js'

export async function loadHistory() {
  // 1) 服务端隐藏集合（mediaProgress 是唯一可靠的「用户删过」来源）
  let progressMap = {}
  try {
    const me = await abs.me()
    for (const mp of (me?.mediaProgress || [])) {
      const id = mp.libraryItemId || mp.mediaItemId
      if (id) progressMap[id] = mp
    }
  } catch (_) {}
  const hiddenIds = new Set(
    Object.values(progressMap)
      .filter(mp => mp.hideFromContinueListening)
      .map(mp => mp.libraryItemId || mp.mediaItemId)
      .filter(Boolean)
  )

  // 2) 服务端在听 + 排序（最近听的最前）
  const out = []
  const seen = new Set()
  try {
    const raw = await abs.itemsInProgress()
    const sorted = (raw || [])
      .map(it => {
        const mp = progressMap[it.id]
        const ts = it.progressLastUpdate || mp?.lastUpdate || mp?.finishedAt || 0
        return { it, ts: Number(ts) || 0 }
      })
      .sort((a, b) => b.ts - a.ts)
    for (const { it } of sorted) {
      if (hiddenIds.has(it.id) || seen.has(it.id)) continue
      seen.add(it.id)
      const mp = progressMap[it.id]
      const pct = mp?.duration ? Math.round((mp.currentTime || 0) / mp.duration * 100) : 0
      out.push({ id: it.id, media: it.media, pct, finished: !!mp?.isFinished, raw: it })
    }
  } catch (_) {}

  // 3) 本地补记（起播瞬间就有，比服务端快）
  try {
    const local = await listContinueLocal()
    for (const x of local) {
      if (hiddenIds.has(x.id) || seen.has(x.id)) continue
      seen.add(x.id)
      out.push({
        id: x.id,
        media: { metadata: { title: x.title, authorName: x.author } },
        pct: x.pct || 0,
        finished: false,
        raw: null,
      })
    }
  } catch (_) {}

  return out
}

/** 删除一条历史：服务端隐藏 + 本地补记清掉。返回前不抛（本地删失败不阻塞服务端） */
export async function removeHistoryEntry(id) {
  let err = null
  try { await removeContinueLocal(id) } catch (e) { err = e }
  try { await abs.removeFromContinue(id) } catch (e) { err = e }
  if (err) throw err
}

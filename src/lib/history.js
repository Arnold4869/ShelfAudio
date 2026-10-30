/**
 * 历史记录数据层（首页预览与历史页共用同一口径）
 *
 * 数据源 = 服务端 items-in-progress + 本地补记（continue-local），合并去重，
 * 并**必须过滤 hideFromContinueListening**（审计发现 ABS 列表接口会返回已隐藏的书，
 * 不过滤就会「长按删了又回来」——老板 2026-09-13 实测反馈）。
 *
 * ND 侧（2026-10-12 审计修，P1 §3.3）：Subsonic 没有「隐藏继续听」的概念 ——
 * removeFromContinue 只删 bookmark，而 updateProgress 每次同步都会重建它们，
 * 表现为「删完立刻回来」。这里用本地隐藏清单（ndHiddenContinue）兜底：
 * 删除成功后记入；用户重新收听时解除（unhideHistoryEntry，app.js 在起播时调）。
 *
 * 产出条目：{ id, media, pct, finished, raw }，raw 保留原 item 供 playItem 用。
 */
import { hub as abs } from './servers.js'
import { store, CONFIG_KEYS } from './store.js'
import { listContinueLocal, removeContinueLocal } from './continue-local.js'

/** 本地隐藏清单上限（防止无限增长；正常用户删不了这么多） */
const ND_HIDDEN_MAX = 100

/** 读 ND 本地隐藏清单（返回 Set，读失败返回空集 —— 历史要能展示，不能因此挂） */
async function ndHiddenSet() {
  try {
    const v = await store.getJSON(CONFIG_KEYS.ndHiddenContinue, [])
    return new Set(Array.isArray(v) ? v : [])
  } catch (_) { return new Set() }
}

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
  // ND 的本地隐藏清单并入（P1 §3.3：服务端删 bookmark 会被进度同步重建，
  // 没有这层兜底 ND 的历史条目删完立刻回来）
  for (const id of await ndHiddenSet()) hiddenIds.add(id)

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
      // 进度三来源：①服务端 mediaProgress（ABS）；②ND 客户端从 bookmark 聚合出的
      // _progress 快照（ND 的 me() 恒空，修复前 ND 历史条目永远显示「未开始」0%）；
      // ③条目自身 mediaProgress（ABS items-in-progress 有时自带）。
      const prog = mp || it._progress || it.mediaProgress || null
      const pct = prog?.duration ? Math.round((prog.currentTime || 0) / prog.duration * 100) : 0
      out.push({ id: it.id, media: it.media, pct, finished: !!prog?.isFinished, raw: it })
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

/**
 * 删除一条历史：服务端隐藏 + 本地补记清掉 + ND 记入本地隐藏清单。
 * 返回前不抛（本地删失败不阻塞服务端）。
 */
export async function removeHistoryEntry(id) {
  let err = null
  try { await removeContinueLocal(id) } catch (e) { err = e }
  try { await abs.removeFromContinue(id) } catch (e) { err = e }
  // ND：删除成功后记入本地隐藏清单（P1 §3.3）。服务端的 bookmark 会被下次
  // 进度同步重建，历史页因此又会看到它 —— 本地清单才是 ND 的「隐藏」本体。
  // NF-2（复审 2026-10-12）：改走 mutateJSON 串行队列 —— unhide 在起播路径上
  // 是 fire-and-forget，与这里的「读-改-写」交错时裸 RMW 会互相覆盖
  // （同 §4.7 给 continue-local/favs 统一的模式，这处是新键自己漏掉的）。
  if (!err && String(id || '').startsWith('nd:')) {
    await store.mutateJSON(CONFIG_KEYS.ndHiddenContinue, list => {
      const cur = (Array.isArray(list) ? list : []).filter(x => x !== id)
      cur.push(id)
      return cur.slice(-ND_HIDDEN_MAX)
    })   // mutateJSON 内部吞错：记不进本地时至少服务端 bookmark 已删，不因这步报错
  }
  if (err) throw err
}

/**
 * 重新收听时解除本地隐藏（ND）：用户主动播了这张专辑，历史就该再出现。
 * app.js 在 playItem 起播成功时调用（不阻塞起播路径）。
 */
export async function unhideHistoryEntry(id) {
  if (!String(id || '').startsWith('nd:')) return
  // NF-2：同走串行队列，与 removeHistoryEntry 的写入互斥（防交错覆盖）。
  // 不在清单里 → 返回 undefined = 不写回（与旧版的提前 return 等价）。
  await store.mutateJSON(CONFIG_KEYS.ndHiddenContinue, list =>
    (Array.isArray(list) && list.includes(id)) ? list.filter(x => x !== id) : undefined)
}

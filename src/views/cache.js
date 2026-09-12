/**
 * 离线缓存管理页
 *
 * 两件事：
 *  1. 看/管已缓存的书（占用空间、删掉、全清）
 *  2. 把某本书下到本机（选书下载）
 *
 * 与播放的关系：播放时 lib/offline.js 会自动优先用本地文件，
 * 所以这里下过的书，断网也能直接听。
 */
import { abs } from '../lib/api.js'
import { state, go, toast, esc, fmtDur, requireParentPin, updateMini } from '../app.js'
import { icon } from '../lib/icons.js'
import { haptic } from '../lib/haptics.js'
import {
  cachedBooks, cacheSize, downloadBook, removeBook, clearAll, isCached, fmtBytes,
} from '../lib/offline.js'

export async function renderCache(root) {
  root.innerHTML = `<div class="empty"><div class="glyph">${icon('loader', 40, 'spin')}</div>正在读取…</div>`

  const list = await cachedBooks()
  const used = await cacheSize()

  // 可下载的书（库里全部）
  let all = state.items || []
  if (!all.length) {
    try {
      if (!state.libraryId) {
        const libs = await abs.libraries()
        state.libraries = libs
        state.libraryId = libs[0]?.id
      }
      all = (await abs.getLibraryItems(state.libraryId, { limit: 300 }))?.results || []
      state.items = all
    } catch (_) { }
  }

  root.innerHTML = `
    <div class="page-head">
      <button class="icon-btn" id="btnBack" aria-label="返回">${icon('back', 22)}</button>
      <div class="page-title">离线缓存</div>
    </div>

    <div class="cache-hero">
      <div class="cache-used">${fmtBytes(used)}</div>
      <div class="cache-used-label">已缓存 ${list.length} 本书</div>
    </div>

    ${list.length ? `
      <div class="section-h">已缓存</div>
      <div class="settings-group">
        ${list.map(b => `
          <div class="setting-row" data-cached="${esc(b.id)}">
            <div class="setting-ic">${icon('download', 22)}</div>
            <div class="setting-main">
              <div class="setting-label">${esc(b.title || '未命名')}</div>
              <div class="setting-value">${b.count} 集 · ${fmtBytes(b.bytes)}</div>
            </div>
            <button class="row-del" data-del="${esc(b.id)}" aria-label="删除">${icon('trash', 20)}</button>
          </div>`).join('')}
      </div>
      <div style="margin-top:10px">
        <button class="btn block ghost" id="btnClearAll" style="color:var(--danger)">清空全部缓存</button>
      </div>
    ` : `
      <div class="empty" style="margin-top:30px">
        <div class="glyph">${icon('download', 44)}</div>
        还没有缓存的书<br>
        <span style="font-size:13px">缓存后在没网的地方也能听</span>
      </div>`}

    <div class="section-h">下载书籍 <small>${all.length} 本</small></div>
    <div class="settings-group" id="dlList">
      ${all.length ? all.map(it => {
        const m = it.media?.metadata || {}
        const dur = it.media?.duration || 0
        const cached = list.some(x => x.id === it.id)
        return `<div class="setting-row" data-book="${esc(it.id)}">
          <div class="setting-ic">${icon('headphones', 22)}</div>
          <div class="setting-main">
            <div class="setting-label">${esc(m.title || '未命名')}</div>
            <div class="setting-value">${esc(m.authorName || '')}${dur ? ' · ' + fmtDur(dur) : ''}</div>
          </div>
          <div class="row-act">
            ${cached
              ? `<span class="row-done">${icon('check', 18)} 已缓存</span>`
              : `<button class="btn small" data-dl="${esc(it.id)}">下载</button>`}
          </div>
        </div>`
      }).join('') : `<div class="hint">书库没拉到，检查网络后重进本页</div>`}
    </div>
  `

  const $ = s => root.querySelector(s)
  $('#btnBack').onclick = () => { haptic.tap(); go('settings') }

  // 删除单本
  root.querySelectorAll('[data-del]').forEach(b => {
    b.onclick = async e => {
      e.stopPropagation()
      haptic.tap()
      const id = b.dataset.del
      const rec = list.find(x => x.id === id)
      const modal = document.createElement('div')
      modal.className = 'lock'
      modal.innerHTML = `<div class="lock-card">
        <div class="lock-title">删除缓存？</div>
        <div class="lock-sub">「${esc(rec?.title || '')}」的音频会从手机里删掉，之后要联网才能听。</div>
        <div class="lock-actions">
          <button class="btn ghost" id="dCancel">取消</button>
          <button class="btn danger" id="dOk">删除</button>
        </div>
      </div>`
      document.body.appendChild(modal)
      modal.querySelector('#dCancel').onclick = () => modal.remove()
      modal.querySelector('#dOk').onclick = async () => {
        modal.remove()
        await removeBook(id)
        haptic.success()
        toast('已删除')
        await go('cache')
      }
    }
  })

  // 全清
  const ca = $('#btnClearAll')
  if (ca) ca.onclick = async () => {
    haptic.tap()
    if (state.kidPin) { if (!(await requireParentPin())) return }
    await clearAll()
    haptic.success()
    toast('缓存已清空')
    await go('cache')
  }

  // 下载
  root.querySelectorAll('[data-dl]').forEach(b => {
    b.onclick = async e => {
      e.stopPropagation()
      haptic.tap()
      const id = b.dataset.dl
      const it = all.find(x => x.id === id)
      if (!it) return
      await startDownload(root, it)
    }
  })

  updateMini()
}

/** 弹进度层并执行下载 */
async function startDownload(root, item) {
  const m = item.media?.metadata || {}
  const modal = document.createElement('div')
  modal.className = 'lock'
  modal.innerHTML = `<div class="lock-card">
    <div class="lock-title">下载中</div>
    <div class="lock-sub" id="dlLabel">${esc(m.title || '')}</div>
    <div class="dl-bar"><i id="dlFill" style="width:0%"></i></div>
    <div class="dl-pct" id="dlPct">0%</div>
    <div class="lock-actions">
      <button class="btn ghost" id="dlCancel">关闭</button>
    </div>
  </div>`
  document.body.appendChild(modal)
  let closed = false
  modal.querySelector('#dlCancel').onclick = () => { closed = true; modal.remove() }

  try {
    // tracks 要从 /play 拿（列表接口没有音轨）；这里用现有接口顺手取
    const detail = await abs.getItem(item.id)
    const audioFiles = detail?.media?.audioFiles || []
    const tracks = audioFiles.map((af, i) => ({
      index: i + 1,
      title: af.metaTags?.title || af.title || `第${i + 1}集`,
      contentUrl: `/api/items/${item.id}/file/${af.ino}`,
      duration: af.duration || 0,
    }))
    if (!tracks.length) { modal.remove(); haptic.error(); toast('这本书没有音频文件'); return }

    const res = await downloadBook(
      { id: item.id, title: m.title, tracks },
      ({ pct, label }) => {
        if (closed) return
        const f = modal.querySelector('#dlFill')
        if (f) f.style.width = pct + '%'
        const p = modal.querySelector('#dlPct')
        if (p) p.textContent = pct + '% · ' + (label || '').slice(0, 14)
      }
    )
    modal.remove()
    if (res.fail) { haptic.warn(); toast(`下载完成：${res.ok} 集成功，${res.fail} 集失败`) }
    else { haptic.success(); toast('已缓存 ' + res.ok + ' 集') }
    await go('cache')
  } catch (e) {
    modal.remove()
    haptic.error()
    toast('下载失败：' + (e.message || e))
  }
}

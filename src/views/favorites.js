/**
 * 我的收藏页
 *
 * 背景：播放页的心形按钮能"加收藏"，但之前没有任何地方能"看收藏"——
 * 用户反馈「好像还没专门的入口」。这里补上入口。
 *
 * 数据源：ABS 的 collections（/api/collections）。
 * 注意：ABS 里可能同时存在多个同名收藏夹（用户自己建的），
 * 所以这里按收藏夹分组显示，而不是合并成一个平面列表 —— 否则用户会困惑
 * "为什么同一本书出现两次"（实测库里有 2 个都叫「常听」的收藏夹）。
 */
import { abs } from '../lib/api.js'
import { state, go, toast, esc, fmtDur, playItem, updateMini } from '../app.js'
import { icon } from '../lib/icons.js'
import { haptic } from '../lib/haptics.js'
import { fallbackCover, wireCoverFallback } from '../lib/cover.js'

export async function renderFavorites(root) {
  root.innerHTML = `<div class="empty"><div class="glyph">${icon('loader', 40, 'spin')}</div>正在读取收藏…</div>`

  let cols = []
  try {
    cols = (await abs.collections()) || []
  } catch (e) {
    root.innerHTML = `<div class="empty"><div class="glyph">${icon('warning', 44)}</div>${esc(e.message)}</div>`
    return
  }

  // 每个收藏夹补上完整书籍信息（列表返回的是精简对象，缺 media/duration）
  const groups = []
  for (const c of cols) {
    let books = c.books || []
    if (books.length) {
      // 若书籍对象缺 media，则取一次详情
      const need = books.filter(b => !b.media)
      if (need.length) {
        try {
          const full = await abs.getCollection(c.id)
          books = full?.books || books
        } catch (_) { }
      }
    }
    groups.push({ id: c.id, name: c.name || '收藏', books })
  }

  const total = groups.reduce((a, g) => a + g.books.length, 0)

  root.innerHTML = `
    <div class="page-head">
      <button class="icon-btn" id="btnBack" aria-label="返回">${icon('back', 22)}</button>
      <div class="page-title">我的收藏</div>
    </div>

    ${total ? groups.map(g => g.books.length ? `
      <div class="section-h">${esc(g.name)} <small>${g.books.length} 本</small></div>
      <div class="settings-group" style="padding:4px 0">
        ${g.books.map(it => {
          const m = it.media?.metadata || {}
          const title = m.title || it.title || '未命名'
          return `<div class="list-item" data-id="${esc(it.id)}">
            <div class="cover-slot">
              ${fallbackCover({ title, author: m.authorName || m.narratorName, cls: 'cover-ph-list' })}
              <img class="list-cover" data-cover src="${abs.coverUrl(it.id, { width: 160 })}" alt="" loading="lazy">
            </div>
            <div class="list-main">
              <div class="list-title">${esc(title)}</div>
              <div class="list-sub">${esc(m.authorName || m.narratorName || '')}${it.media?.duration ? ' · ' + fmtDur(it.media.duration) : ''}</div>
            </div>
            <button class="row-del" data-rm="${esc(it.id)}" data-col="${esc(g.id)}" aria-label="取消收藏">${icon('trash', 20)}</button>
          </div>`
        }).join('')}
      </div>` : '').join('') : `
      <div class="empty" style="margin-top:40px">
        <div class="glyph">${icon('heart', 44)}</div>
        还没有收藏的书<br>
        <span style="font-size:13px">在播放页点心形按钮就能收藏</span>
      </div>`}

    <div class="hint" style="margin-top:16px">
      收藏存在你的 Audiobookshelf 服务器上，换设备也在。
    </div>
  `

  const $ = s => root.querySelector(s)
  $('#btnBack').onclick = () => { haptic.tap(); go('settings') }
  wireCoverFallback(root)

  // 点书 → 播放
  root.querySelectorAll('.list-item[data-id]').forEach(el => {
    el.onclick = async e => {
      if (e.target.closest('[data-rm]')) return
      haptic.tap()
      const id = el.dataset.id
      const it = groups.flatMap(g => g.books).find(x => x.id === id)
      if (!it) return
      try {
        if (it.media) await playItem(it)
        else await playItem(await abs.getItem(id))
      } catch (err) { toast(err.message || '打不开这本书') }
    }
  })

  // 取消收藏
  root.querySelectorAll('[data-rm]').forEach(b => {
    b.onclick = async e => {
      e.stopPropagation()
      haptic.tap()
      const modal = document.createElement('div')
      modal.className = 'lock'
      modal.innerHTML = `<div class="lock-card">
        <div class="lock-title">取消收藏？</div>
        <div class="lock-sub">只是从收藏夹里移除，书还在书架上。</div>
        <div class="lock-actions">
          <button class="btn ghost" id="fCancel">取消</button>
          <button class="btn danger" id="fOk">移除</button>
        </div>
      </div>`
      document.body.appendChild(modal)
      modal.querySelector('#fCancel').onclick = () => modal.remove()
      modal.querySelector('#fOk').onclick = async () => {
        modal.remove()
        try {
          await abs.removeFromCollection(b.dataset.col, b.dataset.rm)
          haptic.success()
          toast('已取消收藏')
          await go('favorites')
        } catch (err) { haptic.error(); toast('移除失败：' + err.message) }
      }
    }
  })

  updateMini()
}

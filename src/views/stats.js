/**
 * 收听统计页（家长用）
 *
 * 需求（老板原话）：统计当天听了哪个作品、听了多长时间，能看出
 * 「上午听了多久、下午听了多久」，粒度到**作品**，不到单集。
 * 将来家长要据此控制孩子听书时间，所以这里只做「如实呈现」，不做限制。
 *
 * 数据来自 lib/stats.js（本地记录，不上传服务器）。
 */
import { state, go, toast, esc, requireParentPin, updateMini } from '../app.js'
import { icon } from '../lib/icons.js'
import { haptic } from '../lib/haptics.js'
import {
  summaryByBook, summaryByPeriod, dayRecords, daysWithRecords,
  fmtDuration, fmtClock, PERIOD_LABEL, todayKey, clearAll,
} from '../lib/stats.js'

export async function renderStats(root, params = {}) {
  const kid = state.mode !== 'adult'
  const days = await daysWithRecords()
  const day = params.day || days[0] || todayKey()

  const [byBook, byPeriod, recs] = await Promise.all([
    summaryByBook(day), summaryByPeriod(day), dayRecords(day),
  ])
  const totalSec = recs.reduce((a, r) => a + r.sec, 0)

  const isToday = day === todayKey()
  // 时段顺序固定：上午 → 下午 → 晚上
  const periods = ['morning', 'afternoon', 'evening']

  root.innerHTML = `
    <div class="page-head">
      <button class="icon-btn" id="btnBack" aria-label="返回">${icon('back', 22)}</button>
      <div class="page-title">收听统计</div>
    </div>

    ${days.length > 1 ? `
      <div class="day-switch">
        ${days.slice(0, 14).map(d => `
          <button class="day-chip ${d === day ? 'active' : ''}" data-day="${d}">
            ${d === todayKey() ? '今天' : d.slice(5)}
          </button>`).join('')}
      </div>` : ''}

    <div class="stat-hero">
      <div class="stat-total">${fmtDuration(totalSec)}</div>
      <div class="stat-total-label">${isToday ? '今天共听' : day + ' 共听'}</div>
    </div>

    ${totalSec ? `
      <div class="section-h">分时段</div>
      <div class="settings-group">
        ${periods.map(p => {
          const sec = byPeriod[p] || 0
          const pct = totalSec ? Math.round((sec / totalSec) * 100) : 0
          return `<div class="stat-row">
            <div class="stat-row-label">${PERIOD_LABEL[p]}</div>
            <div class="stat-row-bar"><i style="width:${Math.max(pct, sec ? 2 : 0)}%"></i></div>
            <div class="stat-row-val">${sec ? fmtDuration(sec) : '—'}</div>
          </div>`
        }).join('')}
      </div>

      <div class="section-h">分作品 <small>${byBook.length} 本</small></div>
      <div class="settings-group">
        ${byBook.map(b => `
          <div class="stat-book">
            <div class="stat-book-head">
              <div class="stat-book-title">${esc(b.title || '未命名')}</div>
              <div class="stat-book-total">${fmtDuration(b.sec)}</div>
            </div>
            ${b.sessions.sort((x, y) => x.from - y.from).map(s => `
              <div class="stat-session">
                <span class="stat-session-time">${fmtClock(s.from)}</span>
                <span class="stat-session-period">${PERIOD_LABEL[s.period]}</span>
                <span class="stat-session-dur">${fmtDuration(s.sec)}</span>
              </div>`).join('')}
          </div>`).join('')}
      </div>
    ` : `
      <div class="empty" style="margin-top:40px">
        <div class="glyph">${icon('chart', 44)}</div>
        ${isToday ? '今天还没有收听记录' : '这天没有收听记录'}
      </div>`}

    <div class="hint" style="margin-top:16px">
      记录只存在这台手机上，只记作品名和时长，不记单集，也不上传服务器。
    </div>

    ${days.length ? `<div style="margin-top:10px">
      <button class="btn block ghost" id="btnClear" style="color:var(--danger)">清空全部统计</button>
    </div>` : ''}
  `

  const $ = s => root.querySelector(s)
  $('#btnBack').onclick = () => { haptic.tap(); go('settings') }

  // 切日期
  root.querySelectorAll('[data-day]').forEach(b => {
    b.onclick = () => { haptic.select(); go('stats', { day: b.dataset.day }) }
  })

  // 清空（要家长密码，避免孩子自己清掉记录把家长的监督抹了）
  const clearBtn = $('#btnClear')
  if (clearBtn) clearBtn.onclick = async () => {
    haptic.tap()
    if (state.kidPin) { if (!(await requireParentPin())) return }
    const modal = document.createElement('div')
    modal.className = 'lock'
    modal.innerHTML = `<div class="lock-card">
      <div class="lock-title">清空全部统计？</div>
      <div class="lock-sub">所有历史收听记录都会删掉，无法恢复。</div>
      <div class="lock-actions">
        <button class="btn ghost" id="cCancel">取消</button>
        <button class="btn danger" id="cOk">清空</button>
      </div>
    </div>`
    document.body.appendChild(modal)
    modal.querySelector('#cCancel').onclick = () => modal.remove()
    modal.querySelector('#cOk').onclick = async () => {
      modal.remove()
      await clearAll()
      haptic.success()
      toast('已清空')
      await go('stats')
    }
  }

  updateMini()
}

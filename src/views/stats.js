/**
 * 收听统计页（家长用）
 *
 * 需求（老板原话）：统计当天听了哪个作品、听了多长时间。
 * 2026-09-14 改版（老板反馈）：
 *  1. 分作品的每段收听**只显示具体时间**（如 09:30），去掉「上午/下午」文字 ——
 *     时间本身一眼就能看出上下午，写出来是废话。
 *  2. 日期切换改成「日历视图 + 前后箭头」：一天一个小卡片的日子太多时没法切。
 *     箭头 ±1 天连续点；点标题展开/收起月历，点某天直接跳到那天；
 *     点「今天」快速回今天。日历里有收听记录的日子有标记点。
 *
 * 数据来自 lib/stats.js（本地记录，不上传服务器）。
 */
import { goBack, state, go, toast, esc, requireParentPin, updateMini } from '../app.js'
import { icon } from '../lib/icons.js'
import { haptic } from '../lib/haptics.js'
import {
  summaryByBook, summaryByPeriod, dayRecords, daysWithRecords,
  fmtDuration, fmtClock, PERIOD_LABEL, todayKey, clearAll,
} from '../lib/stats.js'

/** 'YYYY-MM-DD' → 本地 Date（避免 new Date('YYYY-MM-DD') 被 当成 UTC） */
function parseDay(s) {
  const [y, m, d] = s.split('-').map(Number)
  return new Date(y, m - 1, d)
}
const pad = n => String(n).padStart(2, '0')
function dayKey(d) { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` }
const WD = ['日', '一', '二', '三', '四', '五', '六']

/** 人类可读日期：今天 / 昨天 / 9月12日 周六 */
function prettyDay(s) {
  const today = todayKey()
  const y = new Date(); y.setDate(y.getDate() - 1)
  if (s === today) return '今天'
  if (s === dayKey(y)) return '昨天'
  const d = parseDay(s)
  return `${d.getMonth() + 1}月${d.getDate()}日 周${WD[d.getDay()]}`
}

export async function renderStats(root, params = {}) {
  const days = await daysWithRecords()
  const day = params.day || days[0] || todayKey()
  const dayDate = parseDay(day)
  const isToday = day === todayKey()

  const [byBook, byPeriod, recs] = await Promise.all([
    summaryByBook(day), summaryByPeriod(day), dayRecords(day),
  ])
  const totalSec = recs.reduce((a, r) => a + r.sec, 0)
  // 时段顺序固定：上午 → 下午 → 晚上
  const periods = ['morning', 'afternoon', 'evening']
  // 有记录的日子集合（日历上的标记点）
  const daySet = new Set(days)
  // 日历初始月份 = 所看日子的月份
  let calYM = { y: dayDate.getFullYear(), m: dayDate.getMonth() }
  let calOpen = false

  root.innerHTML = `
    <div class="page-head">
      <button class="icon-btn" id="btnBack" aria-label="返回">${icon('back', 22)}</button>
      <div class="page-title">收听统计</div>
    </div>

    <div class="day-nav">
      <button class="day-arrow" id="dayPrev" aria-label="前一天">${icon('back', 20)}</button>
      <button class="day-cur" id="dayCur">
        <span class="day-cur-main">${prettyDay(day)}</span>
        <span class="day-cur-sub">${day}</span>
      </button>
      <button class="day-arrow" id="dayNext" aria-label="后一天">${icon('forward', 20)}</button>
    </div>
    <div id="calWrap"></div>

    <div class="stat-hero">
      <div class="stat-total">${fmtDuration(totalSec)}</div>
      <div class="stat-total-label">${isToday ? '今天共听' : prettyDay(day) + ' 共听'}</div>
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
                <span class="stat-session-dur">${fmtDuration(s.sec)}</span>
              </div>`).join('')}
          </div>`).join('')}
      </div>
    ` : `
      <div class="empty" style="margin-top:40px">
        <div class="glyph">${icon('chart', 44)}</div>
        ${isToday ? '今天还没有收听记录' : '这天没有收听记录'}
      </div>`}

    ${days.length ? `<div style="margin-top:10px">
      <button class="btn block ghost" id="btnClear" style="color:var(--danger)">清空全部统计</button>
    </div>` : ''}
  `

  const $ = s => root.querySelector(s)
  $('#btnBack').onclick = () => { haptic.tap(); goBack('parents') }

  // ---- 日期切换：前 / 后 ±1 天，可连点（老板原话：右边按钮可以连续切换到更往后的日子）----
  // 未来日期允许切换，只是那天还没有记录（页面显示"这天没有收听记录"）。
  const goDay = d => go('stats', { day: dayKey(d) })
  $('#dayPrev').onclick = () => { haptic.select(); const d = parseDay(day); d.setDate(d.getDate() - 1); goDay(d) }
  $('#dayNext').onclick = () => { haptic.select(); const d = parseDay(day); d.setDate(d.getDate() + 1); goDay(d) }

  // ---- 月历 ----
  const calWrap = $('#calWrap')
  function renderCalendar() {
    if (!calOpen) { calWrap.innerHTML = ''; return }
    const first = new Date(calYM.y, calYM.m, 1)
    const start = new Date(first)
    start.setDate(1 - first.getDay())                 // 周日开头
    const thisMonth = calYM.y === new Date().getFullYear() && calYM.m === new Date().getMonth()
    let cells = ''
    for (let i = 0; i < 42; i++) {
      const d = new Date(start); d.setDate(start.getDate() + i)
      const k = dayKey(d)
      const inMonth = d.getMonth() === calYM.m
      const future = k > todayKey()
      const has = daySet.has(k)
      cells += `<button class="cal-cell ${inMonth ? '' : 'out'} ${k === day ? 'sel' : ''} ${future ? 'dis' : ''}"
                     data-cal="${k}" ${future ? 'disabled' : ''}>
        <span class="cal-num">${d.getDate()}</span>${has ? '<i class="cal-dot"></i>' : ''}
      </button>`
    }
    calWrap.innerHTML = `
      <div class="cal">
        <div class="cal-head">
          <button class="cal-m-arrow" id="calPrevM" aria-label="上个月">${icon('back', 18)}</button>
          <div class="cal-title">${calYM.y}年${calYM.m + 1}月${thisMonth ? '（本月）' : ''}</div>
          <button class="cal-m-arrow" id="calNextM" aria-label="下个月">${icon('forward', 18)}</button>
        </div>
        <div class="cal-grid cal-wd">${WD.map(w => `<span class="cal-wd-h">${w}</span>`).join('')}</div>
        <div class="cal-grid">${cells}</div>
        <div class="cal-foot"><button class="cal-today" id="calToday">回到今天</button></div>
      </div>`
    calWrap.querySelectorAll('[data-cal]').forEach(b => {
      b.onclick = () => {
        if (b.classList.contains('dis')) return
        haptic.select(); go('stats', { day: b.dataset.cal })
      }
    })
    $('#calPrevM').onclick = () => { haptic.select(); calYM = shiftMonth(-1); renderCalendar() }
    $('#calNextM').onclick = () => { haptic.select(); calYM = shiftMonth(1); renderCalendar() }
    $('#calToday').onclick = () => { haptic.select(); go('stats', { day: todayKey() }) }
  }
  function shiftMonth(delta) {
    const d = new Date(calYM.y, calYM.m + delta, 1)
    return { y: d.getFullYear(), m: d.getMonth() }
  }
  $('#dayCur').onclick = () => {
    haptic.select()
    calOpen = !calOpen
    $('#dayCur').classList.toggle('open', calOpen)
    renderCalendar()
  }
  if (params.cal) { calOpen = true; $('#dayCur').classList.add('open') }
  renderCalendar()

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

/**
 * 家长设置页（需要家长密码才能进）
 *
 * 为什么单独拆一页：老板要求「把一些操控类的设置放到一个需要密码访问的设置项里」。
 * 这里放的是会改变 App 行为 / 家长才该碰的项：
 *   进度条口径、触感开关、收听统计、家长密码、服务器与账号。
 * 孩子日常用的（书架、找书、播放、缓存）不受影响。
 *
 * 密码策略：进页面前 requestPin 一次即可，本页内不再反复要密码
 * （同一页面里每点一项都弹密码会很烦）。
 */
import { abs } from '../lib/api.js'
import { store, CONFIG_KEYS } from '../lib/store.js'
import { state, go, toast, esc, requireParentPin, updateMini } from '../app.js'
import { icon } from '../lib/icons.js'
import { haptic, setHaptics, hapticsEnabled } from '../lib/haptics.js'
import { setNotificationMode } from '../lib/notification-prefs.js'
import { timeWindowLabel } from '../lib/parental.js'

export async function renderParent(root) {
  const scope = (await store.get(CONFIG_KEYS.progressScope, 'track')) === 'book' ? 'book' : 'track'
  // 老板 2026-09-15 新增：通知静默 / 音量上限 / 使用时间
  const quiet = (await store.get(CONFIG_KEYS.quietNotification, '0')) === '1'
  const cap = Number(await store.get(CONFIG_KEYS.volumeCap, '1'))
  const capPct = Math.round((Number.isFinite(cap) ? cap : 1) * 100)
  const limitOn = (await store.get(CONFIG_KEYS.timeLimitEnabled, '0')) === '1'
  const wdFrom = await store.get(CONFIG_KEYS.timeWeekdayFrom, '')
  const wdTo = await store.get(CONFIG_KEYS.timeWeekdayTo, '')
  const weFrom = await store.get(CONFIG_KEYS.timeWeekendFrom, '')
  const weTo = await store.get(CONFIG_KEYS.timeWeekendTo, '')
  const dailyMin = Number(await store.get(CONFIG_KEYS.timeDailyMinutes, '0')) || 0
  // ⚠️ 必须每次重新读 store，不能用闭包里的渲染期变量 ——
  // 保存后立刻刷新摘要时，闭包里的还是旧值（"保存了但显示没变"）。
  const fmtLimit = async () => {
    const on = (await store.get(CONFIG_KEYS.timeLimitEnabled, '0')) === '1'
    if (!on) return '未开启'
    const win = await timeWindowLabel()
    const dm = Number(await store.get(CONFIG_KEYS.timeDailyMinutes, '0')) || 0
    const dur = dm > 0 ? `每天最多 ${dm} 分钟` : '不限时长'
    return `${win} · ${dur}`
  }

  root.innerHTML = `
    <div class="page-head">
      <button class="icon-btn" id="btnBack" aria-label="返回">${icon('back', 22)}</button>
      <div class="page-title">家长设置</div>
    </div>

    <div class="section-h">播放控制</div>
    <div class="settings-group">
      <div class="setting-row" id="rowScope">
        <div class="setting-ic">${icon('chart', 22)}</div>
        <div class="setting-main">
          <div class="setting-label">进度条显示</div>
          <div class="setting-value" id="scopeVal">${scope === 'book' ? '整部作品的进度' : '当前这一集的进度（默认）'}</div>
        </div>
        <div class="setting-arrow">${icon('forward', 20)}</div>
      </div>
      <div class="setting-row" id="rowHaptics">
        <div class="setting-ic">${icon('sparkle', 22)}</div>
        <div class="setting-main">
          <div class="setting-label">触感反馈</div>
          <div class="setting-value" id="hapVal">${hapticsEnabled() ? '已开启' : '已关闭'}</div>
        </div>
        <div class="setting-arrow">${icon('forward', 20)}</div>
      </div>
    </div>

    <div class="section-h">收听监督</div>
    <div class="settings-group">
      <div class="setting-row" id="rowStats">
        <div class="setting-ic">${icon('chart', 22)}</div>
        <div class="setting-main">
          <div class="setting-label">收听统计</div>
          <div class="setting-value">收听记录</div>
        </div>
        <div class="setting-arrow">${icon('forward', 20)}</div>
      </div>
      <div class="setting-row" id="rowNotif">
        <div class="setting-ic">${icon('bell', 22)}</div>
        <div class="setting-main">
          <div class="setting-label">播放通知</div>
          <div class="setting-value" id="notifVal">${quiet ? '静默（锁屏控制保留）' : '显示常驻通知'}</div>
        </div>
        <div class="setting-arrow">${icon('forward', 20)}</div>
      </div>
      <div class="setting-row" id="rowCap">
        <div class="setting-ic">${icon('sparkle', 22)}</div>
        <div class="setting-main">
          <div class="setting-label">音量上限</div>
          <div class="setting-value" id="capVal">${capPct >= 100 ? '不限制' : '最高 ' + capPct + '%'}</div>
        </div>
        <div class="setting-arrow">${icon('forward', 20)}</div>
      </div>
      <div class="setting-row" id="rowTime">
        <div class="setting-ic">${icon('clock', 22)}</div>
        <div class="setting-main">
          <div class="setting-label">收听时间</div>
          <div class="setting-value" id="timeVal">加载中…</div>
        </div>
        <div class="setting-arrow">${icon('forward', 20)}</div>
      </div>
      <div class="setting-row" id="rowPin">
        <div class="setting-ic">${icon('lock', 22)}</div>
        <div class="setting-main">
          <div class="setting-label">${state.kidPin ? '修改家长密码' : '设置家长密码'}</div>
          <div class="setting-value">${state.kidPin ? '已设置' : '未设置'}</div>
        </div>
        <div class="setting-arrow">${icon('forward', 20)}</div>
      </div>
    </div>

    <div class="section-h">服务器</div>
    <div class="settings-group">
      <div class="setting-row" id="rowReload">
        <div class="setting-ic">${icon('refresh', 22)}</div>
        <div class="setting-main">
          <div class="setting-label">刷新书库</div>
        </div>
        <div class="setting-arrow">${icon('forward', 20)}</div>
      </div>
    </div>
  `

  const $ = s => root.querySelector(s)
  $('#btnBack').onclick = () => { haptic.tap(); go('settings') }

  $('#rowScope').onclick = async () => {
    haptic.select()
    const cur = (await store.get(CONFIG_KEYS.progressScope, 'track'))
    const next = cur === 'book' ? 'track' : 'book'
    await store.set(CONFIG_KEYS.progressScope, next)
    $('#scopeVal').textContent = next === 'book' ? '整部作品的进度' : '当前这一集的进度（默认）'

  }

  $('#rowHaptics').onclick = async () => {
    const next = !hapticsEnabled()
    await setHaptics(next)
    $('#hapVal').textContent = next ? '已开启：按按钮时轻微震动' : '已关闭'
    if (next) haptic.tap()

  }

  // 收听时间：显示当前配置（异步读，避免阻塞渲染）
  fmtLimit().then(t => { const el = $('#timeVal'); if (el) el.textContent = t }).catch(() => {})

  // 播放通知：normal ⇄ quiet（锁屏控制始终保留，只静默"常驻通知"）
  $('#rowNotif').onclick = async () => {
    haptic.select()
    const next = !((await store.get(CONFIG_KEYS.quietNotification, '0')) === '1')
    await store.set(CONFIG_KEYS.quietNotification, next ? '1' : '0')
    await setNotificationMode(next ? 'quiet' : 'normal')
    $('#notifVal').textContent = next ? '静默（锁屏控制保留）' : '显示常驻通知'
    toast(next ? '已静默播放通知（锁屏控制仍在）' : '已恢复显示播放通知')
  }

  // 音量上限：60% → 80% → 100% 三档循环（孩子够不着系统音量，App 内封顶）
  $('#rowCap').onclick = async () => {
    haptic.select()
    const cur = Math.round(Number(await store.get(CONFIG_KEYS.volumeCap, '1')) * 100)
    const next = cur >= 100 ? 60 : (cur >= 80 ? 100 : 80)
    await store.set(CONFIG_KEYS.volumeCap, String(next / 100))
    $('#capVal').textContent = next >= 100 ? '不限制' : '最高 ' + next + '%'
    // 立刻作用到当前播放（把音量压到上限内）
    try { await state.player?.setVolume(state.player._volume ?? 1) } catch (_) {}
    toast(next >= 100 ? '音量不限制' : `音量最高 ${next}%`)
  }

  $('#rowTime').onclick = () => { haptic.tap(); openTimeDialog() }

  $('#rowStats').onclick = () => { haptic.tap(); go('stats') }
  $('#rowPin').onclick = () => { haptic.tap(); openPinDialog() }

  $('#rowReload').onclick = async () => {
    haptic.tap()
    try {
      state.libraries = await abs.libraries()
      state.libraryId = state.libraries[0]?.id || null
      toast('书库已刷新')
    } catch (e) { toast('刷新失败：' + e.message) }
  }

  /**
   * 收听时间设置弹窗（老板 2026-09-15）
   * 工作日（周一~五）与周末分开设允许时段，支持跨午夜（如 20:00–07:00）；
   * 另有"每天最多听多久"。留空 = 不限制对应维度。
   */
  function openTimeDialog() {
    const modal = document.createElement('div')
    modal.className = 'lock'
    modal.innerHTML = `<div class="lock-card" style="max-height:86vh;overflow-y:auto">
      <div class="lock-title">收听时间</div>
      <div class="lock-sub">设好后，不在时段内或时长用完时将自动停止播放</div>

      <div style="display:flex;align-items:center;gap:10px;margin:14px 0 6px">
        <label style="display:flex;align-items:center;gap:8px;font-size:15px">
          <input type="checkbox" id="tEnabled" ${limitOn ? 'checked' : ''} style="width:18px;height:18px">
          开启时间限制
        </label>
      </div>

      <div style="font-size:13px;color:var(--text-dim);margin:10px 0 4px">周一至周五（上学日）</div>
      <div style="display:flex;gap:8px;align-items:center">
        <input class="lock-input" id="tWdFrom" type="time" value="${wdFrom}" style="flex:1;margin:0">
        <span style="color:var(--text-dim)">至</span>
        <input class="lock-input" id="tWdTo" type="time" value="${wdTo}" style="flex:1;margin:0">
      </div>

      <div style="font-size:13px;color:var(--text-dim);margin:10px 0 4px">周末（周六、周日）</div>
      <div style="display:flex;gap:8px;align-items:center">
        <input class="lock-input" id="tWeFrom" type="time" value="${weFrom}" style="flex:1;margin:0">
        <span style="color:var(--text-dim)">至</span>
        <input class="lock-input" id="tWeTo" type="time" value="${weTo}" style="flex:1;margin:0">
      </div>
      <div style="font-size:12px;color:var(--text-dim);margin-top:4px">时段留空表示当天不限时间；结束时间小于开始时间会按"跨到第二天"处理</div>

      <div style="font-size:13px;color:var(--text-dim);margin:10px 0 4px">每天最多听</div>
      <div style="display:flex;gap:8px;align-items:center">
        <input class="lock-input" id="tDaily" type="number" inputmode="numeric" min="0" max="480" step="5"
               value="${dailyMin || ''}" placeholder="不限" style="flex:1;margin:0">
        <span style="color:var(--text-dim)">分钟</span>
      </div>
      <div style="font-size:12px;color:var(--text-dim);margin-top:4px">按实际收听时长累计（暂停不计时），留空或 0 表示不限</div>

      <div class="lock-err" id="tErr"></div>
      <div class="lock-actions">
        <button class="btn ghost" id="tCancel">取消</button>
        <button class="btn" id="tSave">保存</button>
      </div>
    </div>`
    document.body.appendChild(modal)
    const errEl = modal.querySelector('#tErr')
    modal.querySelector('#tCancel').onclick = () => modal.remove()
    modal.querySelector('#tSave').onclick = async () => {
      const g = id => modal.querySelector('#' + id)
      const wdF = g('tWdFrom').value, wdT = g('tWdTo').value
      const weF = g('tWeFrom').value, weT = g('tWeTo').value
      const daily = Math.max(0, Math.min(480, Number(g('tDaily').value) || 0))
      // 校验：如果填了一边就必须填另一边（时段要成对）
      const pairs = [[wdF, wdT, '周一至周五'], [weF, weT, '周末']]
      for (const [a, b, name] of pairs) {
        if ((a && !b) || (!a && b)) { errEl.textContent = name + '的开始和结束时间要一起填'; return }
      }
      await store.set(CONFIG_KEYS.timeLimitEnabled, g('tEnabled').checked ? '1' : '0')
      await store.set(CONFIG_KEYS.timeWeekdayFrom, wdF)
      await store.set(CONFIG_KEYS.timeWeekdayTo, wdT)
      await store.set(CONFIG_KEYS.timeWeekendFrom, weF)
      await store.set(CONFIG_KEYS.timeWeekendTo, weT)
      await store.set(CONFIG_KEYS.timeDailyMinutes, String(daily))
      modal.remove()
      haptic.success()
      toast('收听时间已保存')
      const el = $('#timeVal')
      if (el) el.textContent = await fmtLimit()
    }
    setTimeout(() => modal.querySelector('#tEnabled').focus(), 100)
  }

  function openPinDialog() {
    const modal = document.createElement('div')
    modal.className = 'lock'
    modal.innerHTML = `<div class="lock-card">
      <div class="lock-title">${state.kidPin ? '修改家长密码' : '设置家长密码'}</div>
      <div class="lock-sub">4-6 位数字，别忘了</div>
      ${state.kidPin ? `<input class="lock-input" id="pinOld" type="text" inputmode="numeric" autocomplete="off" maxlength="6" pattern="[0-9]*" placeholder="当前密码" style="margin-bottom:10px">` : ''}
      <input class="lock-input" id="pin1" type="text" inputmode="numeric" autocomplete="off" maxlength="6" pattern="[0-9]*" placeholder="新密码">
      <input class="lock-input" id="pin2" type="text" inputmode="numeric" autocomplete="off" maxlength="6" pattern="[0-9]*" placeholder="再输一次" style="margin-top:10px">
      <div class="lock-err" id="pinErr"></div>
      <div class="lock-actions">
        <button class="btn ghost" id="pinCancel">取消</button>
        <button class="btn" id="pinSave">保存</button>
      </div>
    </div>`
    document.body.appendChild(modal)

    const errEl = modal.querySelector('#pinErr')
    modal.querySelector('#pinCancel').onclick = () => modal.remove()
    modal.querySelector('#pinSave').onclick = async () => {
      const oldPin = modal.querySelector('#pinOld')?.value
      const a = modal.querySelector('#pin1').value.trim()
      const b = modal.querySelector('#pin2').value.trim()
      if (state.kidPin && oldPin !== state.kidPin) { errEl.textContent = '当前密码不对'; return }
      if (!/^\d{4,6}$/.test(a)) { errEl.textContent = '密码要 4-6 位数字'; return }
      if (a !== b) { errEl.textContent = '两次输入不一样'; return }
      state.kidPin = a
      await store.set(CONFIG_KEYS.kidPin, a)
      modal.remove()
      haptic.success()
      toast('家长密码已保存')
      await go('parents')
    }
    setTimeout(() => modal.querySelector('#pin1').focus(), 100)
  }

  updateMini()
}

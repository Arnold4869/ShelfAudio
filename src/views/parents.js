/**
 * 家长设置页（需要家长密码才能进）
 *
 * 为什么单独拆一页：老板要求「把一些操控类的设置放到一个需要密码访问的设置项里」。
 * 这里放的是会改变 App 行为 / 家长才该碰的项。
 *
 * 2026-09-14 改版（老板四点反馈）：
 *  1. 音量上限改成滑杆（滚轮式精细调节，5% 步进），不再 60/80/不限 三档循环
 *  2. 收听时间从「小弹窗」改成**全屏子页**：弹窗在小屏上显示不全（time 输入框
 *     被密码框的大字号样式污染）且没有返回键 —— 全屏页自带返回，内容自适应
 *  3. 时段限制 / 每日时长限制**各自独立开关**（老板原话「只要有一个限制，
 *     就可以限制 app 不能使用」）
 *  4. 语音搜索按钮显隐从普通设置页挪到家长设置（孩子自己就能把语音开回来不合理）
 */
import { hub as abs } from '../lib/servers.js'   // 多源门面：按 id 前缀分派 ABS / Navidrome
import { store, CONFIG_KEYS } from '../lib/store.js'
import { goBack, state, go, toast, esc, requireParentPin, updateMini } from '../app.js'
import { icon } from '../lib/icons.js'
import { haptic, setHaptics, hapticsEnabled } from '../lib/haptics.js'
import { setNotificationMode } from '../lib/notification-prefs.js'
import { timeWindowEnabled, dailyLimitEnabled, timeWindowLabel, volumeCap, volumeCapLabel } from '../lib/parental.js'
import { voiceHidden, setVoiceHidden } from '../lib/ui-prefs.js'
import { t } from '../lib/terms.js'

export async function renderParent(root) {
  const scope = (await store.get(CONFIG_KEYS.progressScope, 'track')) === 'book' ? 'book' : 'track'
  const quiet = (await store.get(CONFIG_KEYS.quietNotification, '0')) === '1'
  const cap = await volumeCap()
  // ⚠️ 收听时间的开关/时段**不在这里读**：openTimePage() 每次打开时重新读 store
  //（闭包变量在保存后不会刷新，会导致重开显示旧配置 —— 见 openTimePage 注释）。
  // ⚠️ 必须每次重新读 store，不能用闭包里的渲染期变量 ——
  // 保存后立刻刷新摘要时，闭包里的还是旧值（"保存了但显示没变"）。
  const fmtLimit = async () => {
    const parts = []
    if (await timeWindowEnabled()) parts.push(`时段 ${await timeWindowLabel()}`)
    const dm = Number(await store.get(CONFIG_KEYS.timeDailyMinutes, '0')) || 0
    if (await dailyLimitEnabled() && dm > 0) parts.push(`每天最多 ${dm} 分钟`)
    return parts.length ? parts.join(' · ') : '未开启'
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
      <div class="setting-row" id="rowVoice">
        <div class="setting-ic">${icon('mic', 22)}</div>
        <div class="setting-main">
          <div class="setting-label">语音搜索按钮</div>
          <div class="setting-value" id="voiceVal">${voiceHidden() ? '已隐藏' : '已显示'}</div>
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
    </div>

    <!-- 音量上限：滑杆直接嵌在页面上（滚轮式精细调节），不再弹窗三档循环 -->
    <div class="settings-group cap-group">
      <div class="cap-head">
        <div class="setting-ic">${icon('sparkle', 22)}</div>
        <div class="setting-main">
          <div class="setting-label">音量上限</div>
          <div class="setting-value" id="capVal">${volumeCapLabel(cap)}</div>
        </div>
        <div class="cap-pct" id="capPct">${Math.round(cap * 100)}%</div>
      </div>
      <div class="cap-slider-row">
        <input type="range" id="capSlider" min="10" max="100" step="5" value="${Math.round(cap * 100)}"
               aria-label="音量上限百分比">
      </div>
      <div class="cap-scale"><span>10%</span><span>100% = 不限制</span></div>
    </div>

    <div class="settings-group">
      <div class="setting-row" id="rowTime">
        <div class="setting-ic">${icon('clock', 22)}</div>
        <div class="setting-main">
          <div class="setting-label">收听时间</div>
          <div class="setting-value" id="timeVal">加载中…</div>
        </div>
        <div class="setting-arrow">${icon('forward', 20)}</div>
      </div>
    </div>

    <div class="settings-group">
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
  $('#btnBack').onclick = () => { haptic.tap(); goBack('settings') }

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
    $('#hapVal').textContent = next ? '已开启' : '已关闭'
    if (next) haptic.tap()
  }

  // 语音搜索按钮显隐（2026-09-14 从设置页挪进家长设置）
  $('#rowVoice').onclick = async () => {
    haptic.select()
    const next = !voiceHidden()
    await setVoiceHidden(next)
    $('#voiceVal').textContent = next ? '已隐藏' : '已显示'
    // 已经在页面上的语音按钮立即跟着变，不用等重进页面
    document.querySelectorAll('.voice-fab, .search-mic').forEach(el => {
      el.style.display = next ? 'none' : ''
    })
    toast(next ? '已隐藏语音按钮' : '已显示语音按钮')
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

  // 音量上限滑杆：5% 步进，松手才落盘（拖动过程只改显示，避免连续写 Preferences）
  {
    const slider = $('#capSlider')
    let dragging = false
    slider.addEventListener('input', () => {
      dragging = true
      const pct = Number(slider.value)
      $('#capPct').textContent = pct + '%'
      $('#capVal').textContent = pct >= 100 ? '不限制' : `最高 ${pct}%`
    })
    const commit = async () => {
      if (!dragging) return
      dragging = false
      const pct = Number(slider.value)
      await store.set(CONFIG_KEYS.volumeCap, String(pct / 100))
      haptic.select()
      try { await state.player?.reapplyVolumeCap() } catch (_) {}
    }
    slider.addEventListener('change', commit)
    slider.addEventListener('touchend', commit)
  }

  // 收听时间 → 全屏子页（弹窗在小屏显示不全且没有返回键，2026-09-14 改版）
  $('#rowTime').onclick = () => { haptic.tap(); openTimePage() }

  $('#rowStats').onclick = () => { haptic.tap(); go('stats') }
  $('#rowPin').onclick = () => { haptic.tap(); openPinDialog() }

  $('#rowReload').onclick = async () => {
    haptic.tap()
    try {
      state.libraries = await abs.libraries()
      state.libraryId = state.libraries[0]?.id || null
      toast(t('library') + '已刷新')
    } catch (e) { toast('刷新失败：' + e.message) }
  }

  /**
   * 收听时间设置（全屏子页，替代旧弹窗 —— 老板 2026-09-14：
   * 「显示有点问题，有些显示不全」+「还没有返回按钮」）。
   * 时段限制 / 每日时长限制各自独立开关：开哪个哪个生效。
   *
   * ⚠️ 必须在打开时**重新读 store**，不能用 renderParent 渲染期的闭包变量 ——
   * 保存后不重渲染本页，闭包里的值还是打开前的旧值（再打开显示旧配置，
   * 实测踩到：保存过"只开时段"，重开却显示两个开关都关着）。
   */
  async function openTimePage() {
    const winNow = await timeWindowEnabled()
    const durNow = await dailyLimitEnabled()
    const wdF = await store.get(CONFIG_KEYS.timeWeekdayFrom, '')
    const wdT = await store.get(CONFIG_KEYS.timeWeekdayTo, '')
    const weF = await store.get(CONFIG_KEYS.timeWeekendFrom, '')
    const weT = await store.get(CONFIG_KEYS.timeWeekendTo, '')
    const dMin = Number(await store.get(CONFIG_KEYS.timeDailyMinutes, '0')) || 0

    const page = document.createElement('div')
    page.className = 'subpage'
    page.innerHTML = `
      <div class="page-head">
        <button class="icon-btn" id="tBack" aria-label="返回">${icon('back', 22)}</button>
        <div class="page-title">收听时间</div>
      </div>

      <div class="settings-group">
        <div class="switch-row">
          <div class="setting-main">
            <div class="setting-label">限制收听时段</div>
            <div class="setting-value" id="tWinHint">只在允许的时间段内可以听</div>
          </div>
          <label class="sa-switch"><input type="checkbox" id="tWinOn" ${winNow ? 'checked' : ''}><i></i></label>
        </div>
        <div id="tWinBody" style="${winNow ? '' : 'display:none'}">
          <div class="time-block">
            <div class="time-block-h">周一至周五（上学日）</div>
            <div class="time-pair">
              <input class="time-input" id="tWdFrom" type="time" value="${wdF}">
              <span class="time-sep">至</span>
              <input class="time-input" id="tWdTo" type="time" value="${wdT}">
            </div>
          </div>
          <div class="time-block">
            <div class="time-block-h">周末（周六、周日）</div>
            <div class="time-pair">
              <input class="time-input" id="tWeFrom" type="time" value="${weF}">
              <span class="time-sep">至</span>
              <input class="time-input" id="tWeTo" type="time" value="${weT}">
            </div>
          </div>
          <div class="time-hint">时段留空 = 当天不限时间；结束时间小于开始时间按"跨到第二天"算</div>
        </div>
      </div>

      <div class="settings-group">
        <div class="switch-row">
          <div class="setting-main">
            <div class="setting-label">限制每天总时长</div>
            <div class="setting-value" id="tDurHint">按实际收听时长累计，暂停不计时</div>
          </div>
          <label class="sa-switch"><input type="checkbox" id="tDurOn" ${durNow ? 'checked' : ''}><i></i></label>
        </div>
        <div id="tDurBody" style="${durNow ? '' : 'display:none'}">
          <div class="time-block">
            <div class="time-block-h">每天最多听</div>
            <div class="time-pair">
              <input class="time-input time-input-num" id="tDaily" type="number" inputmode="numeric"
                     min="0" max="1440" step="5" value="${dMin || ''}" placeholder="不限">
              <span class="time-sep">分钟</span>
            </div>
          </div>
          <div class="time-hint">时长用完后当天不能再播，第二天自动恢复</div>
        </div>
      </div>

      <div style="padding:0 18px">
        <button class="btn block" id="tSave">保存</button>
      </div>
    `
    document.body.appendChild(page)

    const $p = s => page.querySelector(s)
    $p('#tBack').onclick = () => { haptic.tap(); page.remove() }

    // 开关联动显示对应配置块
    $p('#tWinOn').onchange = () => { $p('#tWinBody').style.display = $p('#tWinOn').checked ? '' : 'none' }
    $p('#tDurOn').onchange = () => { $p('#tDurBody').style.display = $p('#tDurOn').checked ? '' : 'none' }

    $p('#tSave').onclick = async () => {
      const winOn = $p('#tWinOn').checked
      const durOn = $p('#tDurOn').checked
      const wdF = $p('#tWdFrom').value, wdT = $p('#tWdTo').value
      const weF = $p('#tWeFrom').value, weT = $p('#tWeTo').value
      const daily = Math.max(0, Math.min(1440, Number($p('#tDaily').value) || 0))
      if (winOn) {
        // 校验：如果填了一边就必须填另一边（时段要成对）
        const pairs = [[wdF, wdT, '周一至周五'], [weF, weT, '周末']]
        for (const [a, b, name] of pairs) {
          if ((a && !b) || (!a && b)) { toast(name + '的开始和结束时间要一起填'); return }
        }
        // ⚠️ 必须校验**表单里的新值**，不能查 store：
        // store 里还没保存的值是空的，用 hasTimeWindowConfig() 会把
        // "第一次就填好时段并保存"误判成"没填"而拦下（实测踩到）。
        const filled = [[wdF, wdT], [weF, weT]].some(([a, b]) => a && b)
        if (!filled) { toast('开了时段限制就至少要填一个时段'); return }
      }
      if (durOn && daily <= 0) { toast('开了时长限制就要填每天最多听多少分钟'); return }
      // 两个限制各自独立开关（老总开关保留兼容读，不再写入）
      await store.set(CONFIG_KEYS.timeWindowEnabled, winOn ? '1' : '0')
      await store.set(CONFIG_KEYS.dailyLimitEnabled, durOn ? '1' : '0')
      await store.set(CONFIG_KEYS.timeWeekdayFrom, wdF)
      await store.set(CONFIG_KEYS.timeWeekdayTo, wdT)
      await store.set(CONFIG_KEYS.timeWeekendFrom, weF)
      await store.set(CONFIG_KEYS.timeWeekendTo, weT)
      await store.set(CONFIG_KEYS.timeDailyMinutes, String(daily))
      haptic.success()
      toast('收听时间已保存')
      page.remove()
      const el = $('#timeVal')
      if (el) el.textContent = await fmtLimit()
    }
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

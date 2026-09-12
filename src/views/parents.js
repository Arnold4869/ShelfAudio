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

export async function renderParent(root) {
  const scope = (await store.get(CONFIG_KEYS.progressScope, 'track')) === 'book' ? 'book' : 'track'

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

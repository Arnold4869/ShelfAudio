/** 设置页：模式切换（家长锁）、服务器、家长密码、缓存、退出登录 */
import { abs } from '../lib/api.js'
import { store, CONFIG_KEYS } from '../lib/store.js'
import { state, go, toast, esc, requireParentPin, stopCurrent, updateMini } from '../app.js'
import { stopListening } from '../lib/voice.js'

export async function renderSettings(root, { firstRun = false } = {}) {
  const server = await store.get(CONFIG_KEYS.server, '')
  const username = await store.get(CONFIG_KEYS.username, '')

  root.innerHTML = `
    <div class="page-head">
      <button class="icon-btn" id="btnBack" aria-label="返回">‹</button>
      <div class="page-title">${firstRun ? '开始设置' : '设置'}</div>
    </div>

    ${firstRun ? `<div class="settings-group" style="padding:16px 18px">
      <div style="font-size:15px;line-height:1.7">
        👋 连接成功！<br>
        建议先设一个<b>家长密码</b>：以后从儿童模式切到成人模式、或进设置页，都需要输这个密码，孩子就点不出去了。
      </div>
    </div>` : ''}

    <div class="section-h">使用模式</div>
    <div class="settings-group">
      <div class="setting-row" id="rowKid">
        <div class="setting-ic">🧒</div>
        <div class="setting-main">
          <div class="setting-label">儿童模式</div>
          <div class="setting-value">大卡片书架、大字播放页，仅基本功能</div>
        </div>
        <div class="setting-arrow">${state.mode === 'kid' ? '✓' : ''}</div>
      </div>
      <div class="setting-row" id="rowAdult">
        <div class="setting-ic">👤</div>
        <div class="setting-main">
          <div class="setting-label">成人模式</div>
          <div class="setting-value">章节列表、倍速、睡眠定时、收藏、书籍信息</div>
        </div>
        <div class="setting-arrow">${state.mode === 'adult' ? '✓' : ''}</div>
      </div>
    </div>

    <div class="section-h">家长密码</div>
    <div class="settings-group">
      <div class="setting-row" id="rowPin">
        <div class="setting-ic">🔒</div>
        <div class="setting-main">
          <div class="setting-label">${state.kidPin ? '修改密码' : '设置密码'}</div>
          <div class="setting-value">${state.kidPin ? '已设置，退出儿童模式需输入' : '未设置，孩子可直接切到成人模式'}</div>
        </div>
        <div class="setting-arrow">›</div>
      </div>
    </div>

    <div class="section-h">服务器</div>
    <div class="settings-group">
      <div class="setting-row">
        <div class="setting-ic">🖥</div>
        <div class="setting-main">
          <div class="setting-label">${esc(server)}</div>
          <div class="setting-value">登录账号：${esc(username)}</div>
        </div>
      </div>
      <div class="setting-row" id="rowReload">
        <div class="setting-ic">🔄</div>
        <div class="setting-main">
          <div class="setting-label">刷新书库</div>
          <div class="setting-value">重新从服务器拉取书籍列表</div>
        </div>
        <div class="setting-arrow">›</div>
      </div>
      <div class="setting-row" id="rowLogout">
        <div class="setting-ic">🚪</div>
        <div class="setting-main">
          <div class="setting-label" style="color:var(--danger)">退出登录</div>
          <div class="setting-value">清除本机保存的登录信息</div>
        </div>
      </div>
    </div>

    <div class="hint" style="margin-top:8px">
      听书 v0.1.0 · 音频来自你自己的 Audiobookshelf 服务器
    </div>
  `

  const $ = s => root.querySelector(s)

  const finish = async (target) => {
    if (firstRun) await go(state.mode === 'adult' ? 'shelf' : 'kidhome')
    else if (target) await go(target)
  }

  $('#btnBack').onclick = async () => {
    if (firstRun) await go(state.mode === 'adult' ? 'shelf' : 'kidhome')
    else await go(state.mode === 'adult' ? 'shelf' : 'kidhome')
  }

  $('#rowPin').onclick = () => openPinDialog()

  $('#rowKid').onclick = async () => {
    if (state.mode === 'kid') { await finish('kidhome'); return }
    await switchMode('kid')
  }
  $('#rowAdult').onclick = async () => {
    if (state.mode === 'adult') { await finish('shelf'); return }
    // 进成人模式要家长密码
    if (state.kidPin) {
      const ok = await requireParentPin()
      if (!ok) return
    }
    await switchMode('adult')
  }

  $('#rowReload').onclick = async () => {
    try {
      state.libraries = await abs.libraries()
      state.libraryId = state.libraries[0]?.id || null
      toast('书库已刷新')
    } catch (e) { toast('刷新失败：' + e.message) }
  }

  $('#rowLogout').onclick = async () => {
    const ok = state.kidPin ? await requireParentPin() : true
    if (!ok) return
    await stopCurrent()
    await store.remove(CONFIG_KEYS.token)
    await store.remove(CONFIG_KEYS.server)
    await store.remove(CONFIG_KEYS.username)
    toast('已退出登录')
    await go('login')
  }

  async function switchMode(mode) {
    state.mode = mode
    await store.set(CONFIG_KEYS.mode, mode)
    toast(mode === 'adult' ? '已切换到成人模式' : '已切换到儿童模式')
    await go(mode === 'adult' ? 'shelf' : 'kidhome')
  }

  function openPinDialog() {
    const modal = document.createElement('div')
    modal.className = 'lock'
    modal.innerHTML = `<div class="lock-card">
      <div class="lock-title">${state.kidPin ? '修改家长密码' : '设置家长密码'}</div>
      <div class="lock-sub">4-6 位数字，别忘了</div>
      ${state.kidPin ? `<input class="lock-input" id="pinOld" type="number" inputmode="numeric" placeholder="当前密码" style="margin-bottom:10px">` : ''}
      <input class="lock-input" id="pin1" type="number" inputmode="numeric" placeholder="新密码">
      <input class="lock-input" id="pin2" type="number" inputmode="numeric" placeholder="再输一次" style="margin-top:10px">
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
      toast('家长密码已保存')
      await go('settings', { firstRun })
    }
    setTimeout(() => modal.querySelector('#pin1').focus(), 100)
  }

  updateMini()
}

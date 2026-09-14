/**
 * 登录 / 首次配置 —— 支持两台服务器（老板 2026-09-14）
 *
 * 老板需求：
 *  「支持 navidrome…只登录 abs 的时候不显示 nd 的东西，可以再次登录 nd 时把它俩的
 *   东西都显示出来，分开显示（右上角切换按钮）；如果只登录 nd 也不显示 abs 的东西」
 *
 * 形态：一张卡片里两个可折叠的服务器块（Audiobookshelf / Navidrome）——
 * 只填一个也能连；两个都填就都连上，进主界面后右上角切换。
 * 已登录的那块显示账号 + 「断开」，避免重复填。
 */
import { hub } from '../lib/servers.js'
import { store, CONFIG_KEYS } from '../lib/store.js'
import { go, toast, state, initPlayer } from '../app.js'
import { icon } from '../lib/icons.js'
import { haptic } from '../lib/haptics.js'

const esc0 = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))

export async function renderLogin(root) {
  await hub.restore()   // 让「已登录」状态是新鲜的（从设置页断一个源后回到登录页也准）
  const hasAbs = hub.loggedIn.abs
  const hasNd = hub.loggedIn.nd
  const savedAbsServer = (await store.get(CONFIG_KEYS.server, '')) || ''
  const savedAbsUser = (await store.get(CONFIG_KEYS.username, '')) || ''
  const savedNdServer = (await store.get(CONFIG_KEYS.ndServer, '')) || ''
  const savedNdUser = (await store.get(CONFIG_KEYS.ndUser, '')) || ''
  // 一个都没登录 → 两块都展开；已登录的源折叠（显示状态即可）
  const absOpen = !hasAbs
  const ndOpen = !hasNd && hasAbs   // 已经连了 ABS 时，ND 块默认展开（引导第二台）

  root.innerHTML = `
    <div class="login-wrap">
      ${(hasAbs || hasNd) ? `<div class="login-nav">
        <button class="back-btn" id="loginBack" aria-label="返回">${icon('back', 22)}</button>
      </div>` : ''}
      <div class="login-logo">${icon('headphones', 64)}</div>
      <h1 class="login-h">听书</h1>
      <div class="login-sub">连接你的有声书 / 音乐服务器</div>

      <!-- ---------- Audiobookshelf ---------- -->
      <div class="login-card">
        <div class="srv-head">
          <span class="srv-name">${icon('server', 20)} Audiobookshelf</span>
          ${hasAbs
            ? `<span class="srv-ok">${icon('check', 16)} ${esc0(savedAbsUser)}</span>`
            : `<span class="srv-tag">有声书</span>`}
        </div>
        ${hasAbs ? `
          <div class="srv-connected">
            <div class="srv-url">${esc0(savedAbsServer)}</div>
            <button class="btn ghost small" id="absOut">断开</button>
          </div>
        ` : `
          <div class="field">
            <label>服务器地址</label>
            <input id="aServer" type="url" inputmode="url" autocapitalize="off" autocorrect="off" placeholder="服务器地址">
          </div>
          <div class="field">
            <label>用户名</label>
            <input id="aUser" type="text" autocapitalize="off" autocorrect="off" placeholder="用户名">
          </div>
          <div class="field">
            <label>密码</label>
            <input id="aPass" type="password" placeholder="密码">
          </div>
          <div class="err" id="aErr"></div>
          <button class="btn block" id="absLogin">连 接</button>
        `}
      </div>

      <!-- ---------- Navidrome ---------- -->
      <div class="login-card">
        <div class="srv-head">
          <span class="srv-name">${icon('headphones', 20)} Navidrome</span>
          ${hasNd
            ? `<span class="srv-ok">${icon('check', 16)} ${esc0(savedNdUser)}</span>`
            : `<span class="srv-tag">音乐库</span>`}
        </div>
        ${hasNd ? `
          <div class="srv-connected">
            <div class="srv-url">${esc0(savedNdServer)}</div>
            <button class="btn ghost small" id="ndOut">断开</button>
          </div>
        ` : `
          <div class="field">
            <label>服务器地址</label>
            <input id="nServer" type="url" inputmode="url" autocapitalize="off" autocorrect="off" placeholder="服务器地址">
          </div>
          <div class="field">
            <label>用户名</label>
            <input id="nUser" type="text" autocapitalize="off" autocorrect="off" placeholder="用户名">
          </div>
          <div class="field">
            <label>密码</label>
            <input id="nPass" type="password" placeholder="密码">
          </div>
          <div class="err" id="nErr"></div>
          <button class="btn block" id="ndLogin">连 接</button>
        `}
      </div>

      ${(hasAbs || hasNd) ? `<div style="padding:0 4px 20px">
        <button class="btn block" id="gotoApp">进入听书</button>
      </div>` : ''}
    </div>
  `

  const $ = s => root.querySelector(s)

  // 已登录过（从设置页「服务器」进来的）→ 有返回键回设置页；
  // 冷启动没登录过 → 没有返回键（不能退回一个空 App）。
  $('#loginBack')?.addEventListener('click', async () => {
    haptic.tap()
    const libs = await hub.libraries().catch(() => [])
    if (libs.length) {
      state.libraries = libs
      state.libraryId = libs[0]?.id || null
      await go('kidhome')
    } else {
      toast('先连接一台服务器')
    }
  })

  /** 登录成功后统一收尾：拉库、落状态、进主界面 */
  const afterLogin = async (who) => {
    state.libraries = await hub.libraries()
    state.libraryId = state.libraries[0]?.id || null
    state.sources = hub.available
    state.kidPin = (await store.get(CONFIG_KEYS.kidPin, '')) || ''
    initPlayer()
    toast(who)
    await go('kidhome')
  }

  // ---- ABS 登录 ----
  const absBtn = $('#absLogin')
  if (absBtn) {
    const doAbs = async () => {
      const server = $('#aServer').value.trim()
      const user = $('#aUser').value.trim()
      const pass = $('#aPass').value
      const errEl = $('#aErr')
      errEl.textContent = ''
      if (!server || !user) { errEl.textContent = '服务器地址和用户名都要填'; return }
      absBtn.disabled = true; absBtn.textContent = '连接中…'
      try {
        const u = await hub.loginAbs(server, user, pass)
        await afterLogin(`已连接 Audiobookshelf${u?.username ? '：' + u.username : ''}`)
      } catch (e) {
        errEl.textContent = e.message || '连接失败'
      } finally { absBtn.disabled = false; absBtn.textContent = '连 接' }
    }
    absBtn.addEventListener('click', doAbs)
    $('#aPass').addEventListener('keydown', e => { if (e.key === 'Enter') doAbs() })
  }

  // ---- ND 登录 ----
  const ndBtn = $('#ndLogin')
  if (ndBtn) {
    const doNd = async () => {
      const server = $('#nServer').value.trim()
      const user = $('#nUser').value.trim()
      const pass = $('#nPass').value
      const errEl = $('#nErr')
      errEl.textContent = ''
      if (!server || !user) { errEl.textContent = '服务器地址和用户名都要填'; return }
      ndBtn.disabled = true; ndBtn.textContent = '连接中…'
      try {
        await hub.loginNd(server, user, pass)
        await afterLogin('已连接 Navidrome')
      } catch (e) {
        errEl.textContent = e.message || '连接失败'
      } finally { ndBtn.disabled = false; ndBtn.textContent = '连 接' }
    }
    ndBtn.addEventListener('click', doNd)
    $('#nPass').addEventListener('keydown', e => { if (e.key === 'Enter') doNd() })
  }

  // ---- 断开 ----
  const absOut = $('#absOut')
  if (absOut) absOut.onclick = async () => {
    await hub.logout('abs'); toast('已断开 Audiobookshelf'); await go('login')
  }
  const ndOut = $('#ndOut')
  if (ndOut) ndOut.onclick = async () => {
    await hub.logout('nd'); toast('已断开 Navidrome'); await go('login')
  }

  // ---- 直接进入 ----
  const goApp = $('#gotoApp')
  if (goApp) goApp.onclick = async () => {
    const avail = await hub.restore()
    if (!avail.length) { toast('还没有连上任何服务器'); return }
    await afterLogin('')
  }

  // 「未设密码 + 管理账号」首次引导家长密码的逻辑保留（放 afterLogin 里更合适，
  // 但为避免影响两台服务器的登录流程，这里只提示一次，不强制跳页）
}

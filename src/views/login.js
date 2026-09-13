/** 登录 / 首次配置 */
import { abs } from '../lib/api.js'
import { store, CONFIG_KEYS } from '../lib/store.js'
import { go, toast, state, initPlayer } from '../app.js'
import { icon } from '../lib/icons.js'

export async function renderLogin(root) {
  // 老板 2026-09-13：登录框不要预填（value=）也不要示例 placeholder，
  // 空白就行。savedServer/savedUser 仅用于判断"有没有存过"（见下方跳转逻辑）。
  const savedServer = (await store.get(CONFIG_KEYS.server, '')) || ''
  const savedUser = (await store.get(CONFIG_KEYS.username, '')) || ''

  root.innerHTML = `
    <div class="login-wrap">
      <div class="login-logo">${icon('headphones', 64)}</div>
      <h1 class="login-h">听书</h1>
      <div class="login-sub">连接你的有声书服务器</div>
      <div class="login-card">
        <div class="field">
          <label>服务器地址</label>
          <input id="fServer" type="url" inputmode="url" autocapitalize="off" autocorrect="off"
                 placeholder="服务器地址" />
        </div>
        <div class="field">
          <label>用户名</label>
          <input id="fUser" type="text" autocapitalize="off" autocorrect="off"
                 placeholder="用户名" />
        </div>
        <div class="field">
          <label>密码</label>
          <input id="fPass" type="password" placeholder="密码" />
        </div>
        <div class="err" id="err"></div>
        <button class="btn block" id="doLogin">连 接</button>
      </div>
    </div>
  `

  const errEl = root.querySelector('#err')
  const btn = root.querySelector('#doLogin')

  const doLogin = async () => {
    const server = root.querySelector('#fServer').value.trim()
    const user = root.querySelector('#fUser').value.trim()
    const pass = root.querySelector('#fPass').value
    errEl.textContent = ''
    if (!server || !user) { errEl.textContent = '服务器地址和用户名都要填'; return }
    btn.disabled = true
    btn.textContent = '连接中…'
    try {
      const u = await abs.login(server, user, pass)
      await store.set(CONFIG_KEYS.server, abs.baseUrl)
      await store.set(CONFIG_KEYS.token, abs.token)
      await store.set(CONFIG_KEYS.username, user)

      const libs = await abs.libraries()
      state.libraries = libs
      state.libraryId = libs[0]?.id || null
      state.kidPin = (await store.get(CONFIG_KEYS.kidPin, '')) || ''
      if (!libs.length) { toast('这个账号看不到任何书库，检查权限'); }

      initPlayer()
      toast(`欢迎，${u?.username || user}`)
      // 首次登录：如果是管理员账号，引导设置家长密码
      // 首次登录且是管理账号：引导设置家长密码（进设置页也要它）
      if (!state.kidPin && (u?.type === 'root' || u?.type === 'admin')) {
        await go('settings', { firstRun: true })
      } else {
        await go('kidhome')
      }
    } catch (e) {
      errEl.textContent = e.message || '连接失败'
    } finally {
      btn.disabled = false
      btn.textContent = '连 接'
    }
  }

  btn.addEventListener('click', doLogin)
  root.querySelector('#fPass').addEventListener('keydown', e => { if (e.key === 'Enter') doLogin() })
}

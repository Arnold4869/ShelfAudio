/** 登录 / 首次配置 */
import { abs } from '../lib/api.js'
import { store, CONFIG_KEYS } from '../lib/store.js'
import { go, toast, esc, state, initPlayer } from '../app.js'
import { icon } from '../lib/icons.js'

export async function renderLogin(root) {
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
                 placeholder="http://内网IP:端口" value="${esc(savedServer)}" />
        </div>
        <div class="field">
          <label>用户名</label>
          <input id="fUser" type="text" autocapitalize="off" autocorrect="off"
                 placeholder="user" value="${esc(savedUser)}" />
        </div>
        <div class="field">
          <label>密码</label>
          <input id="fPass" type="password" placeholder="••••••" />
        </div>
        <div class="err" id="err"></div>
        <button class="btn block" id="doLogin">连 接</button>
      </div>
      <div class="hint" style="margin-top:18px">
        在 NAS 所在 WiFi 下填内网地址即可；外网访问需要你自己配好反向代理。<br>
        登录信息只保存在本机，不会上传到任何第三方。
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
      if (!state.kidPin && (u?.type === 'root' || u?.type === 'admin')) {
        await store.set(CONFIG_KEYS.mode, 'kid')
        state.mode = 'kid'
        await go('settings', { firstRun: true })
      } else {
        const mode = (await store.get(CONFIG_KEYS.mode, 'kid')) === 'adult' ? 'adult' : 'kid'
        state.mode = mode
        await go(mode === 'adult' ? 'shelf' : 'kidhome')
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

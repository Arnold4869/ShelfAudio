/**
 * 关于页：系统版本 + 权限状态 + 服务器信息
 *
 * 老板 2026-09-12：语音麦克风设置收进"关于系统信息"这类菜单；
 * 关于里放系统版本、语音权限有没有开启等。
 */
import { state, go, goBack, toast, esc, requireParentPin, stopCurrent } from '../app.js'
import { store, CONFIG_KEYS } from '../lib/store.js'
import { hub } from '../lib/servers.js'
import { icon } from '../lib/icons.js'
import { haptic } from '../lib/haptics.js'
import { checkVoicePermission, requestVoicePermission, openSystemSettings, onAppResume } from '../lib/permissions.js'
import { voiceSupported, voiceServiceAvailable } from '../lib/voice.js'
import { checkUpdate, currentVersion, updateSupported } from '../lib/updater.js'
import { Browser } from '@capacitor/browser'

export async function renderAbout(root) {
  const server = await store.get(CONFIG_KEYS.server, '')
  const username = await store.get(CONFIG_KEYS.username, '')
  root.innerHTML = `
    <div class="page-head">
      <button class="icon-btn" id="btnBack" aria-label="返回">${icon('back', 22)}</button>
      <div class="page-title">关于</div>
    </div>

    <div class="section-h">系统</div>
    <div class="settings-group">
      <div class="setting-row">
        <div class="setting-ic">${icon('info', 22)}</div>
        <div class="setting-main">
          <div class="setting-label">版本</div>
          <div class="setting-value">悦耳 v${currentVersion()}</div>
        </div>
      </div>
      ${updateSupported() ? `<div class="setting-row" id="rowCheck">
        <div class="setting-ic">${icon('download', 22)}</div>
        <div class="setting-main">
          <div class="setting-label">检测更新</div>
          <div class="setting-value" id="updState"></div>
        </div>
        <div class="setting-arrow" id="updArrow" style="display:none">${icon('forward', 20)}</div>
      </div>` : ''}
    </div>

    <div class="section-h">权限</div>
    <div class="settings-group">
      <div class="setting-row" id="rowMic">
        <div class="setting-ic">${icon('mic', 22)}</div>
        <div class="setting-main">
          <div class="setting-label">麦克风 / 语音识别</div>
          <div class="setting-value" id="micState">检查中…</div>
        </div>
        <div class="setting-arrow" id="micArrow" style="display:none">${icon('forward', 20)}</div>
      </div>
    </div>

    <div class="section-h">服务器</div>
    <div class="settings-group">
      <div class="setting-row">
        <div class="setting-ic">${icon('server', 22)}</div>
        <div class="setting-main">
          <div class="setting-label">服务器与账号</div>
          <div class="setting-value">${esc(server.replace(/^https?:\/\//, ''))} · ${esc(username)}</div>
        </div>
      </div>
      <div class="setting-row" id="rowLogout">
        <div class="setting-ic">${icon('exit', 22)}</div>
        <div class="setting-main">
          <div class="setting-label" style="color:var(--danger)">退出登录</div>
        </div>
        <div class="setting-arrow">${icon('forward', 20)}</div>
      </div>
    </div>
  `

  const $ = s => root.querySelector(s)
  $('#btnBack').onclick = () => { haptic.tap(); goBack('settings') }

  const micState = $('#micState')
  const descMap = {
    granted: '已开启',
    denied: '已被拒绝',
    prompt: '未申请',
    'prompt-with-rationale': '未申请',
    web: '当前环境不支持',
    error: '查询失败',
  }
  // 只有一行：已开启→点了没反应；未申请→点=申请；被拒→跳系统设置（唯一需要去系统设置的情形）
  let curState = null
  async function refreshMic() {
    if (!voiceSupported()) { micState.textContent = '当前环境不支持'; $('#micArrow').style.display = 'none'; return }
    try {
      const p = await checkVoicePermission()
      curState = p.state
      let text = descMap[p.state] || p.state
      // 权限没问题、但系统缺语音识别服务（老机型常见）→ 说清楚，
      // 否则用户看到「已开启」却永远识别不出字，只会怪 App。
      if (p.state === 'granted') {
        const svc = await voiceServiceAvailable()
        if (svc === false) text = '已开启 · 系统缺少识别服务'
      }
      micState.textContent = text
      // 被拒时才显示箭头（去系统设置的入口藏在被拒状态里）
      $('#micArrow').style.display = (p.state === 'denied') ? '' : 'none'
    } catch (_) { micState.textContent = '查询失败' }
  }
  $('#rowMic').onclick = async () => {
    haptic.tap()
    if (!voiceSupported()) { toast('仅真机可用'); return }
    if (curState === 'granted') return
    if (curState === 'denied') {
      // 系统不让再弹窗，只能去系统设置
      const ok = await openSystemSettings()
      if (!ok) toast('打不开系统设置')
      return
    }
    micState.textContent = '正在申请…'
    const r = await requestVoicePermission()
    if (!r.granted && r.needsSettings) toast('请在系统设置里开启')
    refreshMic()
  }

  refreshMic()
  onAppResume(() => { if (document.body.dataset.view === 'about') refreshMic() })

  // ---- 检测更新：查本仓库最新 Release，有新版就给下载入口 ----
  // 老板要求「有更新放到指定位置就能检测到」→ 指定位置 = 本仓库 GitHub Release（CI 自动发布）
  // 检测更新只在 Android 出现（iOS 走 Sideloadly，App 内下载无意义）→
  // 元素不存在时整段跳过，避免对 null 绑事件（那会中断后面所有初始化，踩过一次）
  if (updateSupported()) {
    const updState = $('#updState')
    let updInfo = null
    async function doCheck(silent) {
      if (!silent) updState.textContent = '检测中…'
      const r = await checkUpdate()
      updInfo = r
      if (!r.ok) {
        // 静默（进页自动查）失败不留红字 —— 老板要求不堆废话；手动点时再说原因
        updState.textContent = silent ? '' : r.error
        $('#updArrow').style.display = 'none'
        return r
      }
      if (r.hasUpdate) {
        updState.textContent = `有新版本 ${r.latest}（当前 ${r.current}）· 点这里下载`
        $('#updArrow').style.display = ''
      } else {
        updState.textContent = `已是最新（${r.current}）`
        $('#updArrow').style.display = 'none'
      }
      return r
    }
    // 进页自动查一次（静默，不显示"检测中"闪烁）；失败不打扰，保留空状态由用户手点
    doCheck(true).catch(() => {})

    $('#rowCheck').onclick = async () => {
      haptic.tap()
      if (updInfo?.ok && updInfo.hasUpdate) {
        // 有新版：优先给 Android apk，iOS 给 ipa；打开系统浏览器下载
        const link = updInfo.apk || updInfo.ipa || updInfo.url
        if (!link) { toast('这条发布没有安装包'); return }
        try { await Browser.open({ url: link }) }
        catch (_) { window.open(link, '_blank') }
        return
      }
      const r = await doCheck(false)
      if (r.ok && r.hasUpdate) {
        const link = r.apk || r.ipa || r.url
        try { await Browser.open({ url: link }) } catch (_) { window.open(link, '_blank') }
      }
    }
  }  // end if (updateSupported())

  // 退出登录：需家长密码（防孩子误触），清本机登录信息回登录页。
  // 多源（2026-09-14）：两台的登录态都清掉（hub.logout 逐台断开 + 清各自的存储键）。
  $('#rowLogout').onclick = async () => {
    haptic.tap()
    if (state.kidPin) { if (!(await requireParentPin())) return }
    await stopCurrent()
    for (const s of [...hub.available]) { try { await hub.logout(s) } catch (_) {} }
    await store.remove(CONFIG_KEYS.token)
    await store.remove(CONFIG_KEYS.server)
    await store.remove(CONFIG_KEYS.username)
    toast('已退出登录')
    await go('login')
  }
}

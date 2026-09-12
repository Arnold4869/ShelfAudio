/**
 * 设置页
 *
 * 只有一种模式了（老板 2026-09-12 要求取消儿童/成人分类）：
 * 以前这里顶上有「儿童模式 / 成人模式」两个互斥选项，切换后整个 App 换一套界面。
 * 现在所有用户都用同一套界面（大卡片书架 + 大字播放页），
 * 需要家长控制的东西收进「家长设置」（要密码）。
 *
 * 本页放的是日常/无害的项：语音权限、收藏、离线缓存。
 */
import { store, CONFIG_KEYS } from '../lib/store.js'
import { state, go, toast, esc, requireParentPin, updateMini } from '../app.js'
import { voiceSupported } from '../lib/voice.js'
import { icon } from '../lib/icons.js'
import { kidTabsHTML, wireKidTabs } from '../lib/nav.js'
import { checkVoicePermission, requestVoicePermission, openSystemSettings, onAppResume } from '../lib/permissions.js'
import { haptic } from '../lib/haptics.js'
import { cacheSize, cachedBooks, fmtBytes } from '../lib/offline.js'

export async function renderSettings(root, { firstRun = false } = {}) {
  let cacheUsed = 0, cacheCount = 0
  try {
    cacheUsed = await cacheSize()
    cacheCount = (await cachedBooks()).length
  } catch (_) { }

  root.innerHTML = `
    <div class="page-head">
      <button class="icon-btn" id="btnBack" aria-label="返回">${icon('back', 22)}</button>
      <div class="page-title">${firstRun ? '开始设置' : '设置'}</div>
    </div>

    ${firstRun ? `<div class="settings-group" style="padding:16px 18px">
      <div style="font-size:15px;line-height:1.7">
        连接成功！<br>
        建议先设一个<b>家长密码</b>：以后进「家长设置」（进度条口径、收听统计、服务器等）都需要输这个密码，孩子就点不出去了。
      </div>
    </div>` : ''}

    <div class="section-h">我的收藏</div>
    <div class="settings-group">
      <div class="setting-row" id="rowFav">
        <div class="setting-ic">${icon('heart', 22)}</div>
        <div class="setting-main">
          <div class="setting-label">收藏的书</div>

        </div>
        <div class="setting-arrow">${icon('forward', 20)}</div>
      </div>
    </div>

    <div class="section-h">离线缓存</div>
    <div class="settings-group">
      <div class="setting-row" id="rowCache">
        <div class="setting-ic">${icon('download', 22)}</div>
        <div class="setting-main">
          <div class="setting-label">缓存管理</div>
          <div class="setting-value">${cacheCount ? `已缓存 ${cacheCount} 本 · ${fmtBytes(cacheUsed)}` : ''}</div>
        </div>
        <div class="setting-arrow">${icon('forward', 20)}</div>
      </div>
    </div>

    <div class="section-h">语音与麦克风</div>
    <div class="settings-group">
      <div class="setting-row" id="rowMic">
        <div class="setting-ic">${icon('mic', 22)}</div>
        <div class="setting-main">
          <div class="setting-label">麦克风 / 语音识别权限</div>
          <div class="setting-value" id="micState">检查中…</div>
        </div>
        <div class="setting-arrow">${icon('forward', 20)}</div>
      </div>
      <div class="setting-row" id="rowMicSettings">
        <div class="setting-ic">${icon('cog', 22)}</div>
        <div class="setting-main">
          <div class="setting-label">打开系统设置</div>
          <div class="setting-value">手动开启麦克风</div>
        </div>
        <div class="setting-arrow">${icon('forward', 20)}</div>
      </div>
    </div>

    <div class="section-h">家长</div>
    <div class="settings-group">
      <div class="setting-row" id="rowParent">
        <div class="setting-ic">${icon('lock', 22)}</div>
        <div class="setting-main">
          <div class="setting-label">家长设置</div>
          <div class="setting-value">${state.kidPin ? '需输入密码' : '未设置密码'}</div>
        </div>
        <div class="setting-arrow">${icon('forward', 20)}</div>
      </div>
    </div>

    <div class="hint" style="margin-top:8px">
      听书 v${typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : '—'} · 音频来自你自己的 Audiobookshelf 服务器
    </div>

    ${kidTabsHTML('settings')}
  `

  const $ = s => root.querySelector(s)

  $('#btnBack').onclick = () => { haptic.tap(); go('kidhome') }
  wireKidTabs(root, { go, requireParentPin })

  // ---- 语音权限：显示实时状态 + 重新申请 + 跳设置 ----
  const micState = $('#micState')
  const descMap = {
    granted: '已开启',
    denied: '已被拒绝 — 点这里重新申请，或去系统设置手动开启',
    prompt: '还没申请过 — 点这里申请',
    'prompt-with-rationale': '还没申请过 — 点这里申请',
    web: '当前环境不支持（仅真机可用）',
    error: '查询失败，点这里重试',
  }
  async function refreshMic() {
    if (!voiceSupported()) { micState.textContent = '当前环境不支持（仅真机可用）'; return }
    const p = await checkVoicePermission()
    micState.textContent = descMap[p.state] || p.state
  }
  refreshMic()
  onAppResume(() => { if (document.body.dataset.view === 'settings') refreshMic() })

  $('#rowMic').onclick = async () => {
    haptic.tap()
    if (!voiceSupported()) { toast('仅真机可用'); return }
    const cur = await checkVoicePermission()
    if (cur.granted) { toast('权限已开启'); refreshMic(); return }
    micState.textContent = '正在申请…'
    const r = await requestVoicePermission()
    if (r.granted) { toast('权限已开启') }
    else if (r.needsSettings) { toast('请在系统设置里开启') }
    else { toast('申请失败') }
    refreshMic()
  }

  $('#rowMicSettings').onclick = async () => {
    haptic.tap()
    const ok = await openSystemSettings()
    if (!ok) toast('打不开系统设置')
    else toast('请在系统设置里开启麦克风')
  }

  $('#rowFav').onclick = () => { haptic.tap(); go('favorites') }
  $('#rowCache').onclick = () => { haptic.tap(); go('cache') }

  // 家长设置：进之前验密码。没设过密码就直接进（否则用户永远进不去）。
  $('#rowParent').onclick = async () => {
    haptic.tap()
    if (state.kidPin) {
      if (!(await requireParentPin())) return
    } else {
      toast('还没设家长密码')
    }
    await go('parents')
  }

  updateMini()
}

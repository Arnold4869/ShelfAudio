/**
 * 设置页
 *
 * 布局（老板 2026-09-13 拍板）：
 * - 不要「我的收藏 / 离线缓存 / 关于 / 家长」这些大分类标题，只保留菜单行
 * - 「关于」放最下面，名字就叫「关于」，不带副行（版本/权限等说明）
 * - 首次登录的引导块保留（那是新用户唯一的教学时机）
 */
import { store, CONFIG_KEYS } from '../lib/store.js'
import { state, go, toast, esc, requireParentPin, updateMini } from '../app.js'
import { icon } from '../lib/icons.js'
import { kidTabsHTML, wireKidTabs } from '../lib/nav.js'
import { haptic } from '../lib/haptics.js'
import { cacheSize, cachedBooks, fmtBytes } from '../lib/offline.js'
import { voiceHidden, setVoiceHidden } from '../lib/ui-prefs.js'

export async function renderSettings(root, { firstRun = false } = {}) {
  let cacheUsed = 0, cacheCount = 0
  try {
    cacheUsed = await cacheSize()
    cacheCount = (await cachedBooks()).length
  } catch (_) { }

  root.innerHTML = `
    <div class="page-head">
      <div class="page-title">${firstRun ? '开始设置' : '设置'}</div>
    </div>

    ${firstRun ? `<div class="settings-group" style="padding:16px 18px">
      <div style="font-size:15px;line-height:1.7">
        连接成功！<br>
        建议先设一个<b>家长密码</b>：以后进「家长设置」（进度条口径、收听统计、服务器等）都需要输这个密码，孩子就点不出去了。
      </div>
    </div>` : ''}

    <div class="settings-group">
      <div class="setting-row" id="rowFav">
        <div class="setting-ic">${icon('heart', 22)}</div>
        <div class="setting-main">
          <div class="setting-label">收藏的书</div>
        </div>
        <div class="setting-arrow">${icon('forward', 20)}</div>
      </div>
      <div class="setting-row" id="rowCache">
        <div class="setting-ic">${icon('download', 22)}</div>
        <div class="setting-main">
          <div class="setting-label">缓存管理</div>
          <div class="setting-value">${cacheCount ? `已缓存 ${cacheCount} 本 · ${fmtBytes(cacheUsed)}` : ''}</div>
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
      <div class="setting-row" id="rowParent">
        <div class="setting-ic">${icon('lock', 22)}</div>
        <div class="setting-main">
          <div class="setting-label">家长设置</div>
          <div class="setting-value">${state.kidPin ? '需输入密码' : '未设置密码'}</div>
        </div>
        <div class="setting-arrow">${icon('forward', 20)}</div>
      </div>
    </div>

    <div class="settings-group" id="groupAbout">
      <div class="setting-row" id="rowAbout">
        <div class="setting-ic">${icon('info', 22)}</div>
        <div class="setting-main">
          <div class="setting-label">关于</div>
        </div>
        <div class="setting-arrow">${icon('forward', 20)}</div>
      </div>
    </div>

    ${kidTabsHTML('settings')}
  `

  const $ = s => root.querySelector(s)

  wireKidTabs(root, { go, requireParentPin })

  $('#rowAbout').onclick = () => { haptic.tap(); go('about') }

  $('#rowFav').onclick = () => { haptic.tap(); go('favorites') }
  $('#rowCache').onclick = () => { haptic.tap(); go('cache') }

  // 家长设置：进之前验密码。没设过密码就直接进（否则用户永远进不去）。
  // 语音按钮显隐（老板 2026-09-14）：点一下切换，立刻生效（下次渲染视图就不显示）
  $('#rowVoice').onclick = async () => {
    haptic.tap()
    const next = !voiceHidden()
    await setVoiceHidden(next)
    $('#voiceVal').textContent = next ? '已隐藏' : '已显示'
    // 已经在页面上的语音按钮立即跟着变，不用等重进页面
    document.querySelectorAll('.voice-fab, .search-mic').forEach(el => {
      el.style.display = next ? 'none' : ''
    })
    toast(next ? '已隐藏语音按钮' : '已显示语音按钮')
  }

  $('#rowParent').onclick = async () => {
    haptic.tap()
    if (!state.kidPin) toast('还没设家长密码，进页面后先设置一个')
    await go('parents')   // 密码校验在 route 层（app.js），入口不重复拦
  }

  updateMini()
}

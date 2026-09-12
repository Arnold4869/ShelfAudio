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
import { icon } from '../lib/icons.js'
import { kidTabsHTML, wireKidTabs } from '../lib/nav.js'
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

    <div class="section-h">关于</div>
    <div class="settings-group">
      <div class="setting-row" id="rowAbout">
        <div class="setting-ic">${icon('info', 22)}</div>
        <div class="setting-main">
          <div class="setting-label">关于听书</div>
          <div class="setting-value">版本 · 权限</div>
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

    ${kidTabsHTML('settings')}
  `

  const $ = s => root.querySelector(s)

  wireKidTabs(root, { go, requireParentPin })

  $('#rowAbout').onclick = () => { haptic.tap(); go('about') }

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

/**
 * 家长加时弹窗（2026-09-27，老板需求：时间到点被拦后输家长密码可继续）
 *
 * 用在哪：playItem() / toggle() / 语音「继续播放」的闸门拦下时，若被拦原因是
 * 「今日时长用完」→ 弹这里；「不在收听时段」不弹（那是时间窗问题，加时没意义）。
 *
 * 为什么做成本文件而不是塞进 app.js / parents.js：
 *  - requireParentPin() 是全局遮罩（#lock），加时面板也要盖在最上层，属于全局 UI；
 *  - parents.js 是家长设置页，孩子根本进不去，逻辑放那儿反而是个「诱导入口」。
 *
 * 交互：输家长密码 → 出现 15/30/60 分钟三档 + 自定义分钟数 → 确定落盘加时余额
 * → 调用方重新判定闸门。取消 / 关掉 = 什么都不发生（闸门维持原判）。
 *
 * 样式复用 .lock / .lock-card / .time-input（家长锁、收听时间子页同一套），
 * 不新增 CSS 文件；只有 .ext-grid / .ext-used 两个新类（见 styles.css）。
 */
import { requireParentPin, toast } from '../app.js'
import { addDailyBonusMinutes, dailyBonusSeconds } from './parental.js'
import { haptic } from './haptics.js'

const PRESETS = [15, 30, 60]
const MAX_MINUTES = 1440

/**
 * 同一时刻只允许一个加时面板。
 *
 * 为什么必须去重：到点自停由 60s 轮询触发，孩子同时可能正在点播放键 ——
 * 两条路径都会走到这里。而 requireParentPin() 复用 index.html 里那个**静态**
 * `#lock` 元素（后一次调用会覆盖 `#lockOk.onclick`），并发进入会让先来的那个
 * Promise 永远不 resolve（密码框关不掉、后续流程卡住）。已有面板在开 →
 * 直接返回 false（第二次调用不重复弹，调用方按「没加时」处理）。
 */
let _extOpen = false

/**
 * 打开「家长加时」弹窗。
 * @param {object} [info] playbackGate() 的结构化结果（quota 拦截时传入），
 *   用于展示「今日已听 / 上限」；不传也能用（只显示档位与已有余额）。
 * @returns {Promise<boolean>} true=家长加了时（余额已增加），false=取消/失败
 */
export async function openParentalExtend(info = {}) {
  if (_extOpen) return false
  _extOpen = true
  try {
    const okPin = await requireParentPin()
    if (!okPin) return false           // 没输对密码 / 点了取消
    return await _renderExt(info)
  } catch (_) {
    return false
  } finally {
    // 无论走哪条路径都要解锁，否则一次意外会让家长再也加不了时
    _extOpen = false
  }
}

/** 真正的面板渲染与交互。resolve(true) = 已加时；resolve(false) = 取消 */
function _renderExt(info) {
  return new Promise(resolve => {
    let picked = 0   // 选中的分钟数（0 = 未选，确定钮灰着）

    const wrap = document.createElement('div')
    wrap.className = 'lock'
    wrap.innerHTML = `
      <div class="lock-card">
        <div class="lock-title">家长加时</div>
        <div class="lock-sub">为今天追加收听时间</div>
        <div class="ext-used" id="extUsed"></div>
        <div class="ext-grid">
          ${PRESETS.map(m => `<button class="btn ghost sleep-opt" data-min="${m}">${m} 分钟</button>`).join('')}
        </div>
        <div class="time-pair" style="margin-top:10px">
          <input class="time-input time-input-num" id="extCustom" type="number" inputmode="numeric"
                 min="1" max="${MAX_MINUTES}" step="5" placeholder="自定义分钟数">
          <span class="time-sep">分钟</span>
        </div>
        <div class="lock-err" id="extErr"></div>
        <div class="lock-actions">
          <button class="btn ghost" id="extCancel">取消</button>
          <button class="btn" id="extOk" disabled>确定</button>
        </div>
      </div>`
    document.body.appendChild(wrap)

    const $ = s => wrap.querySelector(s)
    const errEl = $('#extErr')
    const usedEl = $('#extUsed')
    const okBtn = $('#extOk')
    const custom = $('#extCustom')

    const min = s => `${Math.round(s / 60)} 分钟`

    /**
     * 「今日已听 31 分钟 / 上限 30 分钟」这行说明。
     * 两种来源：闸门带回来的实时数据（有 usedSec）；或只有加时余额（别的调用方）。
     * 都没有（没开时长限制）→ 整行留空，不显示假数据。
     */
    const paintUsed = async () => {
      if (info.usedSec > 0) {
        const bonus = info.bonusSec > 0 ? `（含加时 ${min(info.bonusSec)}）` : ''
        usedEl.textContent = `今日已听 ${min(info.usedSec)} / 上限 ${min(info.limitSec)}${bonus}`
        return
      }
      const sec = await dailyBonusSeconds()
      usedEl.textContent = sec > 0 ? `今日已加时 ${min(sec)}` : ''
    }
    paintUsed().catch(() => {})

    /** 档位选中态：唯一高亮；改选/自定义输入时互斥 */
    const paintPicked = () => {
      wrap.querySelectorAll('[data-min]').forEach(b => {
        const on = Number(b.dataset.min) === picked
        b.classList.toggle('picked', on)
      })
      okBtn.disabled = picked <= 0
    }
    wrap.querySelectorAll('[data-min]').forEach(b => {
      b.onclick = () => { haptic.select(); custom.value = ''; picked = Number(b.dataset.min); paintPicked() }
    })
    custom.oninput = () => {
      picked = Math.max(0, Math.min(MAX_MINUTES, Math.floor(Number(custom.value) || 0)))
      wrap.querySelectorAll('[data-min]').forEach(b => b.classList.toggle('picked', false))
      okBtn.disabled = picked <= 0
    }

    const close = () => wrap.remove()
    $('#extCancel').onclick = () => { haptic.tap(); close(); resolve(false) }
    okBtn.onclick = async () => {
      if (picked <= 0) return
      okBtn.disabled = true   // 防连点：落盘期间再点一次会加两次
      try {
        await addDailyBonusMinutes(picked)
        haptic.success()
        toast(`已加 ${picked} 分钟`)
        close()
        resolve(true)
      } catch (_) {
        errEl.textContent = '保存失败，再试一次'
        okBtn.disabled = false
      }
    }
  })
}

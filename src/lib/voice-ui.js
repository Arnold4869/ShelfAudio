/** 语音浮层 UI —— 书架页和搜索页共用 */
import { listen, stopListening, parseCommand, voiceSupported } from './voice.js'
import { checkVoicePermission, requestVoicePermission, openSystemSettings } from './permissions.js'
import { state, toast } from '../app.js'

export function openVoiceOverlay({ onSearch } = {}) {
  if (!voiceSupported()) { toast('这台设备不支持语音识别'); return }
  if (document.querySelector('.voice-overlay')) return

  const ov = document.createElement('div')
  ov.className = 'voice-overlay'
  ov.innerHTML = `
    <div class="voice-mic">🎤</div>
    <div class="voice-status" id="vStat">想听什么书？</div>
    <div class="voice-heard" id="vHeard"></div>
    <div class="voice-hints" id="vHints">
      <button class="voice-hint" data-say="暂停">暂停</button>
      <button class="voice-hint" data-say="下一集">下一集</button>
      <button class="voice-hint" data-say="上一集">上一集</button>
      <button class="voice-hint" data-say="继续播放">继续播放</button>
    </div>
    <button class="btn ghost voice-close" id="vClose">取消</button>
  `
  document.body.appendChild(ov)

  const stat = ov.querySelector('#vStat'), heard = ov.querySelector('#vHeard')
  const hints = ov.querySelector('#vHints')
  let done = false
  const close = () => ov.remove()

  // 权限出问题时的兜底 UI：重新申请 + 跳系统设置
  async function showPermissionHelp(msg, needsSettings) {
    stat.textContent = msg
    heard.textContent = ''
    hints.innerHTML = `
      <button class="voice-hint" id="vRetry" style="background:rgba(124,92,255,.35)">重新申请权限</button>
      ${needsSettings ? '<button class="voice-hint" id="vSettings" style="background:rgba(255,181,77,.25)">去系统设置开启</button>' : ''}
    `
    ov.querySelector('#vRetry').onclick = async () => {
      const r = await requestVoicePermission()
      if (r.granted) { toast('权限已开启'); close(); openVoiceOverlay({ onSearch }) }
      else if (r.needsSettings) { showPermissionHelp('系统已不再弹窗，请到设置里手动开启麦克风权限', true) }
      else { stat.textContent = '还是没能拿到权限，再试一次或去系统设置' }
    }
    const setBtn = ov.querySelector('#vSettings')
    if (setBtn) setBtn.onclick = async () => {
      const ok = await openSystemSettings()
      if (!ok) toast('打不开系统设置，请手动到「设置 → 听书」里开启麦克风')
      else stat.textContent = '请在设置里打开「麦克风」和「语音识别」，然后回来重试'
      done = false   // 允许回来后再试
    }
  }

  async function handle(text) {
    if (done) return
    done = true
    heard.textContent = text
    const cmd = parseCommand(text)
    const p = state.player

    switch (cmd.intent) {
      case 'pause':
        await p?.pause(); toast('已暂停'); close(); return
      case 'play':
        if (state.current) { await p?.play(); toast('继续播放') } else toast('还没有在播放的书')
        close(); return
      case 'next':
        await p?.nextTrack(); toast('下一集'); close(); return
      case 'prev':
        await p?.prevTrack(); toast('上一集'); close(); return
      case 'louder':
        await p?.nudgeVolume(+0.2); toast('音量大一点'); close(); return
      case 'quieter':
        await p?.nudgeVolume(-0.2); toast('音量小一点'); close(); return
      case 'rate':
        await p?.setRate(cmd.rate); toast(`速度 ${cmd.rate}×`); close(); return
      case 'sleep': {
        const { setSleepTimer } = await import('../views/player.js')
        setSleepTimer(cmd.minutes); close(); return
      }
      default: {
        stat.textContent = '正在找「' + cmd.query + '」…'
        close()
        onSearch?.(cmd.query)
      }
    }
  }

  ov.querySelector('#vClose').onclick = async () => { done = true; await stopListening(); close() }
  hints.querySelectorAll('[data-say]').forEach(b => {
    b.onclick = async () => { done = true; await stopListening(); await handle(b.dataset.say) }
  })

  // 先查权限，避免"没权限"时直接弹一个失败的识别会话
  ;(async () => {
    const perm = await checkVoicePermission()
    if (perm.granted) { startListening(); return }

    if (perm.canAsk) {
      const r = await requestVoicePermission()
      if (r.granted) { startListening(); return }
      showPermissionHelp('麦克风权限被拒绝', r.needsSettings)
      return
    }
    // denied 或异常：给用户明确出口，而不是静默失败
    showPermissionHelp('拿不到麦克风权限，App 无法使用语音', true)
  })()

  function startListening() {
    listen({
      onPartial: t => { heard.textContent = t },
      onResult: t => handle(t),
      onError: (msg, meta) => {
        if (meta?.needsSettings) { showPermissionHelp(msg, true); return }
        stat.textContent = msg
        heard.textContent = ''
        setTimeout(() => { if (ov.parentNode) close() }, 1700)
      },
    })
  }
}

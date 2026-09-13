/** 语音浮层 UI —— 书架页和搜索页共用 */
import { icon } from './icons.js'
import { listen, finishListening, currentText, forceStopCurrent, parseCommand, voiceSupported, voiceServiceAvailable } from './voice.js'
import { checkVoicePermission, requestVoicePermission, openSystemSettings } from './permissions.js'
import { state, toast } from '../app.js'

export function openVoiceOverlay({ onSearch } = {}) {
  if (!voiceSupported()) { toast('这台设备不支持语音识别'); return }
  if (document.querySelector('.voice-overlay')) return

  const ov = document.createElement('div')
  ov.className = 'voice-overlay'
  ov.innerHTML = `
    <div class="voice-mic" id="vMic"></div>
    <div class="voice-status" id="vStat">正在准备麦克风…</div>
    <div class="voice-heard" id="vHeard"></div>
    <div class="voice-hints" id="vHints"></div>
    <div class="voice-actions" id="vActions"></div>
  `
  document.body.appendChild(ov)

  const mic = ov.querySelector('#vMic')
  mic.innerHTML = icon('mic', 56)
  const stat = ov.querySelector('#vStat')
  const heard = ov.querySelector('#vHeard')
  const hints = ov.querySelector('#vHints')
  const actions = ov.querySelector('#vActions')

  let done = false        // 已给出结果，防止重复处理
  let listening = false   // 正在收音
  let gotText = false     // 是否已经听到内容
  const close = () => { ov.remove() }

  // ---------- 常态操作区 ----------
  function normalActions() {
    actions.innerHTML = `<button class="btn ghost" id="vClose">取消</button>`
    actions.querySelector('#vClose').onclick = async () => {
      done = true
      await forceStopCurrent()
      close()
    }
  }

  // ---------- 收音中：给「说完了」按钮 + 常见指令 ----------
  function listeningUI() {
    mic.classList.add('listening')
    stat.textContent = '请说书名，或说指令'
    hints.innerHTML = `
      <button class="voice-hint" data-say="暂停">暂停</button>
      <button class="voice-hint" data-say="下一集">下一集</button>
      <button class="voice-hint" data-say="上一集">上一集</button>
      <button class="voice-hint" data-say="继续播放">继续播放</button>
    `
    hints.querySelectorAll('[data-say]').forEach(b => {
      b.onclick = async () => { done = true; await forceStopCurrent(); await handle(b.dataset.say) }
    })
    actions.innerHTML = `
      <button class="btn" id="vDone" style="flex:1">说完了</button>
      <button class="btn ghost" id="vClose" style="flex:0 0 auto">取消</button>
    `
    actions.querySelector('#vDone').onclick = async () => {
      const t = currentText()
      if (t) { await finishListening(); return }
      toast('还没听到内容，再说一次')
    }
    actions.querySelector('#vClose').onclick = async () => { done = true; await forceStopCurrent(); close() }
  }

  // ---------- 权限兜底 UI ----------
  async function showPermissionHelp(msg, needsSettings) {
    mic.classList.remove('listening')
    stat.textContent = msg
    heard.textContent = ''
    hints.innerHTML = ''
    actions.innerHTML = `
      <button class="btn" id="vRetry" style="flex:1">重新申请权限</button>
      ${needsSettings ? '<button class="btn ghost" id="vSettings" style="flex:1">系统设置</button>' : ''}
      <button class="btn ghost" id="vClose" style="flex:0 0 auto">关闭</button>`
    actions.querySelector('#vRetry').onclick = async () => {
      const r = await requestVoicePermission()
      if (r.granted) { toast('权限已开启'); close(); openVoiceOverlay({ onSearch }) }
      else showPermissionHelp('系统已不再弹窗，请到设置里手动开启麦克风权限', true)
    }
    const sb = actions.querySelector('#vSettings')
    if (sb) sb.onclick = async () => {
      const ok = await openSystemSettings()
      if (!ok) toast('打不开系统设置，请手动到「设置 → 听书」里开启麦克风')
      else stat.textContent = '请在设置里打开「麦克风」和「语音识别」，然后回来重试'
    }
    actions.querySelector('#vClose').onclick = () => close()
  }

  // ---------- 处理识别结果 ----------
  async function handle(text) {
    if (done) return
    done = true
    mic.classList.remove('listening')
    heard.textContent = text
    const cmd = parseCommand(text)
    const p = state.player

    switch (cmd.intent) {
      case 'pause': await p?.pause(); toast('已暂停'); close(); return
      case 'play':
        if (state.current) { await p?.play(); toast('继续播放') } else toast('还没有在播放的书')
        close(); return
      case 'next': await p?.nextTrack(); toast('下一集'); close(); return
      case 'prev': await p?.prevTrack(); toast('上一集'); close(); return
      case 'louder': await p?.nudgeVolume(+0.2); toast('音量大一点'); close(); return
      case 'quieter': await p?.nudgeVolume(-0.2); toast('音量小一点'); close(); return
      case 'rate': await p?.setRate(cmd.rate); toast(`速度 ${cmd.rate}×`); close(); return
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

  // ---------- 启动 ----------
  ;(async () => {
    // 0) 系统里有没有语音识别服务？没有就别白折腾权限了 ——
    // 小米 8SE 这类老机型常见：权限给了、也能收音，但识别服务缺失，
    // 结果永远是空，用户看到的就是"能听到声音却不转文字"。
    const svcOk = await voiceServiceAvailable()
    if (svcOk === false) {
      mic.classList.remove('listening')
      stat.textContent = '这台手机没有可用的语音识别服务'
      heard.textContent = ''
      hints.innerHTML = ''
      actions.innerHTML = `<button class="btn ghost" id="vClose" style="flex:1">知道了</button>`
      actions.querySelector('#vClose').onclick = () => close()
      return
    }

    const perm = await checkVoicePermission()
    if (!perm.granted) {
      if (perm.canAsk) {
        const r = await requestVoicePermission()
        if (!r.granted) { showPermissionHelp('麦克风权限被拒绝', r.needsSettings); return }
      } else {
        showPermissionHelp('拿不到麦克风权限，App 无法使用语音', true)
        return
      }
    }
    start()
  })()

  function start() {
    normalActions()
    listen({
      onStart: () => { listening = true; listeningUI() },
      onPartial: t => {
        gotText = true
        heard.textContent = t
        if (!listening) { listening = true; listeningUI() }
        stat.textContent = '正在听…说完会自动结束'
      },
      onResult: t => handle(t),
      onError: (msg, meta) => {
        if (meta?.needsSettings) { showPermissionHelp(msg, true); return }
        // 没听到内容：给重试入口，不要一闪而过
        mic.classList.remove('listening')
        stat.textContent = msg
        heard.textContent = ''
        hints.innerHTML = ''
        actions.innerHTML = `
          <button class="btn" id="vRetry" style="flex:1">再试一次</button>
          <button class="btn ghost" id="vClose" style="flex:0 0 auto">关闭</button>`
        actions.querySelector('#vRetry').onclick = () => { close(); openVoiceOverlay({ onSearch }) }
        actions.querySelector('#vClose').onclick = () => close()
      },
    })
  }
}

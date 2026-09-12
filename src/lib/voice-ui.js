/** 语音浮层 UI —— 书架页和搜索页共用 */
import { listen, stopListening, parseCommand, voiceSupported } from './voice.js'
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
    <div class="voice-hints">
      <button class="voice-hint" data-say="暂停">暂停</button>
      <button class="voice-hint" data-say="下一集">下一集</button>
      <button class="voice-hint" data-say="上一集">上一集</button>
      <button class="voice-hint" data-say="继续播放">继续播放</button>
    </div>
    <button class="btn ghost voice-close" id="vClose">取消</button>
  `
  document.body.appendChild(ov)

  const stat = ov.querySelector('#vStat'), heard = ov.querySelector('#vHeard')
  let done = false
  const close = () => ov.remove()

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
  ov.querySelectorAll('[data-say]').forEach(b => {
    b.onclick = async () => { done = true; await stopListening(); await handle(b.dataset.say) }
  })

  listen({
    onPartial: t => { heard.textContent = t },
    onResult: t => handle(t),
    onError: msg => { stat.textContent = msg; heard.textContent = ''; setTimeout(close, 1700) },
  })
}

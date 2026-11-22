import { createPeer, transmit } from './peer.ts'
import { createViewerPointer } from './watch-pointer.ts'
import type { Signal } from './wire.ts'

const token = location.hash.slice(1)
const button = document.querySelector<HTMLButtonElement>('#connect')!
const full = document.querySelector<HTMLButtonElement>('#fullscreen')!
const fit = document.querySelector<HTMLButtonElement>('#fit')!
const leave = document.querySelector<HTMLButtonElement>('#leave')!
const stage = document.querySelector<HTMLElement>('#stage')!
const toolbar = document.querySelector<HTMLElement>('#viewer-bar')!
const surface = document.querySelector<HTMLButtonElement>('#viewer-surface')!
const status = document.querySelector<HTMLElement>('#status')!
const prompt = document.querySelector<HTMLElement>('#viewer-prompt')!
const stats = document.querySelector<HTMLElement>('#stats')!
const touchHint = document.querySelector<HTMLElement>('#touch-hint')!
const video = document.querySelector<HTMLVideoElement>('video')!
let channel: WebSocket | undefined
let activePeer: ReturnType<typeof createPeer> | undefined
let timer: number | undefined
let touchChannel: RTCDataChannel | undefined
let touchEnabled = false

const remotePointer = createViewerPointer(video.parentElement!, video, (command) => {
  if (touchChannel?.readyState !== 'open') return
  if (command.action === 'move' && touchChannel.bufferedAmount > 4096) return
  touchChannel.send(JSON.stringify(command))
}, () => {
  if (document.fullscreenElement === stage) setControlsVisible(toolbar.hidden === true)
})

function setControlsVisible(visible: boolean) {
  toolbar.hidden = !visible
  surface.setAttribute('aria-expanded', String(visible))
  surface.setAttribute('aria-label', visible ? '隐藏全屏控件' : '显示全屏控件')
}

function updateFullscreen() {
  const fullscreen = document.fullscreenElement === stage
  const immersive = fullscreen && prompt.hidden
  const keyboardEntry = document.activeElement === full && full.matches(':focus-visible')
  const restoreFocus = document.activeElement === surface
  surface.hidden = !immersive || touchEnabled
  setControlsVisible(!immersive)
  full.textContent = fullscreen ? '退出全屏' : '全屏'
  full.disabled = !fullscreen && (!activePeer || !prompt.hidden || !document.fullscreenEnabled)
  if (!surface.hidden && keyboardEntry) surface.focus()
  else if (!fullscreen && restoreFocus && !full.disabled) full.focus()
}

function updateTouchMode() {
  touchEnabled = activePeer?.pc.connectionState === 'connected' && touchChannel?.readyState === 'open' && prompt.hidden === true
  remotePointer.setEnabled(touchEnabled)
  touchHint.hidden = !touchEnabled
  updateFullscreen()
}

function end(message: string) {
  const previous = channel
  channel = undefined
  previous?.close()
  remotePointer.setEnabled(false)
  touchChannel = undefined
  activePeer?.pc.close()
  activePeer = undefined
  window.clearTimeout(timer)
  video.srcObject = null
  if (document.fullscreenElement === stage) void document.exitFullscreen().catch(() => {})
  status.textContent = message
  stats.textContent = ''
  prompt.hidden = false
  button.hidden = false
  button.disabled = false
  button.textContent = '重新连接'
  fit.hidden = true
  leave.disabled = true
  updateTouchMode()
}

async function play() {
  try {
    await video.play()
  } catch {
    if (!activePeer) return
    window.clearTimeout(timer)
    button.disabled = false
    button.hidden = false
    button.textContent = '播放画面'
    status.textContent = '轻触播放画面。'
  }
}

function connect() {
  if (activePeer && video.srcObject) {
    void play()
    return
  }
  const endpoint = new URL('/viewer', location.href)
  endpoint.protocol = 'ws:'
  endpoint.searchParams.set('token', token)
  const socket = new WebSocket(endpoint)
  channel = socket
  button.disabled = false
  button.hidden = true
  leave.disabled = false
  status.textContent = '正在连接电脑…'
  timer = window.setTimeout(() => end('连接超时。请确认电脑仍在共享。'), 10000)
  socket.addEventListener('open', () => {
    if (channel !== socket) return
    window.clearTimeout(timer)
    status.textContent = '请在电脑端允许连接。'
  })
  socket.addEventListener('error', () => {
    if (channel === socket) end('无法连接。请确认电脑仍在共享、在同一网络且没有其他平板占用。')
  })
  socket.addEventListener('close', () => {
    if (channel === socket) end('共享已断开。')
  })

  let queue = Promise.resolve()
  socket.addEventListener('message', ({ data }) => {
    queue = queue.then(async () => {
      if (channel !== socket) return
      const message = JSON.parse(data) as Signal
      if (message.type === 'rejected') {
        end('电脑取消了本次连接。')
      } else if (message.type === 'approved') {
        status.textContent = '正在等候第一帧画面…'
        timer = window.setTimeout(() => end('已连接电脑，但未收到画面。请重试。'), 20000)
        const peer = createPeer(message.id, (signal) => transmit(socket, signal))
        activePeer = peer
        peer.pc.onconnectionstatechange = () => {
          if (activePeer !== peer) return
          if (peer.pc.connectionState === 'failed') end('视频连接失败，请重新连接。')
          else if (touchChannel) updateTouchMode()
        }
        peer.pc.ondatachannel = ({ channel: controls }) => {
          if (activePeer !== peer || controls.label !== 'tablet-link-pointer' || touchChannel) {
            controls.close()
            return
          }
          touchChannel = controls
          controls.onopen = () => { if (touchChannel === controls) updateTouchMode() }
          controls.onclose = () => {
            if (touchChannel === controls) {
              touchChannel = undefined
              updateTouchMode()
            }
          }
          updateTouchMode()
        }
        peer.pc.ontrack = ({ track, streams, receiver }) => {
          if (activePeer !== peer) return
          try {
            if ('jitterBufferTarget' in receiver) receiver.jitterBufferTarget = 30
          } catch {
            // Browsers without a usable setter keep their own adaptive buffer.
          }
          video.srcObject = streams[0] ?? new MediaStream([track])
          void play()
        }
      } else if (activePeer?.id === message.id) {
        const peer = activePeer
        await peer.accept(message)
        if (message.type === 'offer' && activePeer === peer) await peer.publish('answer')
      }
    }).catch(() => {
      if (channel === socket) end('视频协商失败，请重新连接。')
    })
  })
}

video.addEventListener('playing', () => {
  if (!activePeer) return
  window.clearTimeout(timer)
  const firstPlayback = !prompt.hidden
  prompt.hidden = true
  fit.hidden = false
  if (firstPlayback) updateTouchMode()
})

let sample: { decoded: number; time: number } | undefined
window.setInterval(async () => {
  const peer = activePeer
  if (!peer || !prompt.hidden) {
    sample = undefined
    return
  }
  const report = await peer.pc.getStats().catch(() => undefined)
  if (!report || activePeer !== peer) return
  for (const value of report.values()) {
    if (value.type !== 'inbound-rtp' || value.kind !== 'video' || typeof value.framesDecoded !== 'number') continue
    const decoded = value.framesDecoded as number
    const time = value.timestamp as number
    const fps = sample && time > sample.time ? Math.round(1000 * (decoded - sample.decoded) / (time - sample.time)) : undefined
    stats.textContent = `${video.videoWidth} × ${video.videoHeight}${fps !== undefined && fps >= 0 ? ` · ${fps} FPS` : ''}`
    sample = { decoded, time }
  }
}, 1000)

full.addEventListener('click', async () => {
  try {
    if (document.fullscreenElement === stage) await document.exitFullscreen()
    else await stage.requestFullscreen({ navigationUI: 'hide' })
  } catch {
    stats.textContent = '当前浏览器无法进入全屏'
    full.disabled = true
  }
})
document.addEventListener('fullscreenchange', updateFullscreen)
surface.addEventListener('click', () => setControlsVisible(toolbar.hidden === true))
fit.addEventListener('click', () => {
  fit.setAttribute('aria-pressed', String(video.classList.toggle('video-cover')))
})
leave.addEventListener('click', () => void end('已断开连接。'))
window.addEventListener('pagehide', () => {
  if (channel) end('已断开连接。')
})

if (!/^[\w-]{32}$/.test(token) || typeof RTCPeerConnection !== 'function') {
  button.hidden = true
  status.textContent = token ? '浏览器不支持该连接，或链接已失效。' : '请用电脑端生成的二维码或完整链接打开。'
} else button.addEventListener('click', connect)

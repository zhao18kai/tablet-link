import { createPeer, transmit } from './peer.ts'
import { createViewerPointer } from './watch-pointer.ts'
import { createRotationTransition } from './watch-rotation.ts'
import { createStreamStats } from './watch-stats.ts'
import { SHARE_ENDED, VIEWER_LEAVING, VIEWER_REPLACED, type Signal } from './wire.ts'

declare global {
  interface Window {
    tabletLinkReceiver?: { rememberComputer(id: string, name: string, token: string): void }
  }
}

const [, token, reconnect] = /^#([A-Za-z0-9_-]{32})(\.reconnect)?$/.exec(location.hash) ?? []
const button = document.querySelector<HTMLButtonElement>('#connect')!
const full = document.querySelector<HTMLButtonElement>('#fullscreen')!
const fit = document.querySelector<HTMLButtonElement>('#fit')!
const leave = document.querySelector<HTMLButtonElement>('#leave')!
const stage = document.querySelector<HTMLElement>('#stage')!
const toolbar = document.querySelector<HTMLElement>('#viewer-bar')!
const surface = document.querySelector<HTMLButtonElement>('#viewer-surface')!
const status = document.querySelector<HTMLElement>('#status')!
const prompt = document.querySelector<HTMLElement>('#viewer-prompt')!
const streamHud = document.querySelector<HTMLElement>('#stream-hud')!
const touchHint = document.querySelector<HTMLElement>('#touch-hint')!
const video = document.querySelector<HTMLVideoElement>('video')!
const streamStats = createStreamStats(streamHud, video)
const portraitViewport = window.matchMedia('(orientation: portrait)')
let channel: WebSocket | undefined
let activePeer: ReturnType<typeof createPeer> | undefined
let timer: number | undefined
let interruptedTimer: number | undefined
let disconnecting: Promise<void> | undefined
let resumeToken: string | undefined
let retryDeadline = 0
let retryCount = 0
let touchChannel: RTCDataChannel | undefined
let touchEnabled = false
let followOrientation = false

function reportOrientation() {
  if (!followOrientation || !channel || !activePeer) return
  const direction = portraitViewport.matches ? 'portrait' : 'landscape'
  rotation.start(direction)
  transmit(channel, { type: 'orientation', id: activePeer.id, direction })
}

portraitViewport.addEventListener('change', reportOrientation)

const remotePointer = createViewerPointer(video.parentElement!, video, (command) => {
  if (touchChannel?.readyState !== 'open') return
  if ((command.action === 'move' || command.action === 'wheel') && touchChannel.bufferedAmount > 4096) return
  touchChannel.send(JSON.stringify(command))
}, () => {
  if (document.fullscreenElement === stage) setControlsVisible(toolbar.hidden === true)
})
const rotation = createRotationTransition(video, document.querySelector<HTMLCanvasElement>('#rotation-frame')!, (waiting) => {
  remotePointer.setEnabled(touchEnabled && !waiting && !!channel)
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
  if (!full.disabled) full.removeAttribute('title')
  if (!surface.hidden && keyboardEntry) surface.focus()
  else if (!fullscreen && restoreFocus && !full.disabled) full.focus()
}

function updateTouchMode() {
  touchEnabled = activePeer?.pc.connectionState === 'connected' && touchChannel?.readyState === 'open' && prompt.hidden === true
  remotePointer.setEnabled(touchEnabled && !rotation.waiting)
  touchHint.hidden = !touchEnabled
  updateFullscreen()
}

function resetConnection(closeCode?: number) {
  const previous = channel
  channel = undefined
  disconnecting = closeCode === VIEWER_LEAVING && previous && previous.readyState !== WebSocket.CLOSED
    ? waitForDisconnect(previous)
    : undefined
  followOrientation = false
  rotation.clear()
  remotePointer.setEnabled(false)
  touchChannel = undefined
  activePeer?.pc.close()
  activePeer = undefined
  previous?.close(closeCode)
  window.clearTimeout(timer)
  window.clearTimeout(interruptedTimer)
  interruptedTimer = undefined
  video.srcObject = null
  streamStats.reset()
  prompt.hidden = false
  fit.hidden = true
  updateTouchMode()
}

function waitForDisconnect(socket: WebSocket) {
  return new Promise<void>((resolve) => {
    const finish = () => {
      window.clearTimeout(deadline)
      socket.removeEventListener('close', finish)
      resolve()
    }
    const deadline = window.setTimeout(finish, 2000)
    socket.addEventListener('close', finish, { once: true })
  })
}

async function requestConnection() {
  const pending = disconnecting
  if (pending) {
    button.disabled = true
    status.textContent = '正在结束上一连接…'
    await pending
    if (disconnecting !== pending) return
    disconnecting = undefined
  }
  connect()
}

function end(message: string, closeCode?: number) {
  resetConnection(closeCode)
  resumeToken = undefined
  retryDeadline = 0
  retryCount = 0
  if (document.fullscreenElement === stage) void document.exitFullscreen().catch(() => {})
  status.textContent = message
  button.hidden = false
  button.disabled = false
  button.textContent = '重新连接'
  leave.disabled = true
}

function connectionLost(message: string) {
  if (!resumeToken) {
    end(message)
    return
  }
  retryDeadline ||= Date.now() + 30000
  const backoff = Math.min(500 * 2 ** retryCount, 4000)
  if (Date.now() + backoff >= retryDeadline) {
    end('自动重连超时，请点击重新连接。')
    return
  }
  resetConnection()
  status.textContent = '连接中断，正在自动重连…'
  button.hidden = true
  leave.disabled = false
  retryCount++
  timer = window.setTimeout(() => connect(true), backoff)
}

async function play() {
  const peer = activePeer
  try {
    await video.play()
  } catch {
    if (!peer || peer !== activePeer) return
    window.clearTimeout(timer)
    button.disabled = false
    button.hidden = false
    button.textContent = '播放画面'
    status.textContent = '轻触播放画面。'
  }
}

function connect(resuming = false) {
  if (activePeer && video.srcObject) {
    void play()
    return
  }
  const endpoint = new URL('/viewer', location.href)
  endpoint.protocol = 'ws:'
  endpoint.searchParams.set('token', token)
  if (resuming && resumeToken) endpoint.searchParams.set('resume', resumeToken)
  const socket = new WebSocket(endpoint)
  let opened = false
  channel = socket
  button.disabled = false
  button.hidden = true
  leave.disabled = false
  status.textContent = resuming ? '正在自动重连…' : '正在连接电脑…'
  const timeout = resuming ? Math.min(6000, Math.max(0, retryDeadline - Date.now())) : 10000
  timer = window.setTimeout(() => connectionLost('连接超时。请确认电脑仍在共享。'), timeout)
  socket.addEventListener('open', () => {
    if (channel !== socket) return
    opened = true
    if (!resuming) {
      window.clearTimeout(timer)
      status.textContent = '请在电脑端允许连接。'
    }
  })
  socket.addEventListener('close', ({ code }) => {
    if (channel !== socket) return
    if (code === SHARE_ENDED) {
      end(reconnect ? '电脑已停止共享。请返回应用并重新选择电脑。' : '电脑已停止共享。请用电脑上的新二维码重新配对。')
      button.hidden = true
    } else if (code === VIEWER_REPLACED) end('共享已在另一连接中恢复。')
    else connectionLost(opened ? '共享已断开。' : reconnect
      ? '无法连接。请确认两台设备在同一网络，然后返回应用并重新选择电脑。'
      : '无法连接。请确认两台设备在同一网络。电脑重新开始共享后，请扫新二维码。')
  })

  let queue = Promise.resolve()
  socket.addEventListener('message', ({ data }) => {
    queue = queue.then(async () => {
      if (channel !== socket) return
      const message = JSON.parse(data) as Signal
      if (message.type === 'rejected') {
        end('电脑取消了本次连接。')
      } else if (message.type === 'approved') {
        window.clearTimeout(timer)
        resumeToken = message.resumeToken
        if (message.rememberedComputer) {
          const { id, name, token } = message.rememberedComputer
          try {
            window.tabletLinkReceiver?.rememberComputer(id, name, token)
          } catch {
            // Bridge availability does not affect an approved stream.
          }
        }
        status.textContent = '正在等候第一帧画面…'
        const firstFrameTimeout = resuming ? Math.min(10000, Math.max(0, retryDeadline - Date.now())) : 20000
        timer = window.setTimeout(() => connectionLost('已连接电脑，但未收到画面。请重试。'), firstFrameTimeout)
        const peer = createPeer(message.id, (signal) => transmit(socket, signal))
        activePeer = peer
        streamStats.setConnection(message.connectionMode)
        followOrientation = message.followOrientation === true
        reportOrientation()
        peer.pc.onconnectionstatechange = () => {
          if (activePeer !== peer) return
          const state = peer.pc.connectionState
          streamStats.setInterrupted(state === 'disconnected')
          window.clearTimeout(interruptedTimer)
          interruptedTimer = undefined
          if (peer.pc.connectionState === 'failed') connectionLost('视频连接失败，请重新连接。')
          else {
            if (peer.pc.connectionState === 'disconnected') {
              interruptedTimer = window.setTimeout(() => {
                if (activePeer === peer) connectionLost('视频连接已中断。')
              }, 2000)
            }
            if (touchChannel) updateTouchMode()
          }
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
            if ('jitterBufferTarget' in receiver) receiver.jitterBufferTarget = 0
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
      if (channel === socket) connectionLost('视频协商失败，请重新连接。')
    })
  })
}

video.addEventListener('playing', () => {
  if (!activePeer || !video.srcObject) return
  window.clearTimeout(timer)
  retryDeadline = 0
  retryCount = 0
  const firstPlayback = !prompt.hidden
  if (firstPlayback && followOrientation) rotation.start(portraitViewport.matches ? 'portrait' : 'landscape')
  prompt.hidden = true
  streamStats.show()
  fit.hidden = false
  if (firstPlayback) updateTouchMode()
})

window.setInterval(async () => {
  const peer = activePeer
  if (!peer || streamHud.hidden) return
  const report = await peer.pc.getStats().catch(() => undefined)
  if (report && activePeer === peer && !streamHud.hidden) streamStats.update(report)
}, 1000)

full.addEventListener('click', async () => {
  try {
    if (document.fullscreenElement === stage) await document.exitFullscreen()
    else await stage.requestFullscreen({ navigationUI: 'hide' })
  } catch {
    full.title = '当前浏览器无法进入全屏'
    full.textContent = '全屏不可用'
    full.disabled = true
  }
})
document.addEventListener('fullscreenchange', updateFullscreen)
surface.addEventListener('click', () => setControlsVisible(toolbar.hidden === true))
fit.addEventListener('click', () => {
  fit.setAttribute('aria-pressed', String(video.classList.toggle('video-cover')))
})
leave.addEventListener('click', () => end('已断开连接。', VIEWER_LEAVING))
window.addEventListener('pagehide', () => {
  if (channel) end('已断开连接。')
})

if (!token || typeof RTCPeerConnection !== 'function') {
  button.hidden = true
  status.textContent = location.hash ? '浏览器不支持该连接，或链接已失效。' : '请用电脑端生成的二维码或完整链接打开。'
} else {
  button.addEventListener('click', () => {
    // Browsers require the gesture that opened the connection to request fullscreen.
    if (!document.fullscreenElement && document.fullscreenEnabled) {
      void stage.requestFullscreen({ navigationUI: 'hide' }).catch(() => {})
    }
    void requestConnection()
  })
  if (reconnect) void requestConnection()
}

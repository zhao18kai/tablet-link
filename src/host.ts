import { selectCaptureSource } from './displays.ts'
import { createPeer, transmit } from './peer.ts'
import type { CaptureSource, Signal, TabletLink } from './wire.ts'

declare global {
  interface Window { tabletLink: TabletLink }
}

const api = window.tabletLink
const modes = document.querySelector<HTMLFieldSetElement>('#modes')!
const extension = document.querySelector<HTMLInputElement>('#mode-extension')!
const touchOption = document.querySelector<HTMLLabelElement>('#touch-option')!
const touch = document.querySelector<HTMLInputElement>('#allow-touch')!
const displaySettings = document.querySelector<HTMLButtonElement>('#display-settings')!
const displayHint = document.querySelector<HTMLElement>('#display-hint')!
const source = document.querySelector<HTMLSelectElement>('#source')!
const network = document.querySelector<HTMLSelectElement>('#network')!
const preview = document.querySelector<HTMLImageElement>('#source-preview')!
const start = document.querySelector<HTMLButtonElement>('#start')!
const stop = document.querySelector<HTMLButtonElement>('#stop')!
const refresh = document.querySelector<HTMLButtonElement>('#refresh')!
const status = document.querySelector<HTMLElement>('#status')!
const instructions = document.querySelector<HTMLElement>('#instructions')!
const details = document.querySelector<HTMLElement>('#share-details')!
const request = document.querySelector<HTMLElement>('#request')!
const approve = document.querySelector<HTMLButtonElement>('#approve')!
const reject = document.querySelector<HTMLButtonElement>('#reject')!
const url = document.querySelector<HTMLInputElement>('#share-url')!
const qr = document.querySelector<HTMLImageElement>('#qr')!
const copy = document.querySelector<HTMLButtonElement>('#copy')!

let sources: CaptureSource[] = []
let sourceChoice: CaptureSource | null | undefined
let stream: MediaStream | undefined
let socket: WebSocket | undefined
let peer: ReturnType<typeof createPeer> | undefined
let busy = false
let requestId: string | undefined
let captureRun = 0
let topologyChanged = false
let refreshTimer: number | undefined

function setStatus(message: string, state = 'idle') {
  status.textContent = message
  status.dataset.state = state
}

function updateControls() {
  const sharing = !!stream
  modes.disabled = displaySettings.disabled = source.disabled = network.disabled = refresh.disabled = busy || sharing
  touchOption.hidden = !extension.checked
  touch.disabled = busy || sharing || !extension.checked
  start.hidden = sharing
  start.disabled = busy || !source.value || !network.value
  stop.hidden = !sharing
  stop.disabled = busy
}

function updatePreview() {
  const thumbnail = sourceChoice?.thumbnail
  preview.hidden = !thumbnail
  if (thumbnail) preview.src = thumbnail
  else preview.removeAttribute('src')
}

function fillSelect(select: HTMLSelectElement, options: ReadonlyArray<[string, string]>, empty: string) {
  const previous = select.value
  select.replaceChildren(...options.map(([value, label]) => new Option(label, value)))
  if (!options.length) select.add(new Option(empty, ''))
  if (options.some(([value]) => value === previous)) select.value = previous
}

function renderSources() {
  const candidates = sources.filter((item) => !extension.checked || item.role === 'extension')
  fillSelect(source, candidates.map(({ name, id }) => [id, name]), extension.checked ? '未检测到扩展屏' : '未找到可共享的屏幕')
  sourceChoice = selectCaptureSource(candidates, sourceChoice)
  if (sourceChoice) source.value = sourceChoice.id
  else if (candidates.length) {
    source.add(new Option('请选择要共享的屏幕', ''), 0)
    source.value = ''
  }
  displayHint.hidden = !extension.checked
  updatePreview()
}

function showReadiness() {
  if (!network.value) setStatus('请连接局域网后刷新设备')
  else if (source.value) setStatus('可以开始共享')
  else if (extension.checked && !sources.some(({ role }) => role === 'extension')) setStatus('等待 Windows 启用扩展屏')
  else setStatus('请选择要共享的屏幕')
}

function scheduleDisplayRefresh() {
  topologyChanged = true
  window.clearTimeout(refreshTimer)
  refreshTimer = window.setTimeout(() => {
    if (!busy && !stream && topologyChanged) void loadDevices()
  }, 200)
}

async function loadDevices(updateStatus = true) {
  topologyChanged = false
  busy = true
  updateControls()
  try {
    const [availableSources, networks] = await Promise.all([api.sources(), api.networks()])
    sources = availableSources
    fillSelect(network, networks.map(({ name, address }) => [address, `${name} · ${address}`]), '未连接到局域网')
    renderSources()
    if (updateStatus) showReadiness()
  } catch {
    setStatus('读取设备失败，请点击刷新设备重试。', 'error')
  } finally {
    busy = false
    updateControls()
    if (topologyChanged) scheduleDisplayRefresh()
  }
}

function closePeer() {
  if (peer) api.remotePointer('{"action":"cancel"}')
  peer?.pc.close()
  peer = undefined
}

async function endShare(message: string, state = 'idle') {
  const run = ++captureRun
  const currentSocket = socket
  socket = undefined
  currentSocket?.close()
  closePeer()
  stream?.getTracks().forEach((track) => track.stop())
  stream = undefined
  requestId = undefined
  request.hidden = details.hidden = true
  instructions.hidden = false
  url.value = ''
  qr.removeAttribute('src')
  busy = true
  updateControls()
  try {
    await api.stop()
    if (captureRun === run) setStatus(message, state)
  } catch {
    if (captureRun === run) setStatus('停止共享时发生错误，请关闭应用。', 'error')
  } finally {
    if (captureRun === run) {
      busy = false
      updateControls()
      if (topologyChanged) await loadDevices(false)
    }
  }
}

function attachSignaling(channel: WebSocket, media: MediaStream, allowTouch: boolean) {
  let queue = Promise.resolve()
  const fail = (id: string) => {
    closePeer()
    transmit(channel, { type: 'reject', id })
    setStatus('视频连接失败，请让平板重新请求。', 'error')
  }
  channel.addEventListener('message', ({ data }) => {
    queue = queue.then(async () => {
      if (socket !== channel) return
      const message = JSON.parse(data) as Signal
      if (message.type === 'viewer-request') {
        requestId = message.id
        request.hidden = message.resumed === true
        approve.disabled = reject.disabled = false
        setStatus(message.resumed ? '正在恢复平板连接…' : '平板正在请求观看', 'pending')
      } else if (message.id !== requestId) {
        return
      } else if (message.type === 'viewer-left') {
        closePeer()
        requestId = undefined
        request.hidden = true
        if (status.dataset.state !== 'error') setStatus('等待平板连接', 'pending')
      } else if (message.type === 'approved') {
        const active = createPeer(message.id, (signal) => {
          if (peer === active) transmit(channel, signal)
        })
        peer = active
        active.pc.onconnectionstatechange = () => {
          if (peer !== active) return
          if (active.pc.connectionState === 'connected') setStatus('正在向平板传输画面', 'active')
          if (active.pc.connectionState === 'disconnected') {
            if (allowTouch) api.remotePointer('{"action":"cancel"}')
            setStatus('连接暂时中断，等待恢复', 'pending')
          }
          if (active.pc.connectionState === 'failed') {
            closePeer()
            setStatus('视频连接中断，等待平板重连', 'pending')
          }
        }
        active.pc.addTrack(media.getVideoTracks()[0], media)
        if (allowTouch) {
          const controls = active.pc.createDataChannel('tablet-link-pointer')
          controls.onmessage = ({ data }) => {
            if (peer === active && active.pc.connectionState === 'connected' && typeof data === 'string' && data.length <= 160) {
              api.remotePointer(data)
            }
          }
          controls.onclose = () => {
            if (peer === active) api.remotePointer('{"action":"cancel"}')
          }
        }
        await active.publish('offer')
      } else await peer?.accept(message)
    }).catch(() => {
      if (socket === channel && requestId) fail(requestId)
    })
  })
  channel.addEventListener('close', () => {
    if (socket === channel) void endShare('共享服务已断开，请重新开始。', 'error')
  })
}

async function beginShare() {
  const selected = sourceChoice
  if (!selected) return
  const run = ++captureRun
  const allowTouch = extension.checked && touch.checked
  busy = true
  updateControls()
  setStatus('正在启动屏幕共享…', 'pending')
  try {
    await api.selectSource(selected.id, selected.displayId, extension.checked ? 'extension' : 'screen')
    if (captureRun !== run) return
    const media = await navigator.mediaDevices.getDisplayMedia({
      video: { width: { max: 1920 }, height: { max: 1250 }, frameRate: { ideal: 60, max: 60 } },
      audio: false,
    })
    if (captureRun !== run) {
      media.getTracks().forEach((track) => track.stop())
      return
    }
    stream = media
    const [track] = media.getVideoTracks()
    track.contentHint = 'detail'
    if (track.readyState === 'ended') throw new Error('所选屏幕已停止捕获。')
    track.addEventListener('ended', () => {
      if (captureRun === run) void endShare('所选屏幕已停止捕获。', 'error')
    }, { once: true })
    const share = await api.start(network.value, allowTouch)
    if (captureRun !== run) return
    const channel = new WebSocket(share.hostUrl)
    socket = channel
    await new Promise<void>((resolve, rejectOpen) => {
      channel.addEventListener('open', () => resolve(), { once: true })
      channel.addEventListener('error', () => rejectOpen(new Error('无法启动局域网连接。')), { once: true })
      channel.addEventListener('close', () => rejectOpen(new Error('局域网连接已关闭。')), { once: true })
    })
    if (captureRun !== run) return
    attachSignaling(channel, media, allowTouch)
    url.value = share.viewerUrl
    qr.src = share.qr
    instructions.hidden = true
    details.hidden = false
    copy.textContent = '复制链接'
    setStatus('等待平板连接', 'pending')
    busy = false
    updateControls()
  } catch (error) {
    if (captureRun !== run) return
    const message = error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+': Error: /, '') : '请重试。'
    await endShare(`无法开始共享。${message}`, 'error')
  }
}

source.addEventListener('change', () => {
  sourceChoice = sources.find(({ id }) => id === source.value) ?? null
  updatePreview()
  showReadiness()
  updateControls()
})
network.addEventListener('change', () => {
  showReadiness()
  updateControls()
})
modes.addEventListener('change', () => {
  sourceChoice = undefined
  renderSources()
  showReadiness()
  updateControls()
})
displaySettings.addEventListener('click', () => {
  void api.openDisplaySettings().catch(() => setStatus('请从 Windows 设置打开显示设置。', 'error'))
})
refresh.addEventListener('click', () => void loadDevices())
start.addEventListener('click', () => void beginShare())
stop.addEventListener('click', () => void endShare('已停止共享'))
approve.addEventListener('click', () => {
  if (!socket || !requestId) return
  request.hidden = true
  setStatus('正在建立视频连接…', 'pending')
  transmit(socket, { type: 'approve', id: requestId })
})
reject.addEventListener('click', () => {
  if (!socket || !requestId) return
  request.hidden = true
  transmit(socket, { type: 'reject', id: requestId })
})
copy.addEventListener('click', () => void api.copy(url.value).then(() => { copy.textContent = '已复制' }))
api.onDisplaysChanged(scheduleDisplayRefresh)
api.onCaptureLost(() => {
  sourceChoice = null
  topologyChanged = true
  void endShare('所选屏幕已断开或退出扩展模式。', 'error')
})
void loadDevices()

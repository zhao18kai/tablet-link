import { createPeer, transmit } from './peer.ts'
import type { CaptureSource, Signal, TabletLink } from './wire.ts'

declare global {
  interface Window { tabletLink: TabletLink }
}

const api = window.tabletLink
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
let stream: MediaStream | undefined
let socket: WebSocket | undefined
let peer: ReturnType<typeof createPeer> | undefined
let busy = false
let requestId: string | undefined

function setStatus(message: string, state = 'idle') {
  status.textContent = message
  status.dataset.state = state
}

function updateControls() {
  const sharing = !!stream
  source.disabled = network.disabled = refresh.disabled = busy || sharing
  start.hidden = sharing
  start.disabled = busy || !source.value || !network.value
  stop.hidden = !sharing
  stop.disabled = busy
}

function updatePreview() {
  const thumbnail = sources.find(({ id }) => id === source.value)?.thumbnail
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

async function loadDevices() {
  busy = true
  updateControls()
  try {
    const [availableSources, networks] = await Promise.all([api.sources(), api.networks()])
    sources = availableSources
    fillSelect(source, sources.map(({ name, id }) => [id, name]), '未找到可共享的屏幕')
    fillSelect(network, networks.map(({ name, address }) => [address, `${name} · ${address}`]), '未连接到局域网')
    updatePreview()
    setStatus(networks.length && sources.length ? '可以开始共享' : '连接网络或屏幕后，点击刷新设备')
  } catch {
    setStatus('读取设备失败，请点击刷新设备重试。', 'error')
  } finally {
    busy = false
    updateControls()
  }
}

function closePeer() {
  peer?.pc.close()
  peer = undefined
}

async function endShare(message: string, state = 'idle') {
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
    setStatus(message, state)
  } catch {
    setStatus('停止共享时发生错误，请关闭应用。', 'error')
  } finally {
    busy = false
    updateControls()
  }
}

function attachSignaling(channel: WebSocket, media: MediaStream) {
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
        request.hidden = false
        approve.disabled = reject.disabled = false
        setStatus('平板正在请求观看', 'pending')
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
          if (active.pc.connectionState === 'disconnected') setStatus('连接暂时中断，等待恢复', 'pending')
          if (active.pc.connectionState === 'failed') fail(active.id)
        }
        active.pc.addTrack(media.getVideoTracks()[0], media)
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
  busy = true
  updateControls()
  setStatus('正在启动屏幕共享…', 'pending')
  try {
    await api.selectSource(source.value)
    const media = await navigator.mediaDevices.getDisplayMedia({
      video: { width: { max: 1920 }, height: { max: 1250 }, frameRate: { ideal: 30, max: 30 } },
      audio: false,
    })
    stream = media
    const [track] = media.getVideoTracks()
    track.contentHint = 'detail'
    const share = await api.start(network.value)
    const channel = new WebSocket(share.hostUrl)
    socket = channel
    await new Promise<void>((resolve, rejectOpen) => {
      channel.addEventListener('open', () => resolve(), { once: true })
      channel.addEventListener('error', () => rejectOpen(new Error('无法启动局域网连接。')), { once: true })
    })
    if (track.readyState === 'ended') throw new Error('所选屏幕已停止捕获。')
    track.addEventListener('ended', () => void endShare('所选屏幕已停止捕获。'), { once: true })
    attachSignaling(channel, media)
    url.value = share.viewerUrl
    qr.src = share.qr
    instructions.hidden = true
    details.hidden = false
    copy.textContent = '复制链接'
    setStatus('等待平板连接', 'pending')
    busy = false
    updateControls()
  } catch (error) {
    const message = error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+': Error: /, '') : '请重试。'
    await endShare(`无法开始共享。${message}`, 'error')
  }
}

source.addEventListener('change', updatePreview)
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
void loadDevices()

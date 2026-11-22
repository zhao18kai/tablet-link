import { selectCaptureSource, type DisplaySide } from './displays.ts'
import { createDragMotion } from './drag-motion.ts'
import { createPeer, preferScreenCodec, transmit } from './peer.ts'
import { parsePointerCommand } from './pointer.ts'
import { readSavedShare, restoreNetwork, type SavedShare } from './share-preferences.ts'
import { AUTOMATIC_CAPTURE_EVENT, AUTOMATIC_DISPLAY, type CaptureSource, type ConnectionMode, type NetworkAddress, type Signal, type TabletLink } from './wire.ts'

declare global {
  interface Window { tabletLink: TabletLink }
}

const api = window.tabletLink
const modes = document.querySelector<HTMLFieldSetElement>('#modes')!
const extension = document.querySelector<HTMLInputElement>('#mode-extension')!
const touchOption = document.querySelector<HTMLLabelElement>('#touch-option')!
const touch = document.querySelector<HTMLInputElement>('#allow-touch')!
const orientationOption = document.querySelector<HTMLLabelElement>('#orientation-option')!
const orientation = document.querySelector<HTMLInputElement>('#follow-orientation')!
const displaySettings = document.querySelector<HTMLButtonElement>('#display-settings')!
const displayHint = document.querySelector<HTMLElement>('#display-hint')!
const source = document.querySelector<HTMLSelectElement>('#source')!
const network = document.querySelector<HTMLSelectElement>('#network')!
const connectionMode = document.querySelector<HTMLSelectElement>('#connection-mode')!
const usbHint = document.querySelector<HTMLElement>('#usb-hint')!
const connectionInstruction = document.querySelector<HTMLElement>('#connection-instruction')!
const placement = document.querySelector<HTMLElement>('#placement')!
const referenceScreen = document.querySelector<HTMLSelectElement>('#reference-screen')!
const displaySide = document.querySelector<HTMLSelectElement>('#display-side')!
const applyPosition = document.querySelector<HTMLButtonElement>('#apply-position')!
const positionStatus = document.querySelector<HTMLElement>('#position-status')!
const captureSize = document.querySelector<HTMLSelectElement>('#capture-size')!
const captureFps = document.querySelector<HTMLSelectElement>('#capture-fps')!
const applyQuality = document.querySelector<HTMLButtonElement>('#apply-quality')!
const qualityStatus = document.querySelector<HTMLElement>('#quality-status')!
const startupOption = document.querySelector<HTMLElement>('#startup-option')!
const launchAtLogin = document.querySelector<HTMLInputElement>('#launch-at-login')!
const shareAtLogin = document.querySelector<HTMLInputElement>('#share-at-login')!
const startupStatus = document.querySelector<HTMLElement>('#startup-status')!
const pageTitle = document.querySelector<HTMLElement>('#page-title')!
const pages = [...document.querySelectorAll<HTMLButtonElement>('.sidebar-nav button')]
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
const automaticSource: CaptureSource = {
  id: AUTOMATIC_DISPLAY, displayId: '', role: 'extension', name: '自动创建虚拟副屏', thumbnail: '', canRotate: true,
}
const loginShareKey = 'tablet-link:share-at-login'
const savedShareKey = 'tablet-link:last-share'
shareAtLogin.checked = localStorage.getItem(loginShareKey) === 'true'

let sources: CaptureSource[] = []
let networks: NetworkAddress[] = []
let sourceChoice: CaptureSource | null | undefined
let stream: MediaStream | undefined
let captureFollowsOrientation = false
let applyingQuality = false
let appliedQuality = { size: restoreQuality(captureSize), fps: restoreQuality(captureFps) }
let socket: WebSocket | undefined
let peer: ReturnType<typeof createPeer> | undefined
let dragMotion: ReturnType<typeof createDragMotion> | undefined
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
  const sharing = !!socket || !!stream
  modes.disabled = displaySettings.disabled = source.disabled = connectionMode.disabled = refresh.disabled = busy || sharing
  network.disabled = busy || sharing || !network.value
  touchOption.hidden = !extension.checked
  touch.disabled = busy || sharing || !extension.checked
  orientationOption.hidden = !extension.checked || !sourceChoice?.canRotate
  placement.hidden = orientationOption.hidden || sourceChoice === automaticSource
  orientation.disabled = busy || sharing || orientationOption.hidden
  referenceScreen.disabled = displaySide.disabled = applyPosition.disabled = busy || sharing || placement.hidden || !referenceScreen.value
  start.hidden = sharing
  start.disabled = busy || applyingQuality || !source.value || !network.value
  stop.hidden = !sharing
  stop.disabled = busy
  captureSize.disabled = captureFps.disabled = applyingQuality
  applyQuality.disabled = busy || applyingQuality ||
    (captureSize.value === appliedQuality.size && captureFps.value === appliedQuality.fps)
}

function restoreQuality(field: HTMLSelectElement) {
  const saved = localStorage.getItem('tablet-link:' + field.id)
  if (saved && [...field.options].some(({ value }) => value === saved)) field.value = saved
  return field.value
}

function captureConstraints(quality: typeof appliedQuality, followOrientation: boolean): MediaTrackConstraints {
  const size = Number(quality.size)
  const fps = Number(quality.fps)
  return {
    width: { max: size },
    height: { max: followOrientation ? size : 2 * Math.round(size * 625 / 1920) },
    frameRate: { ideal: fps, max: fps },
  }
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
  const candidates = extension.checked ? [automaticSource, ...sources.filter(({ role }) => role === 'extension')] : sources
  fillSelect(source, candidates.map(({ name, id }) => [id, name]), extension.checked ? '未检测到扩展屏' : '未找到可共享的屏幕')
  sourceChoice = selectCaptureSource(candidates, sourceChoice)
  if (sourceChoice) source.value = sourceChoice.id
  else if (candidates.length) {
    source.add(new Option('请选择要共享的屏幕', ''), 0)
    source.value = ''
  }
  displayHint.hidden = !extension.checked
  const references = sources.filter(({ role, canRotate }) => role === 'primary' || (role === 'extension' && !canRotate))
    .sort((left, right) => Number(right.role === 'primary') - Number(left.role === 'primary'))
  fillSelect(referenceScreen, references.map(({ displayId, name }) => [displayId, name]), '没有可用的参考屏')
  updatePreview()
}

function renderNetworks() {
  const usb = connectionMode.value === 'usb'
  const choices = networks.filter(({ mode }) => mode === connectionMode.value)
  fillSelect(network, choices.map(({ name, address }) => [address, name + ' · ' + address]), usb ? '未检测到 USB 网络' : '未连接到局域网')
  usbHint.hidden = !usb
  connectionInstruction.textContent = usb ? '用数据线连接平板，并开启平板的 USB 共享网络。' : '让电脑和 MatePad 接入同一个局域网。'
}

function showReadiness() {
  if (!network.value) setStatus(connectionMode.value === 'usb' ? '等待 USB 共享网络' : '请连接局域网后刷新设备')
  else if (sourceChoice === automaticSource) setStatus('平板获准后将创建副屏')
  else if (source.value) setStatus('可以开始共享')
  else if (extension.checked && !sources.some(({ role }) => role === 'extension')) setStatus('等待 Windows 启用扩展屏')
  else setStatus('请选择要共享的屏幕')
}

function scheduleDisplayRefresh() {
  topologyChanged = true
  window.clearTimeout(refreshTimer)
  refreshTimer = window.setTimeout(() => {
    if (!busy && !socket && !stream && topologyChanged) void loadDevices()
  }, 200)
}

async function loadDevices(updateStatus = true) {
  topologyChanged = false
  busy = true
  updateControls()
  try {
    const [availableSources, availableNetworks] = await Promise.all([api.sources(), api.networks()])
    sources = availableSources
    networks = availableNetworks
    renderNetworks()
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

function resetPointer() {
  dragMotion?.reset()
  if (peer) api.remotePointer('{"action":"cancel"}')
}

function closePeer() {
  resetPointer()
  dragMotion = undefined
  peer?.pc.close()
  peer = undefined
}

function stopCapture() {
  stream?.getTracks().forEach((track) => track.stop())
  stream = undefined
}

async function captureScreen(followOrientation: boolean) {
  const media = await navigator.mediaDevices.getDisplayMedia({
    video: captureConstraints(appliedQuality, followOrientation),
    audio: false,
  })
  const [track] = media.getVideoTracks()
  if (track.readyState === 'ended') {
    media.getTracks().forEach((item) => item.stop())
    throw new Error('所选屏幕已停止捕获。')
  }
  track.contentHint = 'detail'
  return media
}

function captureApprovedDisplay(id: string, followOrientation: boolean) {
  return new Promise<MediaStream>((resolve, rejectCapture) => {
    const capture = () => { void captureScreen(followOrientation).then(resolve, rejectCapture) }
    window.addEventListener(AUTOMATIC_CAPTURE_EVENT, capture, { once: true })
    void api.captureAutomaticDisplay(id).catch((error: unknown) => {
      window.removeEventListener(AUTOMATIC_CAPTURE_EVENT, capture)
      rejectCapture(error)
    })
  })
}

function errorMessage(error: unknown, fallback: string) {
  return error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+': Error: /, '') : fallback
}

async function endShare(message: string, state = 'idle') {
  const run = ++captureRun
  const currentSocket = socket
  socket = undefined
  currentSocket?.close()
  closePeer()
  stopCapture()
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

async function usesUsbAddress(pc: RTCPeerConnection, address: string) {
  const report = await pc.getStats()
  const transport = [...report.values()].find((item) => item.type === 'transport' && item.selectedCandidatePairId)
  const pair = transport && report.get(transport.selectedCandidatePairId)
  return !!pair && report.get(pair.localCandidateId)?.address === address
}

function attachSignaling(
  channel: WebSocket, allowTouch: boolean, automatic: boolean, followOrientation: boolean,
  codec?: 'video/VP8' | 'video/H264', usbAddress?: string,
) {
  let queue = Promise.resolve()
  const fail = (id: string, message = '视频连接失败，请让平板重新请求。') => {
    closePeer()
    if (automatic) stopCapture()
    transmit(channel, { type: 'reject', id })
    setStatus(message, 'error')
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
        if (automatic) stopCapture()
        requestId = undefined
        request.hidden = true
        if (status.dataset.state !== 'error') setStatus('等待平板连接', 'pending')
      } else if (message.type === 'approved') {
        if (automatic) {
          setStatus('正在创建虚拟副屏…', 'pending')
          const media = await captureApprovedDisplay(message.id, followOrientation)
          if (socket !== channel) {
            media.getTracks().forEach((track) => track.stop())
            return
          }
          stream = media
          media.getVideoTracks()[0].addEventListener('ended', () => {
            if (socket === channel && stream === media) fail(message.id, '虚拟副屏已断开，请让平板重新请求。')
          }, { once: true })
        }
        const media = stream
        if (!media) throw new Error('共享画面尚未就绪。')
        const active = createPeer(message.id, (signal) => {
          if (peer === active) transmit(channel, signal)
        }, usbAddress)
        peer = active
        const sender = active.pc.addTrack(media.getVideoTracks()[0], media)
        if (codec) preferScreenCodec(active.pc, sender, codec)
        dragMotion = allowTouch ? createDragMotion(sender) : undefined
        active.pc.onconnectionstatechange = async () => {
          if (peer !== active) return
          if (active.pc.connectionState === 'connected') {
            if (usbAddress) {
              const onUsb = await usesUsbAddress(active.pc, usbAddress).catch(() => false)
              if (peer !== active || active.pc.connectionState !== 'connected') return
              if (!onUsb) {
                fail(message.id)
                setStatus('视频未走所选 USB 网卡，请检查平板的 USB 共享网络。', 'error')
                return
              }
            }
            void dragMotion?.enable()
            setStatus('正在向平板传输画面', 'active')
          }
          if (active.pc.connectionState === 'disconnected') {
            if (allowTouch) resetPointer()
            setStatus('连接暂时中断，等待恢复', 'pending')
          }
          if (active.pc.connectionState === 'failed') {
            closePeer()
            setStatus('视频连接中断，等待平板重连', 'pending')
          }
        }
        if (allowTouch) {
          const controls = active.pc.createDataChannel('tablet-link-pointer')
          controls.onmessage = ({ data }) => {
            if (peer === active && active.pc.connectionState === 'connected' && typeof data === 'string') {
              const command = parsePointerCommand(data)
              if (!command) return
              api.remotePointer(data)
              dragMotion?.input(command)
            }
          }
          controls.onclose = () => {
            if (peer === active) resetPointer()
          }
        }
        await active.publish('offer')
      } else await peer?.accept(message)
    }).catch((error: unknown) => {
      if (socket === channel && requestId) fail(requestId, automatic ? errorMessage(error, '无法创建虚拟副屏。') : undefined)
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
  const automatic = selected === automaticSource
  const allowTouch = extension.checked && touch.checked
  const rotatable = extension.checked && selected.canRotate
  const followOrientation = rotatable && orientation.checked
  const mode = connectionMode.value as ConnectionMode
  const address = network.value
  const adapter = networks.find((item) => item.address === address && item.mode === mode)
  busy = true
  updateControls()
  setStatus('正在启动屏幕共享…', 'pending')
  try {
    if (!automatic) {
      await api.selectSource(selected.id, selected.displayId, extension.checked ? 'extension' : 'screen')
      if (captureRun !== run) return
      const media = await captureScreen(followOrientation)
      if (captureRun !== run) {
        media.getTracks().forEach((track) => track.stop())
        return
      }
      stream = media
      media.getVideoTracks()[0].addEventListener('ended', () => {
        if (captureRun === run) void endShare('所选屏幕已停止捕获。', 'error')
      }, { once: true })
    }
    captureFollowsOrientation = followOrientation
    const share = await api.start(address, allowTouch, followOrientation, mode, automatic)
    if (captureRun !== run) return
    const channel = new WebSocket(share.hostUrl)
    socket = channel
    await new Promise<void>((resolve, rejectOpen) => {
      channel.addEventListener('open', () => resolve(), { once: true })
      channel.addEventListener('error', () => rejectOpen(new Error('无法启动局域网连接。')), { once: true })
      channel.addEventListener('close', () => rejectOpen(new Error('局域网连接已关闭。')), { once: true })
    })
    if (captureRun !== run) return
    // VP8 resumes faster when Windows changes the capture dimensions during a rotation.
    const codec = rotatable ? (followOrientation ? 'video/VP8' : 'video/H264') : undefined
    attachSignaling(channel, allowTouch, automatic, followOrientation, codec, mode === 'usb' ? address : undefined)
    url.value = share.viewerUrl
    qr.src = share.qr
    instructions.hidden = true
    details.hidden = false
    copy.textContent = '复制链接'
    setStatus('等待平板连接', 'pending')
    if (adapter) {
      const saved: SavedShare = {
        extension: extension.checked, automatic, displayId: selected.displayId, displayName: selected.name,
        networkName: adapter.name, address, mode, allowTouch, followOrientation,
      }
      try { localStorage.setItem(savedShareKey, JSON.stringify(saved)) }
      catch (error) { console.warn('无法保存上次的共享设置。', error) }
    }
    busy = false
    updateControls()
  } catch (error) {
    if (captureRun !== run) return
    await endShare(`无法开始共享。${errorMessage(error, '请重试。')}`, 'error')
  }
}

source.addEventListener('change', () => {
  sourceChoice = source.value === AUTOMATIC_DISPLAY ? automaticSource : sources.find(({ id }) => id === source.value) ?? null
  positionStatus.textContent = ''
  updatePreview()
  showReadiness()
  updateControls()
})
network.addEventListener('change', () => {
  showReadiness()
  updateControls()
})
connectionMode.addEventListener('change', () => {
  renderNetworks()
  showReadiness()
  updateControls()
})
modes.addEventListener('change', () => {
  sourceChoice = undefined
  positionStatus.textContent = ''
  renderSources()
  showReadiness()
  updateControls()
})
displaySettings.addEventListener('click', () => {
  void api.openDisplaySettings().catch(() => setStatus('请从 Windows 设置打开显示设置。', 'error'))
})
for (const field of [referenceScreen, displaySide]) {
  field.addEventListener('change', () => { positionStatus.textContent = '' })
}
applyPosition.addEventListener('click', async () => {
  if (!sourceChoice?.canRotate || !referenceScreen.value || busy || stream) return
  busy = true
  updateControls()
  positionStatus.textContent = '正在应用…'
  try {
    await api.placeDisplay(sourceChoice.displayId, referenceScreen.value, displaySide.value as DisplaySide)
    positionStatus.textContent = '已应用副屏位置'
  } catch (error) {
    positionStatus.textContent = error instanceof Error
      ? error.message.replace(/^Error invoking remote method '[^']+': Error: /, '') : '无法调整副屏位置。'
  } finally {
    busy = false
    updateControls()
    if (topologyChanged) scheduleDisplayRefresh()
  }
})
for (const page of pages) {
  page.addEventListener('click', () => {
    pageTitle.textContent = page.textContent
    for (const item of pages) {
      if (item === page) item.setAttribute('aria-current', 'page')
      else item.removeAttribute('aria-current')
      document.getElementById(item.dataset.page!)!.hidden = item !== page
    }
  })
}
for (const field of [captureSize, captureFps]) {
  field.addEventListener('change', () => {
    qualityStatus.textContent = ''
    updateControls()
  })
}
applyQuality.addEventListener('click', async () => {
  if (applyQuality.disabled) return
  const next = { size: captureSize.value, fps: captureFps.value }
  const track = stream?.getVideoTracks()[0]
  applyingQuality = true
  qualityStatus.textContent = '正在应用…'
  updateControls()
  try {
    if (track?.readyState === 'live') {
      await track.applyConstraints(captureConstraints(next, captureFollowsOrientation))
    }
    localStorage.setItem('tablet-link:' + captureSize.id, next.size)
    localStorage.setItem('tablet-link:' + captureFps.id, next.fps)
    appliedQuality = next
    qualityStatus.textContent = track?.readyState === 'live' ? '已应用到当前共享' : '已保存，下次共享时生效'
  } catch {
    qualityStatus.textContent = '应用失败，请重试。'
  } finally {
    applyingQuality = false
    updateControls()
  }
})
async function updateStartupSetting(requested?: boolean) {
  launchAtLogin.disabled = true
  startupStatus.textContent = ''
  try {
    const enabled = await api.launchAtLogin(requested)
    startupOption.hidden = enabled === null
    launchAtLogin.checked = enabled === true
    shareAtLogin.disabled = enabled !== true
    if (requested !== undefined && enabled !== requested) startupStatus.textContent = '无法保存自启设置。'
  } catch {
    startupOption.hidden = false
    if (requested !== undefined) launchAtLogin.checked = !requested
    startupStatus.textContent = requested === undefined ? '无法读取自启设置。' : '无法保存自启设置。'
  } finally {
    launchAtLogin.disabled = false
  }
  return launchAtLogin.checked
}

launchAtLogin.addEventListener('change', () => void updateStartupSetting(launchAtLogin.checked))
shareAtLogin.addEventListener('change', async () => {
  const requested = shareAtLogin.checked
  if (requested) {
    shareAtLogin.disabled = true
    shareAtLogin.checked = await updateStartupSetting(true)
  }
  localStorage.setItem(loginShareKey, String(shareAtLogin.checked))
})
window.addEventListener('focus', () => { if (!launchAtLogin.disabled) void updateStartupSetting() })
void updateStartupSetting()
void api.getVersion().then((version) => {
  document.querySelector('#app-version')!.textContent = '版本 ' + version
}).catch(() => {})
document.querySelector('#open-project')!.addEventListener('click', () => {
  void api.openProject().catch(() => setStatus('无法打开 GitHub 项目页面。', 'error'))
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
  if (socket && requestId && sourceChoice === automaticSource) {
    closePeer()
    stopCapture()
    transmit(socket, { type: 'reject', id: requestId })
    setStatus('虚拟副屏已断开，请让平板重新请求。', 'error')
    return
  }
  sourceChoice = null
  topologyChanged = true
  void endShare('所选屏幕已断开或退出扩展模式。', 'error')
})
api.onDisplayCleanupFailed(() => setStatus('Windows 未能回收自动副屏，请检查 Windows 显示设置。', 'error'))

async function startup() {
  const initialRun = captureRun
  let manuallyChanged = false
  const controls = document.querySelector('#connection')!
  const markChanged = () => { manuallyChanged = true }
  controls.addEventListener('change', markChanged)
  try {
    await loadDevices()
    if (!shareAtLogin.checked || !await api.startedAtLogin()) return
    const saved = readSavedShare(localStorage.getItem(savedShareKey))
    if (!saved) {
      setStatus('请先手动开始一次共享，以保存自启设置。')
      return
    }
    for (let attempt = 0; attempt < 6; attempt++) {
      if (manuallyChanged || captureRun !== initialRun || !shareAtLogin.checked) return
      const display = saved.automatic && saved.extension ? automaticSource : sources.find((item) =>
        !!saved.displayId && item.displayId === saved.displayId && item.name === saved.displayName &&
        (!saved.extension || item.role === 'extension'))
      const adapter = restoreNetwork(saved, networks)
      if (display && adapter) {
        modes.querySelector<HTMLInputElement>(`input[value="${saved.extension ? 'extension' : 'screen'}"]`)!.checked = true
        sourceChoice = display
        connectionMode.value = saved.mode
        renderSources()
        renderNetworks()
        network.value = adapter.address
        touch.checked = saved.allowTouch
        orientation.checked = saved.followOrientation
        updateControls()
        await api.startLoginShare()
        return
      }
      if (attempt < 5) {
        setStatus('等待上次使用的屏幕和网络…', 'pending')
        await new Promise((resolve) => window.setTimeout(resolve, 2000))
        if (manuallyChanged || captureRun !== initialRun || !shareAtLogin.checked) return
        await loadDevices(false)
      }
    }
    setStatus('找不到上次使用的屏幕或网卡，请重新选择后共享。', 'error')
  } catch (error) {
    if (captureRun === initialRun) setStatus(errorMessage(error, '无法自动开始共享。'), 'error')
  } finally {
    controls.removeEventListener('change', markChanged)
  }
}

void startup()

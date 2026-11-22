import { app, BrowserWindow, clipboard, desktopCapturer, ipcMain, Menu, screen, shell } from 'electron'
import { networkInterfaces } from 'node:os'
import { join } from 'node:path'
import qrcode from 'qrcode-generator'
import { getDisplayRole } from './displays.ts'
import { startLanServer } from './lan.ts'
import { displayPointerPosition, parsePointerCommand } from './pointer.ts'
import { openWindowsPointer } from './windows-pointer.ts'
import type { CaptureMode, ShareInfo } from './wire.ts'

function networks() {
  return Object.entries(networkInterfaces()).flatMap(([name, entries]) =>
    (entries ?? [])
      .filter(({ address, family, internal }) => family === 'IPv4' && !internal &&
        /^(192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/.test(address))
      .map(({ address }) => ({ name, address })),
  ).sort((left, right) => Number(/wi-?fi|wlan/i.test(right.name)) - Number(/wi-?fi|wlan/i.test(left.name)))
}

interface Capture {
  source: Electron.DesktopCapturerSource
  mode: CaptureMode
}

function captureIsAvailable(capture: Capture) {
  const id = capture.source.display_id
  const displays = screen.getAllDisplays()
  if (capture.mode === 'screen') return !id || displays.some((display) => String(display.id) === id)
  return getDisplayRole(id, displays, screen.getPrimaryDisplay().id) === 'extension'
}

async function openWindow() {
  Menu.setApplicationMenu(null)
  const window = new BrowserWindow({
    title: '平板智联',
    width: 945,
    height: 685,
    minWidth: 650,
    minHeight: 540,
    backgroundColor: '#eef2ef',
    webPreferences: { preload: join(__dirname, 'preload.cjs') },
  })

  let selected: Capture | undefined
  let capturing: Capture | undefined
  let share: Awaited<ReturnType<typeof startLanServer>> | undefined
  let pointer: Awaited<ReturnType<typeof openWindowsPointer>> | undefined
  let starting: Promise<ShareInfo> | undefined
  let stopping: Promise<void> | undefined
  let captureEpoch = 0

  async function stopShare() {
    if (stopping) return stopping
    captureEpoch++
    selected = capturing = undefined
    const oldPointer = pointer
    pointer = undefined
    const previous = share
    share = undefined
    stopping = Promise.all([oldPointer?.close(), previous?.stop(), starting?.catch(() => undefined)])
      .then(() => { stopping = undefined })
    await stopping
  }

  function onTopologyChange(removedId?: number) {
    if (window.isDestroyed()) return
    captureEpoch++
    selected = undefined
    const unavailable = (capture: Capture) => String(removedId) === capture.source.display_id || !captureIsAvailable(capture)
    if (capturing && (!share || unavailable(capturing))) {
      window.webContents.send('capture-lost')
      void stopShare()
    }
    window.webContents.send('displays-changed')
  }

  const onDisplaysChanged = () => onTopologyChange()
  const onDisplayRemoved = (_event: Electron.Event, display: Electron.Display) => onTopologyChange(display.id)
  screen.on('display-added', onDisplaysChanged)
  screen.on('display-removed', onDisplayRemoved)
  screen.on('display-metrics-changed', onDisplaysChanged)

  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-navigate', (event) => event.preventDefault())
  window.webContents.session.setDisplayMediaRequestHandler((request, callback) => {
    const capture = selected
    selected = undefined
    if (!capture || request.frame !== window.webContents.mainFrame || !request.userGesture ||
        !request.videoRequested || request.audioRequested) {
      callback({})
      return
    }
    const epoch = captureEpoch
    void desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } }).then((sources) => {
      const source = sources.find((item) => item.id === capture.source.id && item.display_id === capture.source.display_id)
      if (!source || epoch !== captureEpoch || !captureIsAvailable(capture)) callback({})
      else {
        capturing = { source, mode: capture.mode }
        callback({ video: source })
      }
    }, () => callback({}))
  })

  function fromHost(event: Electron.IpcMainEvent | Electron.IpcMainInvokeEvent) {
    return !window.isDestroyed() && event.sender === window.webContents && event.senderFrame === window.webContents.mainFrame
  }

  function handle(name: string, action: (...args: string[]) => unknown) {
    ipcMain.handle(name, (event, ...args: string[]) => {
      if (!fromHost(event)) throw new Error('无效的桌面窗口。')
      return action(...args)
    })
  }

  const onRemotePointer = (event: Electron.IpcMainEvent, raw: unknown) => {
    if (!pointer || !share || !fromHost(event)) return
    const command = parsePointerCommand(raw)
    if (command) pointer.send(command)
  }
  ipcMain.on('remote-pointer', onRemotePointer)

  handle('sources', async () => {
    const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 320, height: 180 } })
    const displays = screen.getAllDisplays()
    const primaryId = screen.getPrimaryDisplay().id
    return sources.map((source, index) => {
      const display = displays.find(({ id }) => String(id) === source.display_id)
      const role = getDisplayRole(source.display_id, displays, primaryId)
      const roleLabels = { primary: ' · 主屏', extension: ' · 扩展屏', mirror: ' · 复制屏', unknown: '' }
      return {
        id: source.id,
        displayId: source.display_id,
        role,
        name: `${display?.label || `屏幕 ${index + 1}`}${roleLabels[role]}`,
        thumbnail: source.thumbnail.isEmpty() ? '' : source.thumbnail.toDataURL(),
      }
    })
  })
  handle('networks', networks)
  handle('select-source', async (id, displayId, mode) => {
    const epoch = ++captureEpoch
    selected = undefined
    if (mode !== 'screen' && mode !== 'extension') throw new Error('无效的共享模式。')
    const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } })
    const source = sources.find((item) => item.id === id && item.display_id === displayId)
    if (!source || epoch !== captureEpoch || !captureIsAvailable({ source, mode })) {
      throw new Error('所选屏幕已变化。请刷新设备后重新选择。')
    }
    selected = { source, mode }
  })
  handle('start-share', async (address, control) => {
    if (starting || share || stopping) throw new Error('已有一个共享会话，或上一会话尚在结束。')
    const capture = capturing
    if (!capture || !captureIsAvailable(capture)) throw new Error('所选屏幕已断开。')
    if (control !== 'view' && (control !== 'touch' || capture.mode !== 'extension' || process.platform !== 'win32')) {
      throw new Error('请选择 Windows 扩展副屏以使用平板触控。')
    }
    if (!networks().some((network) => network.address === address)) {
      throw new Error('所选局域网地址已变化。请刷新设备后重试。')
    }
    const startup = (async () => {
      const server = await startLanServer(address, __dirname)
      let sessionPointer: typeof pointer
      try {
        if (control === 'touch') {
          sessionPointer = await openWindowsPointer(join(__dirname, 'tablet-pointer.exe'), (position) => {
            if (capturing !== capture || !captureIsAvailable(capture)) return
            const display = screen.getAllDisplays().find(({ id }) => String(id) === capture.source.display_id)
            if (!display) return
            return {
              point: screen.dipToScreenPoint(displayPointerPosition(display.bounds, position)),
              bounds: screen.dipToScreenRect(null, display.bounds),
            }
          })
        }
        if (capturing !== capture || !captureIsAvailable(capture)) throw new Error('所选屏幕已断开。')
        const code = qrcode(0, 'M')
        code.addData(server.viewerUrl)
        code.make()
        const qr = code.createDataURL(4, 16)
        pointer = sessionPointer
        share = server
        return { viewerUrl: server.viewerUrl, hostUrl: server.hostUrl, qr }
      } catch (error) {
        await sessionPointer?.close()
        await server.stop()
        throw error
      }
    })()
    starting = startup
    try {
      return await startup
    } finally {
      starting = undefined
    }
  })
  handle('stop-share', stopShare)
  handle('open-display-settings', () => shell.openExternal('ms-settings:display'))
  handle('copy', (text) => {
    if (text === share?.viewerUrl) clipboard.writeText(text)
  })
  app.on('before-quit', (event) => {
    if (!pointer && !stopping && !starting) return
    event.preventDefault()
    void stopShare().then(() => app.quit())
  })
  window.webContents.on('render-process-gone', () => void stopShare())
  window.on('closed', () => {
    ipcMain.off('remote-pointer', onRemotePointer)
    screen.off('display-added', onDisplaysChanged)
    screen.off('display-removed', onDisplayRemoved)
    screen.off('display-metrics-changed', onDisplaysChanged)
    void stopShare()
  })
  await window.loadFile(join(__dirname, 'host.html'))
}

app.whenReady().then(openWindow).catch((error: unknown) => {
  console.error(error)
  app.quit()
})
app.on('window-all-closed', () => app.quit())

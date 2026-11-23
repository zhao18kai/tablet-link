import { app, BrowserWindow, clipboard, desktopCapturer, dialog, ipcMain, Menu, screen, shell } from 'electron'
import { execFile } from 'node:child_process'
import { readFile, stat, writeFile } from 'node:fs/promises'
import { basename, isAbsolute, join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { promisify } from 'node:util'
import qrcode from 'qrcode-generator'
import { manageAutomaticDisplay } from './automatic-display.ts'
import { getDisplayPlacement, getDisplayRole, matchesPhysicalBounds } from './displays.ts'
import { readSignal, startLanServer } from './lan.ts'
import type { createNativePeer } from './native-capture.ts'
import { networks } from './networks.ts'
import { displayPointerPosition, parsePointerCommand } from './pointer.ts'
import { loadRememberedComputer } from './remembered-computer.ts'
import { checkWindowsDisplay, openWindowsDisplay, type WindowsDisplaySession } from './windows-display-session.ts'
import { openWindowsPointer } from './windows-pointer.ts'
import { AUTOMATIC_CAPTURE_EVENT, type CaptureMode, type DisplayOrientation, type ShareInfo } from './wire.ts'

const runDisplayCommand = promisify(execFile)

interface Capture {
  source: Electron.DesktopCapturerSource
  mode: CaptureMode
  viewer?: string
}

interface AutomaticDisplay extends WindowsDisplaySession {
  previouslyActive: Set<number>
  id?: number
}

interface NativeSession {
  viewer: string
  controller: AbortController
  peer?: Awaited<ReturnType<typeof createNativePeer>>
}

function captureIsAvailable(capture: Capture) {
  const id = capture.source.display_id
  const displays = screen.getAllDisplays()
  if (capture.mode === 'screen') return !id || displays.some((display) => String(display.id) === id)
  return getDisplayRole(id, displays, screen.getPrimaryDisplay().id) === 'extension'
}

const loginArgument = 'tablet-link-login'

async function openWindow() {
  Menu.setApplicationMenu(null)
  const window = new BrowserWindow({
    title: '平板智联',
    width: 1080,
    height: 800,
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
  let placing = false
  let captureEpoch = 0
  let rotation = Promise.resolve()
  let orientationRequest = 0
  let automatic: { touch: boolean; direction?: DisplayOrientation; viewer?: string; display?: AutomaticDisplay } | undefined
  let nativeAddress: string | undefined
  let nativeSession: NativeSession | undefined
  const helper = join(__dirname, 'tablet-pointer.exe')
  const ffmpegPreference = join(app.getPath('userData'), 'native-ffmpeg.txt')
  const automaticDisplay = manageAutomaticDisplay<AutomaticDisplay>(async () => {
    const previouslyActive = new Set(screen.getAllDisplays().map(({ id }) => id))
    return { ...await openWindowsDisplay(helper), previouslyActive }
  }, async (display) => {
    await display.close()
    // Windows finishes applying its topology before Electron updates the screen cache.
    for (let attempt = 0; display.id !== undefined && attempt < 12; attempt++) {
      if (!screen.getAllDisplays().some(({ id }) => id === display.id)) break
      await delay(80)
    }
  })

  function openPointer(capture: Capture) {
    return openWindowsPointer(helper, (position) => {
      if (capturing?.source.display_id !== capture.source.display_id || capturing.viewer !== capture.viewer ||
          !captureIsAvailable(capturing)) return
      const display = screen.getAllDisplays().find(({ id }) => String(id) === capture.source.display_id)
      if (!display) return
      return {
        point: screen.dipToScreenPoint(displayPointerPosition(display.bounds, position)),
        bounds: screen.dipToScreenRect(null, display.bounds),
      }
    })
  }

  function orientSharedVdd(capture: Capture, direction: DisplayOrientation) {
    const request = ++orientationRequest
    rotation = rotation.then(async () => {
      if (request !== orientationRequest || !share || capturing !== capture || !captureIsAvailable(capture)) return
      const display = screen.getAllDisplays().find(({ id }) => String(id) === capture.source.display_id)
      if (display?.label !== 'VDD by MTT' || (display.bounds.height > display.bounds.width) === (direction === 'portrait')) return
      const { x, y, width, height } = screen.dipToScreenRect(null, display.bounds)
      pointer?.send({ action: 'cancel' })
      await runDisplayCommand(helper, [
        '--orient-display', direction, String(x), String(y), String(x + width), String(y + height),
      ], { windowsHide: true, timeout: 5000 })
    }).catch(() => { console.warn('无法切换 VDD 虚拟副屏方向。') })
  }

  async function configuredFfmpeg() {
    const path = process.env.TABLET_LINK_FFMPEG || (await readFile(ffmpegPreference, 'utf8').catch(() => '')).trim()
    if (isAbsolute(path) && basename(path).toLowerCase() === 'ffmpeg.exe' &&
        await stat(path).then((info) => info.isFile(), () => false)) return path
  }

  function stopNative(viewer?: string) {
    const current = nativeSession
    if (!current || (viewer && current.viewer !== viewer)) return
    nativeSession = undefined
    current.controller.abort()
    pointer?.send({ action: 'cancel' })
    return current.peer?.close()
  }

  function releaseAutomaticDisplay(viewer: string) {
    const nativeStopped = stopNative(viewer)
    let pointerClosed: Promise<void> | undefined
    if (automatic?.viewer === viewer) {
      automatic.viewer = undefined
      automatic.direction = undefined
      automatic.display = undefined
      const previous = pointer
      pointer = undefined
      pointerClosed = previous?.close()
    }
    if (selected?.viewer === viewer) {
      selected = undefined
      captureEpoch++
    }
    if (capturing?.viewer === viewer) {
      capturing = undefined
      orientationRequest++
    }
    const controlsStopped = Promise.all([rotation, pointerClosed, nativeStopped]).then(() => undefined)
    void automaticDisplay.release(viewer, controlsStopped).catch(() => {
      if (!window.isDestroyed()) window.webContents.send('display-cleanup-failed')
    })
  }

  async function stopShare() {
    if (stopping) return stopping
    captureEpoch++
    orientationRequest++
    selected = capturing = undefined
    const nativeStopped = stopNative()
    nativeAddress = undefined
    const oldPointer = pointer
    pointer = undefined
    const previous = share
    share = undefined
    automatic = undefined
    const controlsStopped = Promise.all([rotation, nativeStopped]).then(() => undefined)
    stopping = Promise.all([
      oldPointer?.close(), nativeStopped, previous?.stop(), starting?.catch(() => undefined), automaticDisplay.release(undefined, controlsStopped),
    ])
      .then(() => undefined).finally(() => { stopping = undefined })
    await stopping
  }

  function onTopologyChange(removedId?: number) {
    if (window.isDestroyed()) return
    if (removedId !== undefined && automatic?.display?.id === removedId) automatic.display.markAlreadyDetached()
    captureEpoch++
    selected = undefined
    const unavailable = (capture: Capture) => String(removedId) === capture.source.display_id || !captureIsAvailable(capture)
    if (capturing && (!share || unavailable(capturing))) {
      window.webContents.send('capture-lost')
      if (capturing.viewer) releaseAutomaticDisplay(capturing.viewer)
      else void stopShare()
    } else if (nativeSession) {
      const { viewer } = nativeSession
      void stopNative(viewer)?.catch(console.error)
      window.webContents.send('native-stream-state', viewer, 'failed')
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
        !request.videoRequested || request.audioRequested || (capture.viewer && !share?.isViewerApproved(capture.viewer))) {
      callback({})
      return
    }
    const epoch = captureEpoch
    void desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } }).then((sources) => {
      const source = sources.find((item) => item.id === capture.source.id && item.display_id === capture.source.display_id)
      if (!source || epoch !== captureEpoch || !captureIsAvailable(capture) ||
          (capture.viewer && !share?.isViewerApproved(capture.viewer))) callback({})
      else {
        capturing = { ...capture, source, viewer: automatic ? capture.viewer : undefined }
        callback({ video: source })
        if (capture.viewer && automatic?.direction) orientSharedVdd(capturing, automatic.direction)
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
        canRotate: process.platform === 'win32' && role === 'extension' && display?.label === 'VDD by MTT',
      }
    })
  })
  handle('automatic-display-available', () => process.platform === 'win32' && checkWindowsDisplay(helper).then(() => true, () => false))
  handle('networks', networks)
  handle('select-source', async (id, displayId, mode) => {
    if (placing) throw new Error('正在调整副屏位置。')
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
  handle('start-share', async (address, control, orientationMode, connectionMode, captureKind) => {
    if (starting || share || stopping || placing) throw new Error('请等当前操作结束后再开始共享。')
    const useAutomatic = captureKind === 'automatic' && process.platform === 'win32'
    const useNative = captureKind === 'native' && process.platform === 'win32' &&
      orientationMode === 'fixed' && connectionMode === 'lan' && selected?.mode === 'extension'
    const capture = useNative ? selected : capturing
    if (!useAutomatic && (!capture || !captureIsAvailable(capture))) throw new Error('所选屏幕已断开。')
    if (control !== 'view' && (control !== 'touch' || process.platform !== 'win32' || (!useAutomatic && capture?.mode !== 'extension'))) {
      throw new Error('请选择 Windows 扩展副屏以使用平板触控。')
    }
    if (connectionMode !== 'lan' && connectionMode !== 'usb') throw new Error('无效的连接方式。')
    const followOrientation = orientationMode === 'follow' && process.platform === 'win32' && (useAutomatic ||
      (capture?.mode === 'extension' &&
        screen.getAllDisplays().some(({ id, label }) => String(id) === capture.source.display_id && label === 'VDD by MTT')))
    if (useNative) {
      selected = undefined
      capturing = capture
    }
    const stillAvailable = () => useAutomatic || !!capture && capturing === capture && captureIsAvailable(capture)
    const startup = (async () => {
      const addresses = await networks()
      if (!addresses.some((network) => network.address === address && network.mode === connectionMode)) {
        throw new Error('所选网络地址已变化。请刷新设备后重试。')
      }
      if (!stillAvailable()) throw new Error('所选屏幕已断开。')
      if (useAutomatic) await checkWindowsDisplay(helper)
      const computer = connectionMode === 'lan' ? await loadRememberedComputer(app.getPath('userData')).catch((error) => {
        console.warn('无法读取快捷连接设置。', error)
        return undefined
      }) : undefined
      if (stopping || !stillAvailable()) throw new Error('共享已结束或所选屏幕已断开。')
      const server = await startLanServer(
        address, __dirname, followOrientation ? (direction) => {
          if (automatic) automatic.direction = direction
          if (capturing) orientSharedVdd(capturing, direction)
        } : undefined, connectionMode, useAutomatic ? releaseAutomaticDisplay : (viewer) => {
          if (selected?.viewer === viewer) {
            selected = undefined
            captureEpoch++
          }
          void stopNative(viewer)?.catch(console.error)
        }, computer,
      )
      let sessionPointer: typeof pointer
      try {
        if (!useAutomatic && capture && control === 'touch') sessionPointer = await openPointer(capture)
        if (stopping || !stillAvailable()) throw new Error('共享已结束或所选屏幕已断开。')
        const code = qrcode(0, 'M')
        code.addData(server.viewerUrl)
        code.make()
        const qr = code.createDataURL(4, 16)
        pointer = sessionPointer
        automatic = useAutomatic ? { touch: control === 'touch' } : undefined
        share = server
        nativeAddress = process.platform === 'win32' && connectionMode === 'lan' && !followOrientation ? address : undefined
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
  handle('capture-automatic-display', async (viewer, kind) => {
    const server = share
    const settings = automatic
    if (!server || !settings) throw new Error('自动副屏未启用。')
    const isApproved = () => share === server && automatic === settings && server.isViewerApproved(viewer)
    if (!isApproved() || settings.viewer === viewer) throw new Error('平板连接已结束或正在创建副屏。')
    settings.viewer = viewer
    try {
      const display = await automaticDisplay.acquire(viewer, isApproved)
      if (!display) throw new Error('平板连接已结束。')
      settings.display = display
      for (let attempt = 0; attempt < 25 && isApproved(); attempt++) {
        const candidates = screen.getAllDisplays().filter((item) =>
          item.label === 'VDD by MTT' && !display.previouslyActive.has(item.id) &&
          matchesPhysicalBounds(display.bounds, screen.dipToScreenRect(null, item.bounds), item.scaleFactor))
        if (candidates.length === 1) {
          const [target] = candidates
          display.id = target.id
          const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } })
          const source = sources.find((item) => item.display_id === String(target.id))
          const capture = source && { source, mode: 'extension' as const, viewer }
          if (capture && captureIsAvailable(capture) && isApproved()) {
            const sessionPointer = settings.touch ? await openPointer(capture) : undefined
            if (!isApproved() || window.isDestroyed()) {
              await sessionPointer?.close()
              break
            }
            pointer = sessionPointer
            if (kind === 'prepare' && nativeAddress) {
              capturing = capture
              return
            }
            selected = capture
            // Only an authorized capture gets Chromium's required user activation.
            await window.webContents.executeJavaScript(`window.dispatchEvent(new Event(${JSON.stringify(AUTOMATIC_CAPTURE_EVENT)}))`, true)
            return
          }
        }
        await delay(120)
      }
      throw new Error(isApproved() ? 'Windows 已创建副屏，但采集尚未就绪。' : '平板连接已结束。')
    } catch (error) {
      releaseAutomaticDisplay(viewer)
      throw error
    }
  })
  handle('capture-current-display', async (viewer) => {
    const server = share
    const capture = capturing
    if (!server?.isViewerApproved(viewer) || !capture || (capture.viewer && capture.viewer !== viewer) || !captureIsAvailable(capture)) {
      throw new Error('所选副屏已断开。')
    }
    const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } })
    if (server !== share || capture !== capturing || !server.isViewerApproved(viewer) || !captureIsAvailable(capture)) {
      throw new Error('所选副屏已断开。')
    }
    const currentSource = sources.find((item) => item.display_id === capture.source.display_id)
    if (!currentSource) throw new Error('所选副屏已断开。')
    selected = { ...capture, source: currentSource, viewer }
    await window.webContents.executeJavaScript(`window.dispatchEvent(new Event(${JSON.stringify(AUTOMATIC_CAPTURE_EVENT)}))`, true)
  })
  handle('native-ffmpeg-configured', async () => process.platform === 'win32' ? !!await configuredFfmpeg() : null)
  handle('choose-native-ffmpeg', async () => {
    if (process.platform !== 'win32' || share || starting || stopping) return !!await configuredFfmpeg()
    const choice = await dialog.showOpenDialog(window, {
      title: '选择支持 DXGI 与 NVENC 的 ffmpeg.exe', properties: ['openFile'],
      filters: [{ name: 'FFmpeg', extensions: ['exe'] }],
    })
    if (choice.canceled) return !!await configuredFfmpeg()
    const [path] = choice.filePaths
    if (!path || basename(path).toLowerCase() !== 'ffmpeg.exe') throw new Error('请选择 ffmpeg.exe。')
    await writeFile(ffmpegPreference, path, 'utf8')
    return true
  })
  handle('create-native-offer', async (viewer, sizeCap, fpsCap) => {
    const server = share
    const capture = capturing
    const address = nativeAddress
    if (!server?.isViewerApproved(viewer) || !capture || capture.mode !== 'extension' ||
        (capture.viewer && capture.viewer !== viewer) || !address || !captureIsAvailable(capture) || nativeSession) {
      throw new Error('当前共享无法启用原生采集。')
    }
    const display = screen.getAllDisplays().find(({ id }) => String(id) === capture.source.display_id)
    if (!display) throw new Error('所选副屏已断开。')
    const { x, y, width, height } = screen.dipToScreenRect(null, display.bounds)
    const current: NativeSession = { viewer, controller: new AbortController() }
    nativeSession = current
    const { signal } = current.controller
    const active = () => nativeSession === current && share === server && server.isViewerApproved(viewer) && capturing === capture
    try {
      const executable = await configuredFfmpeg()
      if (!executable) throw new Error('请先在画质设置中选择 ffmpeg.exe。')
      const { nativeCaptureTarget, selectNativeFormat, probeNativeEncoder, createNativePeer } = await import('./native-capture.ts')
      const { stdout } = await runDisplayCommand(helper, [
        '--dxgi-output', String(x), String(y), String(x + width), String(y + height),
      ], { windowsHide: true, timeout: 2000, signal })
      const target = nativeCaptureTarget(stdout)
      if (!target || !active()) throw new Error('未找到可用的 DXGI 副屏。')
      const format = selectNativeFormat(target, display.displayFrequency, Number(sizeCap), Number(fpsCap))
      await probeNativeEncoder(executable, target, format, signal)
      if (!active()) throw new Error('平板连接已结束。')
      current.peer = await createNativePeer({
        executable, target, format, address, signal,
        onState(state) {
          if (!active() || window.isDestroyed()) return
          if (state !== 'streaming') pointer?.send({ action: 'cancel' })
          window.webContents.send('native-stream-state', viewer, state)
        },
        onPointer: pointer ? (data) => {
          if (!active()) return
          const command = parsePointerCommand(data)
          if (command) pointer?.send(command)
        } : undefined,
      })
      if (!active()) throw new Error('平板连接已结束。')
      const { width: videoWidth, height: videoHeight, fps } = format
      return { description: current.peer.description, mode: { width: videoWidth, height: videoHeight, fps } }
    } catch (error) {
      if (nativeSession === current) await stopNative(viewer)
      else await current.peer?.close()
      throw error
    }
  })
  handle('accept-native-signal', (raw) => {
    const message = typeof raw === 'string' && raw.length <= 64 * 1024 ? readSignal(raw) : undefined
    if (message && nativeSession?.viewer === message.id && share?.isViewerApproved(message.id)) {
      return nativeSession.peer?.accept(message)
    }
  })
  handle('native-encoded-frames', (viewer) => nativeSession?.viewer === viewer ? nativeSession.peer?.encodedFrames : undefined)
  handle('reconnect-native-viewer', async (viewer) => {
    const server = share
    if (!server?.isViewerApproved(viewer)) return
    await stopNative(viewer)
    if (share === server) server.reconnectViewer(viewer)
  })
  handle('stop-share', stopShare)
  handle('open-display-settings', () => shell.openExternal('ms-settings:display'))
  handle('open-vdd-driver', () => shell.openExternal('https://github.com/VirtualDrivers/Virtual-Display-Driver/releases/tag/25.7.23'))
  handle('app-version', () => app.getVersion())
  let loginSharePending = process.platform === 'win32' && process.argv.slice(1).includes(loginArgument)
  handle('started-at-login', () => loginSharePending)
  handle('start-login-share', async () => {
    if (!loginSharePending) return
    loginSharePending = false
    await window.webContents.executeJavaScript('document.getElementById("start").click()', true)
  })
  handle('launch-at-login', (requested?: string) => {
    if (process.platform !== 'win32') return null
    const name = app.getName()
    const previousArgs = app.isPackaged ? [] : [app.getAppPath()]
    const launch = { path: process.execPath, args: [...previousArgs, loginArgument] }
    if (requested !== undefined) {
      if (requested !== 'on' && requested !== 'off') throw new Error('无效的开机自启设置。')
      app.setLoginItemSettings({ ...launch, name, openAtLogin: requested === 'on' })
    }
    const matches = (args: string[], expected: string[]) =>
      args.length === expected.length && args.every((argument, index) => argument === expected[index])
    return app.getLoginItemSettings(launch).launchItems.some((item) => item.name === name &&
      item.scope === 'user' && item.enabled && (matches(item.args, launch.args) || matches(item.args, previousArgs)))
  })
  handle('open-project', () => shell.openExternal('https://github.com/zhao18kai/tablet-link'))
  handle('place-display', async (displayId, referenceId, side) => {
    if (process.platform !== 'win32') throw new Error('副屏位置设置仅支持 Windows。')
    if (placing || selected || capturing || share || starting || stopping) throw new Error('停止共享后可以调整副屏位置。')
    if (side !== 'left' && side !== 'right' && side !== 'above' && side !== 'below') throw new Error('请选择位置方向。')
    const displays = screen.getAllDisplays()
    const primaryId = screen.getPrimaryDisplay().id
    const target = displays.find(({ id }) => String(id) === displayId)
    const reference = displays.find(({ id }) => String(id) === referenceId)
    if (target?.label !== 'VDD by MTT' || getDisplayRole(displayId, displays, primaryId) !== 'extension' ||
        !reference || reference.id === target.id || reference.label === 'VDD by MTT' ||
        getDisplayRole(referenceId, displays, primaryId) === 'mirror') {
      throw new Error('显示器已变化。请刷新设备后重新选择。')
    }
    const physical = ({ id, bounds }: Electron.Display) => ({ id, bounds: screen.dipToScreenRect(null, bounds) })
    const { x, y, width, height } = physical(target).bounds
    const position = getDisplayPlacement(displays.map(physical), physical(target), physical(reference), side)
    if (!position) throw new Error('该位置已有其他屏幕。请选择其他参考屏或方向。')
    if (position.x === x && position.y === y) return
    placing = true
    try {
      await runDisplayCommand(helper, [
        '--place-display', ...[x, y, x + width, y + height, position.x, position.y].map(String),
      ], { windowsHide: true, timeout: 5000 })
    } catch {
      throw new Error('Windows 未能应用副屏位置，请刷新设备后重试。')
    } finally {
      placing = false
    }
  })
  handle('copy', (text) => {
    if (text === share?.viewerUrl) clipboard.writeText(text)
  })
  app.on('before-quit', (event) => {
    if (!share && !pointer && !stopping && !starting) return
    event.preventDefault()
    void stopShare().catch(console.error).then(() => app.quit())
  })
  window.webContents.on('render-process-gone', () => void stopShare().catch(console.error))
  window.on('closed', () => {
    ipcMain.off('remote-pointer', onRemotePointer)
    screen.off('display-added', onDisplaysChanged)
    screen.off('display-removed', onDisplayRemoved)
    screen.off('display-metrics-changed', onDisplaysChanged)
    void stopShare().catch(console.error)
  })
  await window.loadFile(join(__dirname, 'host.html'))
}

// Only the bundled host page uses this renderer. USB offers need a literal IP to select their NIC.
const disabledFeatures = app.commandLine.getSwitchValue('disable-features')
app.commandLine.appendSwitch('disable-features', [disabledFeatures, 'WebRtcHideLocalIpsWithMdns'].filter(Boolean).join(','))

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    const window = BrowserWindow.getAllWindows()[0]
    if (!window) return
    if (window.isMinimized()) window.restore()
    window.focus()
  })
  app.whenReady().then(openWindow).catch((error: unknown) => {
    console.error(error)
    app.quit()
  })
  app.on('window-all-closed', () => app.quit())
}

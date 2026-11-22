import { app, BrowserWindow, clipboard, desktopCapturer, ipcMain, Menu, screen } from 'electron'
import { networkInterfaces } from 'node:os'
import { join } from 'node:path'
import qrcode from 'qrcode-generator'
import { startLanServer } from './lan.ts'

function networks() {
  return Object.entries(networkInterfaces()).flatMap(([name, entries]) =>
    (entries ?? [])
      .filter(({ address, family, internal }) => family === 'IPv4' && !internal &&
        /^(192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/.test(address))
      .map(({ address }) => ({ name, address })),
  ).sort((left, right) => Number(/wi-?fi|wlan/i.test(right.name)) - Number(/wi-?fi|wlan/i.test(left.name)))
}

let share: Awaited<ReturnType<typeof startLanServer>> | undefined
let starting = false

async function stopShare() {
  const previous = share
  share = undefined
  await previous?.stop()
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

  let selectedSource: Electron.DesktopCapturerSource | undefined
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-navigate', (event) => event.preventDefault())
  window.webContents.session.setDisplayMediaRequestHandler((request, callback) => {
    const source = selectedSource
    selectedSource = undefined
    if (source && request.frame === window.webContents.mainFrame && request.userGesture &&
        request.videoRequested && !request.audioRequested) {
      callback({ video: source })
    } else callback({})
  })

  function handle(name: string, action: (...args: string[]) => unknown) {
    ipcMain.handle(name, (event, ...args: string[]) => {
      if (event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) {
        throw new Error('无效的桌面窗口。')
      }
      return action(...args)
    })
  }

  handle('sources', async () => {
    const displays = screen.getAllDisplays()
    const primaryId = String(screen.getPrimaryDisplay().id)
    const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 320, height: 180 } })
    return sources.map((source, index) => {
      const display = displays.find(({ id }) => String(id) === source.display_id)
      const name = display?.label || `屏幕 ${index + 1}`
      return {
        id: source.id,
        name: source.display_id === primaryId ? `${name}（主屏）` : name,
        thumbnail: source.thumbnail.isEmpty() ? '' : source.thumbnail.toDataURL(),
      }
    })
  })
  handle('networks', networks)
  handle('select-source', async (id) => {
    const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } })
    selectedSource = sources.find((source) => source.id === id)
    if (!selectedSource) throw new Error('所选屏幕已断开。请刷新设备后重试。')
  })
  handle('start-share', async (address) => {
    if (starting || share) throw new Error('已有一个共享会话。')
    if (!networks().some((network) => network.address === address)) {
      throw new Error('所选局域网地址已变化。请刷新设备后重试。')
    }
    starting = true
    try {
      const server = await startLanServer(address, __dirname)
      share = server
      const code = qrcode(0, 'M')
      code.addData(server.viewerUrl)
      code.make()
      return { viewerUrl: server.viewerUrl, hostUrl: server.hostUrl, qr: code.createDataURL(4, 16) }
    } catch (error) {
      await stopShare()
      throw error
    } finally {
      starting = false
    }
  })
  handle('stop-share', stopShare)
  handle('copy', (text) => {
    if (text === share?.viewerUrl) clipboard.writeText(text)
  })
  window.on('closed', () => void stopShare())
  await window.loadFile(join(__dirname, 'host.html'))
}

app.whenReady().then(openWindow).catch((error: unknown) => {
  console.error(error)
  app.quit()
})
app.on('window-all-closed', () => app.quit())

import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { networkInterfaces } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { _electron, chromium } from 'playwright-core'

test('Windows screen reaches a separate Chromium browser over a LAN address', { timeout: 60000 }, (t) => streamScreen(t))
test('an extended Windows display sends its own desktop to the receiver', { timeout: 60000 }, (t) => streamScreen(t, true))

async function streamScreen(t, extension = false) {
  const edge = [process.env['ProgramFiles(x86)'], process.env.ProgramFiles]
    .filter(Boolean)
    .map((directory) => join(directory, 'Microsoft', 'Edge', 'Application', 'msedge.exe'))
    .find(existsSync)
  assert.ok(edge, 'The Windows end-to-end test needs Microsoft Edge')
  const address = Object.values(networkInterfaces()).flat().find((entry) => (
    entry?.family === 'IPv4' && /^(192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/.test(entry.address)
  ))?.address
  assert.ok(address, 'The test needs a private IPv4 address')
  const app = await _electron.launch({
    args: process.env.TABLET_LINK_EXE ? [] : ['.'],
    executablePath: process.env.TABLET_LINK_EXE,
    timeout: 20000,
  })
  t.after(() => app.close())
  const host = await app.firstWindow()
  await host.evaluate(() => {
    const Original = window.RTCPeerConnection
    window.RTCPeerConnection = class extends Original {
      constructor(...args) {
        super(...args)
        window.testPeer = this
      }
    }
    const hint = Object.getOwnPropertyDescriptor(MediaStreamTrack.prototype, 'contentHint')
    window.testContentHints = []
    Object.defineProperty(MediaStreamTrack.prototype, 'contentHint', {
      ...hint,
      set(value) {
        hint.set.call(this, value)
        window.testContentHints.push(this.contentHint)
      },
    })
    const getStats = RTCRtpSender.prototype.getStats
    let previousTime, captured = 0, sent = 0
    RTCRtpSender.prototype.getStats = async function () {
      if (!window.testSlowDelivery) return getStats.call(this)
      // Control only the sampled counters so the actual input and media paths still run.
      const timestamp = performance.now()
      const elapsed = (timestamp - (previousTime ?? timestamp)) / 1000
      previousTime = timestamp
      captured += elapsed * 48
      sent += elapsed * (this.track.contentHint === 'motion' ? 46 : 18)
      return new Map([
        ['screen', { type: 'media-source', frames: captured }],
        ['out', { type: 'outbound-rtp', kind: 'video', mediaSourceId: 'screen', timestamp, framesSent: sent }],
      ])
    }
  })
  host.on('console', (message) => {
    if (message.type() === 'error') t.diagnostic(message.text().replace(/(token|resume)=[\w-]+/g, '$1=[redacted]'))
  })
  const browser = await chromium.launch({ executablePath: edge })
  t.after(() => browser.close())
  const viewer = await browser.newPage({ viewport: { width: 1200, height: 800 }, hasTouch: true })
  await viewer.addInitScript(() => {
    const Original = window.WebSocket
    window.WebSocket = class extends Original {
      constructor(url, protocols) {
        super(url, protocols)
        window.testSignalingSocket = this
      }
    }
  })
  let markerPage

  await host.locator('#network').selectOption(address)
  if (extension) {
    const screens = await host.evaluate(() => window.tabletLink.sources())
    const extendedDisplays = screens.filter(({ role }) => role === 'extension')
    const requiredId = process.env.TABLET_LINK_TEST_DISPLAY_ID
    const target = extendedDisplays.find(({ displayId }) => !requiredId || displayId === requiredId)
    if (!target && !requiredId) {
      t.skip('Windows has no extended display')
      return
    }
    assert.ok(target, 'The requested extended display must be active and capturable')
    await host.getByRole('radio', { name: '扩展副屏' }).check()
    const listed = await host.locator('#source option').evaluateAll((options) => options.map(({ value }) => value))
    assert.deepEqual(listed, extendedDisplays.map(({ id }) => id))
    await host.locator('#source').selectOption(target.id)
    await host.getByRole('checkbox', { name: '允许平板触控' }).check()

    // Draw a test color on the selected display so a duplicate of the primary cannot pass.
    await app.evaluate(async ({ BrowserWindow, screen }, displayId) => {
      const display = screen.getAllDisplays().find(({ id }) => String(id) === displayId)
      if (!display) throw new Error('The selected display disappeared during the test')
      const marker = new BrowserWindow({
        ...display.bounds, show: false, frame: false, alwaysOnTop: true, skipTaskbar: true,
      })
      const targetPage = `<style>
          @keyframes sweep { from { transform: translateX(0) } to { transform: translateX(78vw) } }
          .moving { position: absolute; top: 27px; width: 90px; height: 65px; background: white; animation: sweep 1.8s linear infinite alternate; }
        </style><body style="background:#2f93cb; min-height:180vh" data-clicks="0" data-drags="0" data-ups="0"><div class="moving"></div>
        <script>
          const count = (key) => { document.body.dataset[key] = Number(document.body.dataset[key]) + 1 }
          document.addEventListener('click', () => count('clicks'))
          document.addEventListener('mousemove', event => { if (event.buttons === 1) count('drags') })
          document.addEventListener('mouseup', () => count('ups'))
        </script>`
      await marker.loadURL('data:text/html,' + encodeURIComponent(targetPage))
      marker.showInactive()
    }, target.displayId)
    markerPage = app.windows().find((page) => page.url().startsWith('data:text/html,'))
    assert.ok(markerPage, 'The Windows touch test window must be available')
    t.diagnostic(`Extended source: ${target.name} (display ID ${target.displayId})`)
  }
  await host.getByRole('button', { name: '开始共享' }).click()
  await host.waitForFunction(() => {
    return !document.querySelector('#share-details').hidden || document.querySelector('#status').dataset.state === 'error'
  }, undefined, { timeout: 12000 })
  assert.notEqual(await host.locator('#status').getAttribute('data-state'), 'error', await host.locator('#status').innerText())
  const url = await host.locator('#share-url').inputValue()
  assert.equal(new URL(url).hostname, address)
  await viewer.goto(url)
  await viewer.getByRole('button', { name: '请求观看' }).click()
  const approve = host.getByRole('button', { name: '允许连接' })
  await approve.waitFor({ state: 'visible' })
  assert.equal(await viewer.locator('video').evaluate((video) => video.srcObject), null)
  await approve.click()

  await viewer.waitForFunction(() => {
    const video = document.querySelector('video')
    return video.videoWidth > 0 && video.currentTime > 0.25
  }, undefined, { timeout: 20000 })
  const dimensions = await viewer.locator('video').evaluate((video) => [video.videoWidth, video.videoHeight])
  t.diagnostic(`Decoded ${dimensions.join(' × ')} video from Windows screen capture`)

  if (extension) {
    await viewer.waitForFunction(() => {
      const video = document.querySelector('video')
      const canvas = document.createElement('canvas')
      canvas.width = canvas.height = 1
      const context = canvas.getContext('2d')
      context.drawImage(video, Math.floor(video.videoWidth / 2), Math.floor(video.videoHeight / 2), 1, 1, 0, 0, 1, 1)
      const pixel = context.getImageData(0, 0, 1, 1).data
      return [47, 147, 203].every((expected, channel) => Math.abs(pixel[channel] - expected) < 30)
    }, undefined, { timeout: 8000 })
    await viewer.locator('.screen.touch-enabled').waitFor({ state: 'visible', timeout: 10000 })
    const measuredFrames = await viewer.locator('video').evaluate(async (video) => {
      const initial = video.getVideoPlaybackQuality().totalVideoFrames
      const start = performance.now()
      await new Promise((resolve) => setTimeout(resolve, 1500))
      return Math.round(1000 * (video.getVideoPlaybackQuality().totalVideoFrames - initial) / (performance.now() - start))
    })
    t.diagnostic(`Received about ${measuredFrames} FPS with continuous screen motion`)
    const center = await videoCenter(viewer)
    await viewer.touchscreen.tap(center.x, center.y)
    await markerPage.waitForFunction(() => document.body.dataset.clicks === '1', undefined, { timeout: 6000 })
    assert.deepEqual(await host.evaluate(() => window.testContentHints), ['detail'])

    const touchscreen = await viewer.context().newCDPSession(viewer)
    try {
      await host.evaluate(() => { window.testSlowDelivery = true })
      await touchscreen.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ ...center, id: 1 }] })
      for (let step = 1; step <= 7; step++) {
        await touchscreen.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: center.x + step * 12, y: center.y + 12, id: 1 }] })
        await new Promise((resolve) => setTimeout(resolve, 55))
      }
      await host.waitForFunction(() => window.testContentHints.includes('motion'), undefined, { timeout: 4000 })
      await markerPage.waitForFunction(() => Number(document.body.dataset.drags) > 0, undefined, { timeout: 6000 })
      await touchscreen.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
      await markerPage.waitForFunction(() => Number(document.body.dataset.ups) >= 2, undefined, { timeout: 6000 })
      await host.waitForFunction(() => window.testContentHints.join(',') === 'detail,motion,detail', undefined, { timeout: 4000 })
      const preference = await host.evaluate(() => window.testPeer.getSenders()[0].getParameters().degradationPreference)
      assert.equal(preference, 'maintain-resolution')
    } finally {
      await host.evaluate(() => { window.testSlowDelivery = false })
      await touchscreen.detach()
    }
    t.diagnostic('Tablet-style tap and drag reached the Windows extension; the mouse button was released')
  } else {
    await viewer.locator('.screen.touch-enabled').waitFor({ state: 'hidden', timeout: 2000 })
  }

  await viewer.getByRole('button', { name: '全屏', exact: true }).click()
  await viewer.waitForFunction(() => document.fullscreenElement?.id === 'stage')
  await viewer.locator('.viewer-bar').waitFor({ state: 'hidden', timeout: 3000 })
  const fit = viewer.getByRole('button', { name: '铺满画面（裁边）' })
  const surface = viewer.getByRole('button', { name: '显示全屏控件' })
  if (extension) await twoFingerTap(viewer)
  else await surface.tap()
  assert.equal(await fit.getAttribute('aria-pressed'), 'false')
  assert.equal(await viewer.locator('video').evaluate((video) => getComputedStyle(video).objectFit), 'contain')
  await fit.tap()
  assert.equal(await fit.getAttribute('aria-pressed'), 'true')
  assert.equal(await viewer.locator('video').evaluate((video) => getComputedStyle(video).objectFit), 'cover')
  await fit.tap()
  assert.equal(await viewer.locator('video').evaluate((video) => getComputedStyle(video).objectFit), 'contain')
  if (extension) await twoFingerTap(viewer)
  else await viewer.getByRole('button', { name: '隐藏全屏控件' }).tap()
  await viewer.locator('.viewer-bar').waitFor({ state: 'hidden' })

  if (extension) {
    const clicksBeforeScroll = await markerPage.locator('body').getAttribute('data-clicks')
    const { x, y } = await videoCenter(viewer)
    const touch = await viewer.context().newCDPSession(viewer)
    const fingers = (dy) => [{ x, y: y + dy, id: 1 }, { x: x + 40, y: y + dy, id: 2 }]
    try {
      await touch.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: fingers(0) })
      await touch.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: fingers(-100) })
      await markerPage.waitForFunction(() => window.scrollY > 0, undefined, { timeout: 6000 })
      await touch.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
    } finally {
      await touch.detach()
    }
    assert.equal(await markerPage.locator('body').getAttribute('data-clicks'), clicksBeforeScroll)
    assert.equal(await viewer.locator('.viewer-bar').isVisible(), false)
    t.diagnostic('Two-finger scrolling moved the Windows window without clicking or revealing fullscreen controls')
  }

  await viewer.evaluate(() => {
    window.testPreviousStream = document.querySelector('video').srcObject
    window.testSignalingSocket.close(4300, 'test connection loss')
  })
  await viewer.waitForFunction(() => {
    const video = document.querySelector('video')
    return video.srcObject && video.srcObject !== window.testPreviousStream &&
      document.querySelector('#viewer-prompt').hidden
  }, undefined, { timeout: 12000 })
  assert.equal(await viewer.evaluate(() => document.fullscreenElement?.id), 'stage')
  assert.equal(await approve.isVisible(), false)
  if (extension) {
    await viewer.locator('.screen.touch-enabled').waitFor({ state: 'visible' })
    await host.waitForFunction(() => window.testPeer.getSenders()[0].getParameters().degradationPreference === 'maintain-resolution')
  }
  t.diagnostic('The same approved viewer reconnected automatically and stayed fullscreen')

  await viewer.evaluate(() => {
    const socket = window.testSignalingSocket
    const close = socket.close.bind(socket)
    socket.close = (code, reason) => {
      if (code === 4001) window.setTimeout(() => close(code, reason), 420)
      else close(code, reason)
    }
    document.querySelector('#leave').click()
    document.querySelector('#connect').click()
  })
  await approve.waitFor({ state: 'visible', timeout: 6000 })
  await approve.click()
  await viewer.waitForFunction(() => document.querySelector('#viewer-prompt').hidden, undefined, { timeout: 12000 })
  t.diagnostic('A manual reconnect waits for the previous socket to close and requests approval again')

  await host.getByRole('button', { name: '停止共享' }).click()
  await viewer.waitForFunction(() => document.querySelector('video').srcObject === null)
  await viewer.waitForFunction(() => document.fullscreenElement === null)
  await assert.rejects(fetch(url))
}

async function videoCenter(viewer) {
  const box = await viewer.locator('video').boundingBox()
  assert.ok(box)
  return { x: Math.round(box.x + box.width / 2), y: Math.round(box.y + box.height / 2) }
}

async function twoFingerTap(viewer) {
  const { x, y } = await videoCenter(viewer)
  const cdp = await viewer.context().newCDPSession(viewer)
  try {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y, id: 1 }, { x: x + 32, y, id: 2 }] })
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
  } finally {
    await cdp.detach()
  }
}

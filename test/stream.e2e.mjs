import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { networkInterfaces, tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { _electron, chromium } from 'playwright-core'
import { build } from 'esbuild'

test('Windows screen reaches a separate Chromium browser over a LAN address', { timeout: 60000 }, (t) => streamScreen(t))
test('an extended Windows display sends its own desktop to the receiver', { timeout: 60000 }, (t) => streamScreen(t, true))

test('the startup checkbox updates the Windows login entry', { timeout: 30000 }, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'Tablet Link startup test '))
  const name = basename(directory)
  let app
  t.after(async () => {
    try {
      await app?.evaluate(({ app }, name) => app.setLoginItemSettings({ name, openAtLogin: false }), name)
    } finally {
      await app?.close()
      await rm(directory, { recursive: true, force: true })
    }
  })
  const dist = process.env.TABLET_LINK_EXE
    ? join(dirname(process.env.TABLET_LINK_EXE), 'resources', 'app', 'dist')
    : fileURLToPath(new URL('../dist', import.meta.url))
  await cp(dist, join(directory, 'dist'), { recursive: true })
  await writeFile(join(directory, 'package.json'), JSON.stringify({ name, main: 'dist/main.cjs' }))
  const launch = (...flags) => _electron.launch({ args: [directory, `--user-data-dir=${join(directory, 'profile')}`, ...flags] })
  app = await launch()
  let host = await app.firstWindow()
  const startup = () => host.getByRole('checkbox', { name: '开机自启' })
  await startup().waitFor({ timeout: 4000 })
  const entry = () => app.evaluate(({ app }, name) => app.getLoginItemSettings().launchItems.find((item) => item.name === name), name)
  assert.equal(await startup().isChecked(), false)
  assert.equal(await entry(), undefined)

  await startup().check()
  await host.locator('#launch-at-login:enabled').waitFor()
  const installed = await entry()
  assert.ok(installed?.enabled)
  assert.equal(installed.scope, 'user')
  assert.deepEqual(installed.args, [directory, 'tablet-link-login'], 'Windows launches this app even with spaces in its path')

  await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0].reload() })
  await host.locator('#launch-at-login:enabled').waitFor()
  assert.equal(await startup().isChecked(), true)
  await host.getByRole('checkbox', { name: '开机后自动共享' }).check()
  await host.getByRole('button', { name: '开始共享' }).click()
  await host.locator('#share-details').waitFor({ timeout: 8000 })
  const address = await host.locator('#network').inputValue()
  await app.close()
  app = await launch()
  host = await app.firstWindow()
  await host.locator('#start:enabled').waitFor()
  assert.equal(await host.locator('#share-details').isVisible(), false)
  await app.close()
  app = await launch('tablet-link-login')
  host = await app.firstWindow()
  await host.locator('#share-details').waitFor({ timeout: 12000 })
  assert.equal(await host.locator('#network').inputValue(), address)
  await startup().uncheck()
  await host.locator('#launch-at-login:enabled').waitFor()
  assert.equal(await entry(), undefined)
})

test('automatic extension waits for approval and releases its session when the viewer leaves', { timeout: 45000 }, async (t) => {
  const executable = process.env.TABLET_LINK_EXE
  const helper = executable
    ? join(dirname(executable), 'resources', 'app', 'dist', 'tablet-pointer.exe')
    : fileURLToPath(new URL('../dist/tablet-pointer.exe', import.meta.url))
  const probe = spawnSync(helper, ['--probe-display'], { windowsHide: true })
  assert.ok(probe.status === 0 || probe.status === 10, 'Windows must report whether it has a standby VDD output')
  const app = await launchHost(t)
  const browser = await chromium.launch({ executablePath: edgeExecutable() })
  t.after(() => browser.close())
  const host = await app.firstWindow()
  const viewer = await browser.newPage({ viewport: { width: 1200, height: 800 } })
  const displayIds = () => app.evaluate(({ screen }) =>
    (globalThis.realDisplays?.() ?? screen.getAllDisplays()).map(({ id }) => id).sort())
  const original = await displayIds()

  await host.getByRole('radio', { name: '扩展副屏' }).check()
  assert.equal(await host.locator('#source').inputValue(), 'automatic-display')
  await host.getByRole('button', { name: '开始共享' }).click()
  await host.locator('#share-details').waitFor({ state: 'visible' })
  const approve = host.getByRole('button', { name: '允许连接' })
  const status = (text) => host.waitForFunction((expected) => document.querySelector('#status').textContent.includes(expected), text)
  await viewer.goto(await host.locator('#share-url').inputValue())
  await viewer.getByRole('button', { name: '请求观看' }).click()
  await approve.waitFor({ state: 'visible' })
  assert.deepEqual(await displayIds(), original)
  assert.equal(await viewer.locator('video').evaluate((video) => video.srcObject), null)

  if (probe.status === 10) {
    await approve.click()
    await status('没有可用的备用虚拟屏')
    assert.deepEqual(await displayIds(), original)
    t.diagnostic('No physical standby output. The retry exercises real Electron capture with a simulated driver session.')
    await app.evaluate(({ screen }) => {
      const target = screen.getAllDisplays().find((display) => display.label === 'VDD by MTT' && display.id !== screen.getPrimaryDisplay().id)
      if (!target) return
      const { x, y, width, height } = screen.dipToScreenRect(null, target.bounds)
      const children = process.getBuiltinModule('node:child_process')
      const spawn = children.spawn
      const realDisplays = screen.getAllDisplays.bind(screen)
      globalThis.realDisplays = realDisplays
      globalThis.testLease = { opened: 0, closed: 0 }
      screen.getAllDisplays = () => globalThis.testLease.opened > globalThis.testLease.closed
        ? realDisplays() : realDisplays().filter(({ id }) => id !== target.id)
      children.spawn = function (file, args, options) {
        if (args?.[0] !== '--lease-display') return spawn(file, args, options)
        globalThis.testLease.opened++
        const child = spawn(process.execPath, ['-e', `console.log('READY ${x} ${y} ${width - 1} ${height}'); process.stdin.resume()`],
          { ...options, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } })
        child.on('close', () => { globalThis.testLease.closed++ })
        return child
      }
    })
    if (!await app.evaluate(() => !!globalThis.testLease)) {
      t.diagnostic('No active MTT VDD output for the simulated driver session.')
      return
    }
    await viewer.getByRole('button', { name: '重新连接' }).click()
    await approve.waitFor({ state: 'visible' })
    assert.deepEqual(await app.evaluate(() => globalThis.testLease), { opened: 0, closed: 0 })
  }

  await approve.click()
  await viewer.waitForFunction(() => document.querySelector('video').videoWidth > 0, undefined, { timeout: 18000 })
  if (probe.status === 0) {
    const active = await displayIds()
    assert.equal(active.length, original.length + 1)
    assert.ok(original.every((id) => active.includes(id)))
  } else {
    assert.deepEqual(await app.evaluate(() => globalThis.testLease), { opened: 1, closed: 0 })
  }
  await viewer.waitForFunction(() => document.fullscreenElement?.id === 'stage')
  await viewer.getByRole('button', { name: '显示全屏控件' }).click()
  await viewer.locator('#leave').click()
  await status('等待平板连接')
  for (let attempt = 0; attempt < 50; attempt++) {
    const restored = probe.status === 0 ? (await displayIds()).length === original.length
      : (await app.evaluate(() => globalThis.testLease)).closed === 1
    if (restored) break
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  assert.deepEqual(await displayIds(), original)
  if (probe.status === 10) assert.deepEqual(await app.evaluate(() => globalThis.testLease), { opened: 1, closed: 1 })
})

function edgeExecutable() {
  const edge = [process.env['ProgramFiles(x86)'], process.env.ProgramFiles]
    .filter(Boolean)
    .map((directory) => join(directory, 'Microsoft', 'Edge', 'Application', 'msedge.exe'))
    .find(existsSync)
  assert.ok(edge, 'The Windows end-to-end test needs Microsoft Edge')
  return edge
}

async function launchHost(t) {
  const executablePath = process.env.TABLET_LINK_EXE
  const profile = await mkdtemp(join(tmpdir(), 'tablet-link-e2e-'))
  let app
  t.after(async () => {
    try { await app?.close() }
    finally { await rm(profile, { recursive: true, force: true, maxRetries: 4 }) }
  })
  app = await _electron.launch({
    args: [...(executablePath ? [] : ['.']), `--user-data-dir=${profile}`],
    executablePath,
    timeout: 20000,
  })
  return app
}

test('fullscreen rotation keeps playing while waiting for the first new video frame', { timeout: 30000 }, async (t) => {
  const browser = await chromium.launch({ executablePath: edgeExecutable() })
  t.after(() => browser.close())
  await t.test('holds one uncropped image and switches without blending', (t) => verifyRotation(t, browser, false))
  await t.test('keeps the same single-image behavior with the frame callback fallback', (t) => verifyRotation(t, browser, true))
})

async function verifyRotation(t, browser, useFallback) {
  const landscape = { width: 1200, height: 800 }
  const portrait = { width: 800, height: 1160 }
  const viewer = await browser.newPage({ viewport: landscape, reducedMotion: useFallback ? 'reduce' : 'no-preference' })
  t.after(() => viewer.close())
  const viewerFile = (name) => new URL(`../src/ui/${name}`, import.meta.url)
  const [html, css, script] = await Promise.all([
    readFile(viewerFile('watch.html'), 'utf8'),
    readFile(viewerFile('app.css'), 'utf8'),
    build({
      stdin: {
        contents: `import { createRotationTransition } from './src/watch-rotation.ts';
          window.createRotationTransition = createRotationTransition`,
        resolveDir: fileURLToPath(new URL('..', import.meta.url)),
      },
      bundle: true, write: false, format: 'iife',
    }),
  ])
  await viewer.setContent(html)
  await viewer.addStyleTag({ content: css })
  await viewer.addScriptTag({ content: script.outputFiles[0].text })
  await viewer.evaluate((useFallback) => {
    const video = document.querySelector('video')
    if (useFallback) Object.defineProperty(video, 'requestVideoFrameCallback', { value: undefined })
    const snapshot = document.querySelector('#rotation-frame')
    const source = document.createElement('canvas')
    const context = source.getContext('2d')
    const transition = window.createRotationTransition(video, snapshot, () => {})
    const orientation = matchMedia('(orientation: portrait)')
    orientation.addEventListener('change', () => transition.start(orientation.matches ? 'portrait' : 'landscape'))
    const full = document.querySelector('#fullscreen')
    full.disabled = false
    full.addEventListener('click', () => document.querySelector('#stage').requestFullscreen())
    document.querySelector('#viewer-prompt').hidden = true
    function draw(width, height, color, blackEdge = false, markBottom = false) {
      source.width = width
      source.height = height
      context.fillStyle = color
      context.fillRect(0, 0, width, height)
      if (markBottom) {
        context.fillStyle = '#f3bf40'
        context.fillRect(0, height * 0.55, width, height * 0.45)
      }
      if (blackEdge) {
        context.fillStyle = '#000000'
        if (height > width) context.fillRect(0, height * 0.65, width, height * 0.35)
        else context.fillRect(width * 0.65, 0, width * 0.35, height)
      }
    }
    draw(300, 200, '#208060', false, true)
    const stream = source.captureStream(0)
    video.srcObject = stream
    const [track] = stream.getVideoTracks()
    window.showFrame = (width, height, color, blackEdge, markBottom) => {
      draw(width, height, color, blackEdge, markBottom)
      track.requestFrame()
    }
  }, useFallback)
  await viewer.waitForFunction(() => document.querySelector('video').readyState >= HTMLMediaElement.HAVE_CURRENT_DATA)
  await viewer.locator('#fullscreen').click()
  await viewer.waitForFunction(() => document.fullscreenElement?.id === 'stage')
  const snapshot = viewer.locator('#rotation-frame')

  for (const [size, previousColor, width, height, color, lateColor, lateRGB] of [
    [portrait, [32, 128, 96], 200, 300, '#a04830', '#486ac2', [72, 106, 194]],
    [landscape, [160, 72, 48], 300, 200, '#208060', '#9858b0', [152, 88, 176]],
  ]) {
    await viewer.setViewportSize(size)
    await snapshot.waitFor({ state: 'visible' })
    assert.deepEqual(await snapshot.evaluate((canvas) => [canvas.width, canvas.height, getComputedStyle(canvas).objectFit]),
      [height, width, 'contain'], 'the outgoing image must stay at its original aspect ratio and fit without cropping')
    const rows = await snapshot.evaluate((canvas) => {
      const context = canvas.getContext('2d')
      return [0.2, 0.8].map((y) => Array.from(context.getImageData(canvas.width * 0.45, canvas.height * y, 1, 1).data).slice(0, 3))
    })
    assert.ok(rows[0].every((value, i) => Math.abs(value - previousColor[i]) <= 3) &&
      rows[1].every((value, i) => Math.abs(value - [243, 191, 64][i]) <= 3),
    `the outgoing image should keep its top and bottom until the desktop switches, got ${JSON.stringify(rows)}`)
    const screenshot = await viewer.screenshot()
    const corner = await viewer.evaluate(async (png) => {
      const img = new Image()
      img.src = `data:image/png;base64,${png}`
      await img.decode()
      const pixel = document.createElement('canvas').getContext('2d')
      pixel.drawImage(img, 8, 12, 1, 1, 0, 0, 1, 1)
      return Array.from(pixel.getImageData(0, 0, 1, 1).data).slice(0, 3)
    }, screenshot.toString('base64'))
    assert.ok(corner.every((value, i) => Math.abs(value - [64, 83, 75][i]) <= 3),
      `the space around the fitted frame should have an opaque backdrop, got ${corner}`)
    await viewer.evaluate(({ width, height }) => window.showFrame(height, width, '#000000'), { width, height })
    await viewer.waitForTimeout(160)
    const retained = await snapshot.evaluate((canvas) => Array.from(canvas.getContext('2d').getImageData(8, 12, 1, 1).data).slice(0, 3))
    assert.ok(retained.every((value, i) => Math.abs(value - previousColor[i]) <= 3),
      'an incomplete frame at the outgoing dimensions must leave the last good frame intact')
    await viewer.evaluate(({ width, height, lateColor }) => window.showFrame(height, width, lateColor), { width, height, lateColor })
    await viewer.waitForFunction((expected) => {
      const canvas = document.querySelector('#rotation-frame')
      if (canvas.hidden) return false
      const pixel = canvas.getContext('2d').getImageData(8, 12, 1, 1).data
      return expected.every((value, i) => Math.abs(pixel[i] - value) <= 3)
    }, lateRGB, { timeout: 700 })
    await viewer.evaluate(() => window.showFrame(250, 250, '#000000'))
    await viewer.waitForFunction(() => document.querySelector('video').videoWidth === 250)
    const transitionFrame = await snapshot.evaluate(async (canvas) => {
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
      if (canvas.hidden || canvas.getAnimations().length) return null
      return Array.from(canvas.getContext('2d').getImageData(8, 12, 1, 1).data).slice(0, 3)
    })
    assert.ok(transitionFrame?.every((value, i) => Math.abs(value - lateRGB[i]) <= 3),
      'a square frame must neither replace the transition image nor reveal the live video')
    await viewer.evaluate(({ width, height }) => window.showFrame(width, height, '#000000'), { width, height })
    await viewer.waitForFunction((width) => document.querySelector('video').videoWidth === width, width)
    await viewer.waitForTimeout(170)
    assert.ok(await snapshot.evaluate((canvas) => !canvas.hidden && canvas.getAnimations().length === 0),
      'the first fully black frame at the new dimensions must stay covered')
    await viewer.evaluate(({ width, height, color }) => window.showFrame(width, height, color, true), { width, height, color })
    await viewer.waitForFunction((width) => document.querySelector('video').videoWidth === width, width)
    const stillCovered = await snapshot.evaluate(async (canvas) => {
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
      return !canvas.hidden && canvas.getAnimations().length === 0
    })
    assert.ok(stillCovered, 'a matching frame with a black edge should stay covered')
    const painted = await snapshot.evaluate((canvas) => {
      const ctx = canvas.getContext('2d')
      return [[12, 12], [canvas.width - 12, canvas.height - 12]].map(([x, y]) =>
        Array.from(ctx.getImageData(x, y, 1, 1).data).slice(0, 3))
    })
    assert.ok(painted.every((pixel) => pixel.every((value, i) => Math.abs(value - lateRGB[i]) <= 3)),
      'an incomplete new frame must never be painted over the previous image')
    // Some Windows modes report the new dimensions well before the whole desktop is painted.
    await viewer.waitForTimeout(400)
    assert.ok(await snapshot.evaluate((canvas) => !canvas.hidden && canvas.getAnimations().length === 0),
      'the first incomplete frame must stay covered beyond the short resize settling period')
    await viewer.evaluate(async ({ width, height, color }) => {
      window.showFrame(width, height, color)
      await new Promise((resolve) => setTimeout(resolve, 50))
      window.showFrame(width, height, color, true)
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    }, { width, height, color })
    assert.ok(await snapshot.evaluate((canvas) => !canvas.hidden && canvas.getAnimations().length === 0),
      'a clean frame followed by an incomplete frame should also stay covered')
    const blended = await viewer.evaluate(({ width, height, color }) => new Promise((resolve) => {
      const video = document.querySelector('video')
      const snapshot = document.querySelector('#rotation-frame')
      function observe() {
        if (snapshot.hidden) return resolve(false)
        const opacity = Number(getComputedStyle(snapshot).opacity)
        if (video.videoWidth === width && video.videoHeight === height && opacity > 0 && opacity < 1) return resolve(true)
        requestAnimationFrame(observe)
      }
      requestAnimationFrame(observe)
      window.showFrame(width, height, color, false, true)
    }), { width, height, color })
    assert.equal(blended, false, 'two frames must never be visible during the switch')
    await viewer.waitForFunction(({ width, height }) => {
      const video = document.querySelector('video')
      return video.videoWidth === width && video.videoHeight === height && document.querySelector('#rotation-frame').hidden
    }, { width, height }, { timeout: 1200 })
    assert.equal(await viewer.locator('video').evaluate((video) => getComputedStyle(video).objectFit), 'contain')
  }

  await viewer.setViewportSize(portrait)
  await snapshot.waitFor({ state: 'visible' })
  await viewer.evaluate(() => window.showFrame(200, 300, '#a04830', true))
  await viewer.waitForTimeout(2000)
  assert.ok(await snapshot.isVisible(), 'the old snapshot should cover a long run of incomplete new frames')
  // Persistent dark content has a bounded fallback so the receiver cannot stay frozen.
  await snapshot.waitFor({ state: 'hidden', timeout: 2300 })
}

async function streamScreen(t, extension = false) {
  const edge = edgeExecutable()
  const address = Object.values(networkInterfaces()).flat().find((entry) => (
    entry?.family === 'IPv4' && /^(192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/.test(entry.address)
  ))?.address
  assert.ok(address, 'The test needs a private IPv4 address')
  const app = await launchHost(t)
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

  const navigation = host.getByRole('navigation', { name: '应用导航' })
  await navigation.getByRole('button', { name: '画质设置' }).click()
  await host.getByLabel('最高帧率').waitFor({ state: 'visible' })
  await navigation.getByRole('button', { name: '关于' }).click()
  await host.getByRole('button', { name: 'GitHub 源码' }).waitFor({ state: 'visible' })
  await navigation.getByRole('button', { name: '屏幕连接' }).click()
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
    assert.deepEqual(listed, ['automatic-display', ...extendedDisplays.map(({ id }) => id)])
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
  await viewer.waitForFunction(() => document.fullscreenElement?.id === 'stage', undefined, { timeout: 2500 })
  t.diagnostic(`Decoded ${dimensions.join(' × ')} video from Windows screen capture`)
  const streamHud = viewer.locator('#stream-hud')
  await streamHud.waitFor({ state: 'visible' })
  await viewer.waitForFunction(() => /\d+ FPS/.test(document.querySelector('#stream-hud').textContent))
  assert.match(await streamHud.innerText(), /串流中.*Wi-Fi \/ 局域网/s)
  assert.ok((await streamHud.innerText()).includes(dimensions.join(' × ')))
  assert.match(await streamHud.locator('#stream-bitrate').innerText(), /\d+\.\d+ Mb\/s/)
  await viewer.waitForFunction(() => {
    const graph = document.querySelector('#stream-history')
    const pixels = graph.getContext('2d').getImageData(0, 0, graph.width, graph.height).data
    for (let i = 0; i < pixels.length; i += 4) {
      if (pixels[i + 1] > 200 && pixels[i + 1] > pixels[i] + 80 && pixels[i + 3] > 180) return true
    }
    return false
  })

  await navigation.getByRole('button', { name: '画质设置' }).click()
  const resolutionLimit = host.getByLabel('采集分辨率上限')
  const frameLimit = host.getByLabel('最高帧率')
  const initialLimits = [await resolutionLimit.inputValue(), await frameLimit.inputValue()]
  const targetFps = initialLimits[1] === '30' ? '45' : '30'
  await viewer.evaluate(() => { window.testQualityStream = document.querySelector('video').srcObject })
  await resolutionLimit.selectOption('1280')
  await frameLimit.selectOption(targetFps)
  await host.getByRole('button', { name: '应用', exact: true }).click()
  await host.getByText('已应用到当前共享').waitFor({ state: 'visible' })
  await viewer.waitForFunction(() => {
    const video = document.querySelector('video')
    return video.srcObject === window.testQualityStream && Math.max(video.videoWidth, video.videoHeight) <= 1280
  })
  const appliedFps = await host.evaluate(() => window.testPeer.getSenders()[0].track.getSettings().frameRate)
  assert.ok(appliedFps > 0 && appliedFps <= Number(targetFps))
  await resolutionLimit.selectOption(initialLimits[0])
  await frameLimit.selectOption(initialLimits[1])
  await host.getByRole('button', { name: '应用', exact: true }).click()
  await host.getByText('已应用到当前共享').waitFor({ state: 'visible' })
  await navigation.getByRole('button', { name: '屏幕连接' }).click()

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

  await viewer.locator('.viewer-bar').waitFor({ state: 'hidden', timeout: 3000 })
  assert.ok(await streamHud.isVisible())
  assert.equal(await streamHud.evaluate((node) => getComputedStyle(node).pointerEvents), 'none')
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

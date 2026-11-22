import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { _electron, chromium } from 'playwright-core'

assert.ok(process.argv[2], 'Usage: node test/window-drag.mjs <Tablet-Link.exe> [--tablet]')
const executablePath = resolve(process.argv[2])
const edge = [process.env['ProgramFiles(x86)'], process.env.ProgramFiles].filter(Boolean)
  .map((directory) => join(directory, 'Microsoft', 'Edge', 'Application', 'msedge.exe')).find(existsSync)
assert.ok(edge, 'Microsoft Edge is required')
const opened = []

try {
  const app = await _electron.launch({ executablePath, args: [], timeout: 15000 })
  opened.push(app)
  const host = await app.firstWindow()
  await host.getByRole('radio', { name: '扩展副屏' }).check()
  const source = await host.evaluate(async () => (await window.tabletLink.sources()).find(
    ({ name, role }) => name.startsWith('VDD by MTT') && role === 'extension'))
  assert.ok(source, 'An active virtual extension is required')
  const display = await app.evaluate(({ screen }, id) => (
    screen.getAllDisplays().find((item) => String(item.id) === id).bounds), source.displayId)
  await host.locator('#source').selectOption(source.id)
  await host.getByRole('checkbox', { name: '允许平板触控' }).check()

  const desktop = await chromium.launch({ executablePath: edge, headless: false, args: ['--no-first-run'] })
  opened.push(desktop)
  const settings = await desktop.newPage({ viewport: null })
  await settings.goto('edge://version')
  const windowSession = await settings.context().newCDPSession(settings)
  const { windowId } = await windowSession.send('Browser.getWindowForTarget')
  const left = display.x + 220
  const top = display.y + 155
  const width = 920
  const height = 640
  const travel = 140
  const moveWindow = (offset) => windowSession.send('Browser.setWindowBounds', {
    windowId, bounds: { left: left + offset, top, width, height, windowState: 'normal' },
  })
  await moveWindow(0)
  await host.getByRole('button', { name: '开始共享' }).click()
  await host.locator('#share-url').waitFor({ state: 'visible' })
  if (process.argv.includes('--tablet')) {
    console.log('二维码已准备。扩展屏上已打开 Edge。请用 MatePad 扫码，再在电脑上允许连接。')
    await host.waitForEvent('close', { timeout: 0 })
  } else {
    await measure({ host, windowSession, windowId, display, left, top, travel, moveWindow })
  }
} finally {
  for (const resource of opened.reverse()) await resource.close().catch(() => {})
}

async function measure({ host, windowSession, windowId, display, left, top, travel, moveWindow }) {
  const browser = await chromium.launch({ executablePath: edge })
  opened.push(browser)
  const viewer = await browser.newPage({ viewport: { width: 1200, height: 800 }, hasTouch: true })
  await viewer.addInitScript(() => {
    const Original = window.RTCPeerConnection
    window.RTCPeerConnection = class extends Original {
      constructor(...args) {
        super(...args)
        window.windowDragPeer = this
      }
    }
  })
  await host.evaluate(() => {
    const Original = window.RTCPeerConnection
    window.RTCPeerConnection = class extends Original {
      constructor(...args) {
        super(...args)
        window.windowDragPeer = this
      }
    }
  })
  await viewer.goto(await host.locator('#share-url').inputValue())
  await viewer.getByRole('button', { name: '请求观看' }).click()
  await host.getByRole('button', { name: '允许连接' }).click()
  await viewer.locator('.touch-enabled').waitFor({ timeout: 18000 })
  if (process.env.TABLET_LINK_OVERRIDE_BUFFER !== undefined) {
    await viewer.evaluate((target) => {
      const receiver = window.windowDragPeer.getReceivers().find(({ track }) => track.kind === 'video')
      receiver.jitterBufferTarget = target
    }, Number(process.env.TABLET_LINK_OVERRIDE_BUFFER))
  }

  // Follow the left edge of the actual Edge window at several heights.
  const video = await viewer.evaluate(() => {
    const element = document.querySelector('video')
    const rect = element.getBoundingClientRect()
    const scale = Math.min(rect.width / element.videoWidth, rect.height / element.videoHeight)
    const width = scale * element.videoWidth
    const height = scale * element.videoHeight
    return { x: rect.x + (rect.width - width) / 2, y: rect.y + (rect.height - height) / 2, width, height }
  })
  await viewer.evaluate(({ x, y, width, height }) => {
    const element = document.querySelector('video')
    const canvas = document.createElement('canvas')
    canvas.width = 8
    canvas.height = 8
    const context = canvas.getContext('2d', { willReadFrequently: true })
    window.dragPixels = () => {
      context.drawImage(element, x * element.videoWidth, y * element.videoHeight,
        width * element.videoWidth, height * element.videoHeight, 0, 0, 8, 8)
      return Array.from(context.getImageData(0, 0, 8, 8).data).filter((_, index) => index % 4 !== 3)
    }
  }, { x: 242 / display.width, y: 250 / display.height, width: 68 / display.width, height: 435 / display.height })
  await delay(450)
  const first = await viewer.evaluate(() => window.dragPixels())
  await moveWindow(travel)
  await delay(450)
  const second = await viewer.evaluate(() => window.dragPixels())
  const distance = first.reduce((sum, value, index) => sum + Math.abs(value - second[index]), 0)
  assert.ok(distance > 1500, `The Edge window edge must be identifiable (color distance ${distance})`)
  await moveWindow(0)
  await delay(800)

  await viewer.evaluate(({ first, second, distance }) => {
    const video = document.querySelector('video')
    const area = video.parentElement
    const results = []
    let pending
    const send = RTCDataChannel.prototype.send
    RTCDataChannel.prototype.send = function (data) {
      if (pending && typeof data === 'string' && data.includes('"action":"move"')) pending.sent ??= performance.now()
      return send.call(this, data)
    }
    window.dragResults = results
    window.armDrag = (side) => { pending = side === undefined ? undefined : { side } }
    area.addEventListener('pointermove', (event) => { if (pending) pending.input ??= event.timeStamp }, true)
    const relativeDistance = (pixels, reference) => pixels.reduce((sum, value, index) => sum + Math.abs(value - reference[index]), 0)
    const frame = (now, meta) => {
      if (pending?.input !== undefined) {
        const target = pending.side ? second : first
        const pixels = window.dragPixels()
        const other = pending.side ? first : second
        if (relativeDistance(pixels, target) < Math.min(distance * .66, relativeDistance(pixels, other) * .65)) {
          results.push({
            input: performance.timeOrigin + pending.input,
            total: meta.expectedDisplayTime - pending.input,
            sendWait: pending.sent === undefined ? undefined : pending.sent - pending.input,
            capture: meta.captureTime === undefined ? undefined : performance.timeOrigin + meta.captureTime,
            captureToReceive: meta.captureTime === undefined || meta.receiveTime === undefined ? undefined : meta.receiveTime - meta.captureTime,
            receiveToDisplay: meta.receiveTime === undefined ? undefined : meta.expectedDisplayTime - meta.receiveTime,
          })
          pending = undefined
        }
      }
      video.requestVideoFrameCallback(frame)
    }
    video.requestVideoFrameCallback(frame)
  }, { first, second, distance })

  const receiverStats = () => viewer.evaluate(async () => {
    const peer = window.windowDragPeer
    const report = await peer.getStats()
    const inbound = [...report.values()].find((entry) => entry.type === 'inbound-rtp' && entry.kind === 'video')
    const target = peer.getReceivers().find(({ track }) => track.kind === 'video').jitterBufferTarget
    return { inbound, target, codec: report.get(inbound?.codecId)?.mimeType }
  })
  const senderStats = () => host.evaluate(async () => {
    const report = await window.windowDragPeer.getStats()
    return [...report.values()].find((entry) => entry.type === 'outbound-rtp' && entry.kind === 'video')
  })
  if (process.env.TABLET_LINK_EXPECT_BUFFER !== undefined) {
    assert.equal((await receiverStats()).target, Number(process.env.TABLET_LINK_EXPECT_BUFFER))
  }
  const before = await receiverStats()
  const senderBefore = await senderStats()
  const session = await viewer.context().newCDPSession(viewer)
  const point = (offset) => ({ x: Math.round(video.x + (left - display.x + 565 + offset) * video.width / display.width),
    y: Math.round(video.y + (top - display.y + 15) * video.height / display.height), id: 1 })
  const touches = (type, offset) => session.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [point(offset)] })
  const startDrag = async (offset) => {
    await touches('touchStart', offset)
    await touches('touchMove', offset + 24)
    await delay(120)
    await touches('touchMove', offset)
    await delay(120)
  }
  const nativeMoves = []
  const attempts = 20
  // The fixed stops distinguish each returned window position while exercising the normal drag path.
  try {
    await startDrag(0)
    for (let index = 0; index < attempts; index++) {
      const side = (index + 1) % 2
      const direction = side ? 1 : -1
      const count = nativeMoves.length
      const { bounds: previous } = await windowSession.send('Browser.getWindowBounds', { windowId })
      await viewer.evaluate((side) => window.armDrag(side), side)
      const nativeMove = (async () => {
        const deadline = Date.now() + 500
        while (Date.now() < deadline) {
          const { bounds } = await windowSession.send('Browser.getWindowBounds', { windowId })
          if ((bounds.left - previous.left) * direction > travel * .55) return Date.now()
          await delay(2)
        }
      })()
      await touches('touchMove', side * travel)
      const movement = await nativeMove
      if (!movement) {
        await viewer.evaluate((count) => {
          window.armDrag(undefined)
          window.dragResults.length = count
        }, count)
        await touches('touchEnd')
        await moveWindow(side * travel)
        await delay(300)
        await startDrag(side * travel)
        continue
      }
      const recorded = await viewer.waitForFunction((count) => window.dragResults.length > count, count, { timeout: 800 })
        .then(() => true).catch(() => viewer.evaluate((count) => {
          if (window.dragResults.length > count) return true
          window.armDrag(undefined)
          return false
        }, count))
      if (recorded) nativeMoves.push(movement)
      await delay(80)
    }
  } finally {
    await touches('touchEnd')
  }
  const after = await receiverStats()
  const senderAfter = await senderStats()
  const results = await viewer.evaluate(() => window.dragResults)
  assert.ok(results.length >= 12, `Matched only ${results.length} of ${attempts} actual window moves`)
  const summary = (values) => {
    const sorted = values.filter(Number.isFinite).sort((a, b) => a - b)
    const percentile = (p) => Math.round(sorted[Math.ceil(sorted.length * p) - 1])
    return sorted.length ? { p50: percentile(.5), p95: percentile(.95) } : undefined
  }
  const average = (field, count) => {
    const divisor = after.inbound[count] - before.inbound[count]
    const delta = after.inbound[field] - before.inbound[field]
    return divisor > 0 && Number.isFinite(delta) ? Math.round(delta * 1000 / divisor) : undefined
  }
  const encoded = senderAfter.framesEncoded - senderBefore.framesEncoded
  console.log(JSON.stringify({ samples: results.length, attempts, app: 'Microsoft Edge',
    resolution: [after.inbound.frameWidth, after.inbound.frameHeight], codec: after.codec, receiverBufferTarget: after.target,
    framesDecoded: after.inbound.framesDecoded - before.inbound.framesDecoded,
    framesDropped: after.inbound.framesDropped - before.inbound.framesDropped,
    total: summary(results.map(({ total }) => total)),
    enqueue: summary(results.map(({ sendWait }) => sendWait)),
    inputToWindow: summary(results.map(({ input }, index) => nativeMoves[index] - input)),
    windowToCapture: summary(results.map(({ capture }, index) => capture - nativeMoves[index])),
    captureToReceive: summary(results.map(({ captureToReceive }) => captureToReceive)),
    receiveToDisplay: summary(results.map(({ receiveToDisplay }) => receiveToDisplay)),
    jitterBuffer: average('jitterBufferDelay', 'jitterBufferEmittedCount'),
    suggestedMinBuffer: average('jitterBufferMinimumDelay', 'jitterBufferEmittedCount'),
    decode: average('totalDecodeTime', 'framesDecoded'),
    encode: encoded > 0 ? Math.round(1000 * (senderAfter.totalEncodeTime - senderBefore.totalEncodeTime) / encoded) : undefined,
    encoder: senderAfter.encoderImplementation,
  }))
}

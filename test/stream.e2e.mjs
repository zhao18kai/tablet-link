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
  host.on('console', (message) => {
    if (message.type() === 'error') t.diagnostic(message.text().replace(/token=[\w-]+/g, 'token=[redacted]'))
  })
  const browser = await chromium.launch({ executablePath: edge })
  t.after(() => browser.close())
  const viewer = await browser.newPage({ viewport: { width: 1200, height: 800 }, hasTouch: true })

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

    // Draw a test color on the selected display so a duplicate of the primary cannot pass.
    await app.evaluate(async ({ BrowserWindow, screen }, displayId) => {
      const display = screen.getAllDisplays().find(({ id }) => String(id) === displayId)
      if (!display) throw new Error('The selected display disappeared during the test')
      const marker = new BrowserWindow({
        ...display.bounds, show: false, frame: false, focusable: false, alwaysOnTop: true, skipTaskbar: true,
      })
      await marker.loadURL('data:text/html,<body style="background:%232f93cb">')
      marker.showInactive()
    }, target.displayId)
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
  }

  await viewer.getByRole('button', { name: '全屏', exact: true }).click()
  await viewer.waitForFunction(() => document.fullscreenElement?.id === 'stage')
  await viewer.locator('.viewer-bar').waitFor({ state: 'hidden', timeout: 3000 })
  const fit = viewer.getByRole('button', { name: '铺满画面（裁边）' })
  const surface = viewer.getByRole('button', { name: '显示全屏控件' })
  await surface.tap()
  assert.equal(await fit.getAttribute('aria-pressed'), 'false')
  assert.equal(await viewer.locator('video').evaluate((video) => getComputedStyle(video).objectFit), 'contain')
  await fit.tap()
  assert.equal(await fit.getAttribute('aria-pressed'), 'true')
  assert.equal(await viewer.locator('video').evaluate((video) => getComputedStyle(video).objectFit), 'cover')
  await fit.tap()
  assert.equal(await viewer.locator('video').evaluate((video) => getComputedStyle(video).objectFit), 'contain')
  await viewer.getByRole('button', { name: '隐藏全屏控件' }).tap()
  await viewer.locator('.viewer-bar').waitFor({ state: 'hidden' })

  await host.getByRole('button', { name: '停止共享' }).click()
  await viewer.waitForFunction(() => document.querySelector('video').srcObject === null)
  await viewer.waitForFunction(() => document.fullscreenElement === null)
  await assert.rejects(fetch(url))
}

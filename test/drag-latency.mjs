import assert from 'node:assert/strict'
import { constants, existsSync } from 'node:fs'
import { access, appendFile, cp, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { _electron, chromium } from 'playwright-core'
import { dragProbeStyle, dragReceiverProbe, dragTarget } from './drag-probe.mjs'

const packageRoot = process.argv[2]
assert.ok(packageRoot, 'Usage: node test/drag-latency.mjs <Windows package folder> [--tablet]')
const packageApp = resolve(packageRoot, 'resources', 'app')
await access(join(packageApp, 'dist', 'watch.js'), constants.R_OK)
const tempRoot = resolve(tmpdir())
const fixture = await mkdtemp(join(tempRoot, 'tablet-link-drag-'))
const tablet = process.argv.includes('--tablet')
let app, browser

try {
  await cp(packageApp, fixture, { recursive: true })
  await appendFile(join(fixture, 'dist', 'watch.js'), `\n;${dragReceiverProbe}`)
  await appendFile(join(fixture, 'dist', 'app.css'), dragProbeStyle)
  app = await _electron.launch({ args: [fixture], timeout: 15000 })
  const host = await app.firstWindow()
  await host.getByRole('radio', { name: '扩展副屏' }).check()
  const target = await host.evaluate(async () => (
    (await window.tabletLink.sources()).find(({ name, role }) => role === 'extension' && name.startsWith('VDD by MTT'))
  ))
  assert.ok(target, 'An active VDD by MTT extension is required for this test')
  await host.locator('#source').selectOption(target.id)
  await host.getByRole('checkbox', { name: '允许平板触控' }).check()
  await app.evaluate(async ({ BrowserWindow, screen }, { displayId, html }) => {
    const display = screen.getAllDisplays().find(({ id }) => String(id) === displayId)
    const marker = new BrowserWindow({ ...display.bounds, frame: false, show: false, alwaysOnTop: true, skipTaskbar: true })
    globalThis.tabletLinkDragFixture = marker
    await marker.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html))
    marker.showInactive()
    const host = BrowserWindow.getAllWindows().find((window) => window !== marker)
    host.setTitle('平板智联 · 拖拽延迟测试')
    host.focus()
  }, { displayId: target.displayId, html: dragTarget })
  await host.getByRole('button', { name: '开始共享' }).click()
  await host.locator('#share-url').waitFor({ state: 'visible', timeout: 12000 })
  const approve = host.getByRole('button', { name: '允许连接' })

  if (tablet) {
    console.log('二维码已准备。请在电脑端允许平板的观看请求，然后从左向右匀速拖动。结果会显示在接收页，关闭测试窗口即可结束。')
    await host.waitForEvent('close', { timeout: 0 })
  } else {
    const marker = app.windows().find((window) => window.url().startsWith('data:text/html;'))
    assert.ok(marker, 'The Windows drag and scroll test window must be available')
    const scrollBox = marker.locator('#scroll')
    const scrollRange = await scrollBox.evaluate((box) => box.scrollHeight - box.clientHeight)
    assert.ok(scrollRange > 0, 'The test box must have content beyond its visible area')
    const edge = [process.env['ProgramFiles(x86)'], process.env.ProgramFiles].filter(Boolean)
      .map((directory) => join(directory, 'Microsoft', 'Edge', 'Application', 'msedge.exe')).find(existsSync)
    assert.ok(edge, 'Local calibration requires Microsoft Edge')
    browser = await chromium.launch({ executablePath: edge })
    const page = await browser.newPage({ viewport: { width: 1200, height: 800 }, hasTouch: true })
    await page.goto(await host.locator('#share-url').inputValue())
    await page.getByRole('button', { name: '请求观看' }).click()
    await approve.click()
    await page.locator('.touch-enabled').waitFor({ state: 'visible', timeout: 15000 })
    const rect = await page.locator('video').boundingBox()
    const y = Math.round(rect.y + rect.height * .62)
    const cdp = await page.context().newCDPSession(page)
    for (let i = 0; i <= 32; i++) {
      const x = Math.round(rect.x + rect.width * (.06 + .88 * i / 32))
      await cdp.send('Input.dispatchTouchEvent', { type: i ? 'touchMove' : 'touchStart', touchPoints: [{ x, y, id: 1 }] })
      await delay(95)
    }
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
    const probe = page.locator('#drag-probe')
    await page.locator('#drag-probe[data-summary]').waitFor({ timeout: 7000 }).catch(async (error) => {
      const sampleProgress = await probe.evaluate(({ dataset }) => ({ ...dataset }))
      throw new Error(`Drag probe did not finish: ${JSON.stringify(sampleProgress)}`, { cause: error })
    })
    const video = await page.locator('video').evaluate((element) => {
      const rect = element.getBoundingClientRect()
      const scale = Math.min(rect.width / element.videoWidth, rect.height / element.videoHeight)
      const height = scale * element.videoHeight
      return { x: rect.x + rect.width / 2, y: rect.y + (rect.height - height) / 2, height }
    })
    const scrollY = Math.round(video.y + video.height * .86)
    const fingers = (dy) => [{ x: Math.round(video.x - 24), y: scrollY + dy, id: 1 },
      { x: Math.round(video.x + 24), y: scrollY + dy, id: 2 }]
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: fingers(0) })
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: fingers(-48) })
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
    await marker.waitForFunction((minimum) => document.querySelector('#scroll').scrollTop >= minimum,
      Math.min(scrollRange, 60), { timeout: 6000 })
    const scrollPixels = await scrollBox.evaluate((box) => box.scrollTop)
    console.log(JSON.stringify({ receiver: 'local Edge', ...JSON.parse(await probe.getAttribute('data-summary')), scrollPixels }))
  }
} finally {
  await browser?.close().catch(() => {})
  await app?.close().catch(() => {})
  if (/^tablet-link-drag-[^\\/]+$/.test(relative(tempRoot, resolve(fixture)))) await rm(fixture, { recursive: true, force: true })
}

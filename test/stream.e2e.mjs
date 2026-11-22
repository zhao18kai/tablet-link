import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { networkInterfaces } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { _electron, chromium } from 'playwright-core'

test('Windows screen reaches a separate Chromium browser over a LAN address', { timeout: 60000 }, async (t) => {
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
  const viewer = await browser.newPage({ viewport: { width: 1200, height: 800 } })

  await host.locator('#network').selectOption(address)
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

  await viewer.getByRole('button', { name: '全屏', exact: true }).click()
  await viewer.waitForFunction(() => document.fullscreenElement?.id === 'stage')

  await host.getByRole('button', { name: '停止共享' }).click()
  await viewer.waitForFunction(() => document.querySelector('video').srcObject === null)
  await viewer.waitForFunction(() => document.fullscreenElement === null)
  await assert.rejects(fetch(url))
})

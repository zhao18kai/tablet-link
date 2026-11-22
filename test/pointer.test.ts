import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'
import { displayPointerPosition, parsePointerCommand, videoPointerPosition, type PointerCommand } from '../src/pointer.ts'
import { createViewerPointer } from '../src/watch-pointer.ts'

const frame = { left: 0, top: 0, width: 900, height: 600 }

test('touches on letterbox bars never reach Windows', () => {
  assert.equal(videoPointerPosition(frame, 1600, 900, false, 450, 10), undefined)
  assert.deepEqual(videoPointerPosition(frame, 1600, 900, false, 450, 300), { x: 0.5, y: 0.5 })
  assert.deepEqual(videoPointerPosition(frame, 1600, 900, false, 450, 610, true), { x: 0.5, y: 1 })
})

test('fill mode translates visible coordinates into the cropped source', () => {
  const point = videoPointerPosition(frame, 1600, 900, true, 0, 300)
  assert.ok(point)
  assert.ok(point.x > 0.07 && point.x < 0.08)
  assert.equal(point.y, 0.5)
})

test('touch coordinates stay within the chosen display, including negative origins', () => {
  const bounds = { x: -1600, y: -100, width: 1600, height: 900 }
  assert.deepEqual(displayPointerPosition(bounds, { x: 0, y: 0 }), { x: -1600, y: -100 })
  assert.deepEqual(displayPointerPosition(bounds, { x: 1, y: 1 }), { x: -1, y: 799 })
})

test('the pointer channel accepts only finite in-bounds mouse actions', () => {
  assert.deepEqual(parsePointerCommand('{"action":"down","x":0,"y":1}'), { action: 'down', x: 0, y: 1 })
  assert.deepEqual(parsePointerCommand('{"action":"cancel"}'), { action: 'cancel' })
  assert.equal(parsePointerCommand('{"action":"up","x":0,"y":2}'), undefined)
  assert.equal(parsePointerCommand('{"action":"move","x":1e400,"y":0}'), undefined)
  assert.equal(parsePointerCommand('{"action":"keydown","x":0,"y":0}'), undefined)
})

test('the pointer channel accepts only bounded, nonzero integer wheel deltas', () => {
  for (const delta of [-480, -120, 120, 480]) {
    assert.deepEqual(parsePointerCommand(JSON.stringify({ action: 'wheel', x: 0, y: 1, delta })),
      { action: 'wheel', x: 0, y: 1, delta })
  }
  for (const delta of ['-481', '481', '0', '1.5', '1e400', '"120"', 'null']) {
    assert.equal(parsePointerCommand(`{"action":"wheel","x":0,"y":1,"delta":${delta}}`), undefined)
  }
  assert.equal(parsePointerCommand('{"action":"wheel","x":-0.1,"y":1,"delta":120}'), undefined)
  assert.equal(parsePointerCommand('{"action":"wheel","x":0,"y":1}'), undefined)
})

function viewerPointer(t: TestContext, videoWidth = 900, videoHeight = 600) {
  const commands: PointerCommand[] = []
  let menus = 0
  let nextFrame = 0
  const frames = new Map<number, FrameRequestCallback>()
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      requestAnimationFrame(callback: FrameRequestCallback) { frames.set(++nextFrame, callback); return nextFrame },
      cancelAnimationFrame(id: number) { frames.delete(id) },
      setInterval() {},
    },
  })
  t.after(() => { Reflect.deleteProperty(globalThis, 'window') })
  const area = Object.assign(new EventTarget(), { classList: { toggle() {} }, setPointerCapture() {} })
  const video = { videoWidth, videoHeight, classList: { contains: () => false }, getBoundingClientRect: () => frame }
  const pointer = createViewerPointer(area as unknown as HTMLElement, video as unknown as HTMLVideoElement,
    (command) => commands.push(command), () => { menus++ })
  pointer.setEnabled(true)
  return {
    ...pointer,
    emit(type: string, pointerId: number, clientX: number, clientY: number) {
      area.dispatchEvent(Object.assign(new Event(`pointer${type}`, { cancelable: true }),
        { pointerId, pointerType: 'touch', button: 0, clientX, clientY }))
    },
    frame() {
      for (const [id, callback] of frames) {
        frames.delete(id)
        callback(0)
      }
    },
    commands,
    get menus() { return menus },
  }
}

test('vertical touch travel scrolls at the midpoint in both directions', (t) => {
  const pointer = viewerPointer(t)
  pointer.emit('down', 1, 400, 300)
  pointer.emit('down', 2, 500, 300)
  pointer.emit('move', 1, 400, 276)
  pointer.frame()
  assert.deepEqual(pointer.commands, [])
  pointer.emit('move', 2, 500, 276)
  pointer.frame()
  assert.deepEqual(pointer.commands, [{ action: 'wheel', x: 0.5, y: 0.46, delta: -120 }])
  pointer.emit('move', 1, 400, 300)
  pointer.emit('move', 2, 500, 300)
  pointer.emit('up', 1, 400, 300)
  pointer.emit('move', 2, 500, 550)
  pointer.emit('up', 2, 500, 550)
  pointer.frame()
  assert.deepEqual(pointer.commands, [
    { action: 'wheel', x: 0.5, y: 0.46, delta: -120 },
    { action: 'wheel', x: 0.5, y: 0.5, delta: 120 },
  ])
  assert.equal(pointer.menus, 0)
})

test('two-finger tap opens the menu while horizontal movement and cancellation do not', (t) => {
  const pointer = viewerPointer(t)
  pointer.emit('down', 1, 400, 300)
  pointer.emit('down', 2, 500, 300)
  pointer.emit('move', 1, 401, 301)
  pointer.emit('up', 2, 500, 300)
  pointer.emit('up', 1, 401, 301)
  assert.equal(pointer.menus, 1)

  pointer.emit('down', 1, 400, 300)
  pointer.emit('down', 2, 500, 300)
  pointer.emit('move', 1, 450, 300)
  pointer.emit('up', 1, 450, 300)
  pointer.emit('up', 2, 500, 300)
  assert.equal(pointer.menus, 1)

  pointer.emit('down', 1, 400, 300)
  pointer.emit('down', 2, 500, 300)
  pointer.emit('cancel', 1, 400, 300)
  pointer.emit('up', 2, 500, 300)
  assert.equal(pointer.menus, 1)
  assert.deepEqual(pointer.commands, [])
})

test('wheel motion in the letterbox is discarded and large movements have a single bounded update', (t) => {
  const pointer = viewerPointer(t, 1600, 900)
  pointer.emit('down', 1, 400, 10)
  pointer.emit('down', 2, 500, 10)
  pointer.emit('move', 1, 400, 40)
  pointer.emit('move', 2, 500, 40)
  pointer.frame()
  assert.equal(pointer.commands.length, 0)
  pointer.emit('move', 1, 400, 500)
  pointer.emit('move', 2, 500, 500)
  pointer.frame()
  pointer.frame()
  assert.equal(pointer.commands.length, 1)
  assert.equal(pointer.commands[0].action, 'wheel')
  assert.equal('delta' in pointer.commands[0] && pointer.commands[0].delta, 480)
})

test('disabling the pointer discards buffered movement and releases an active drag', (t) => {
  const pointer = viewerPointer(t)
  pointer.emit('down', 1, 450, 300)
  pointer.emit('up', 1, 450, 300)
  pointer.emit('down', 1, 450, 300)
  pointer.emit('move', 1, 450, 330)
  pointer.setEnabled(false)
  pointer.frame()
  pointer.emit('up', 1, 450, 330)
  assert.deepEqual(pointer.commands, [
    { action: 'down', x: 0.5, y: 0.5 },
    { action: 'up', x: 0.5, y: 0.5 },
    { action: 'down', x: 0.5, y: 0.5 },
    { action: 'cancel' },
  ])
})

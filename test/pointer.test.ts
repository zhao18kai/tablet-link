import assert from 'node:assert/strict'
import test from 'node:test'
import { displayPointerPosition, parsePointerCommand, videoPointerPosition } from '../src/pointer.ts'

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

import assert from 'node:assert/strict'
import test from 'node:test'
import { getDisplayRole, selectCaptureSource } from '../src/displays.ts'

test('only displays with a separate desktop origin qualify as extended screens', () => {
  const displays = [
    { id: 3, bounds: { x: 0, y: 0 } },
    { id: 4, bounds: { x: 0, y: 0 } },
    { id: 5, bounds: { x: -1920, y: 0 } },
    { id: 6, bounds: { x: 0, y: -1440 } },
  ]

  assert.equal(getDisplayRole('3', displays, 3), 'primary')
  assert.equal(getDisplayRole('4', displays, 3), 'mirror')
  assert.equal(getDisplayRole('5', displays, 3), 'extension')
  assert.equal(getDisplayRole('6', displays, 3), 'extension')
  assert.equal(getDisplayRole('', displays, 3), 'unknown')
  assert.equal(getDisplayRole('7', displays, 3), 'unknown')
})

test('a missing primary or stale screen ID cannot be used as an extension', () => {
  const displays = [{ id: 5, bounds: { x: 1920, y: 0 } }]

  assert.equal(getDisplayRole('5', displays, 3), 'unknown')
  assert.equal(getDisplayRole('3', displays, 5), 'unknown')
})

test('a removed display stays unselected across refreshes until a new selection is made', () => {
  const first = { id: 'screen:2:0', displayId: '11' }
  const other = { id: 'screen:2:0', displayId: '12' }
  const selection = selectCaptureSource([], first)

  assert.equal(selection, null)
  assert.equal(selectCaptureSource([other], selection), null)
  assert.equal(selectCaptureSource([other], other), other)
})

test('the selected screen is matched by display ID after Electron renumbers its source', () => {
  const previous = { id: 'screen:2:0', displayId: '11' }
  const newTarget = { id: 'screen:3:0', displayId: '11' }
  assert.equal(selectCaptureSource([newTarget], previous), newTarget)
})

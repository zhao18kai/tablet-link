import assert from 'node:assert/strict'
import test from 'node:test'
import { manageAutomaticDisplay } from '../src/automatic-display.ts'

test('a viewer that leaves during creation releases its display before the replacement starts', async () => {
  const events: string[] = []
  let finishCreation!: (display: number) => void
  const creating = new Promise<number>((resolve) => { finishCreation = resolve })
  let markStarted!: () => void
  const started = new Promise<void>((resolve) => { markStarted = resolve })
  let approved = 'first'
  const displays = manageAutomaticDisplay(async () => {
    events.push('create')
    markStarted()
    return events.length === 1 ? creating : 2
  }, async (display) => { events.push('release ' + display) })

  const first = displays.acquire('first', () => approved === 'first')
  await started
  assert.deepEqual(events, ['create'])
  approved = 'second'
  const departure = displays.release('first')
  const second = displays.acquire('second', () => approved === 'second')
  finishCreation(1)
  assert.equal(await first, undefined)
  await departure
  assert.equal(await second, 2)
  await displays.release('first')
  assert.deepEqual(events, ['create', 'release 1', 'create'])
  await displays.release('second')
  await displays.release()
  assert.deepEqual(events, ['create', 'release 1', 'create', 'release 2'])
})

test('approval is checked before creation and a failed creation allows another attempt', async () => {
  let attempts = 0
  const displays = manageAutomaticDisplay(async () => {
    if (++attempts === 1) throw new Error('display unavailable')
    return 'owned display'
  }, async () => {})
  assert.equal(await displays.acquire('unapproved', () => false), undefined)
  assert.equal(attempts, 0)
  await assert.rejects(displays.acquire('viewer', () => true), /display unavailable/)
  assert.equal(await displays.acquire('viewer', () => true), 'owned display')
})

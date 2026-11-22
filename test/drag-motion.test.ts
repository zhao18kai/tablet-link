import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'
import { createDragMotion } from '../src/drag-motion.ts'

function controller(t: TestContext, acceptPreference = true) {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const track = { contentHint: 'detail' }
  let preference: RTCRtpSendParameters['degradationPreference']
  let timestamp = 0
  let framesSent = 0
  const sender = {
    track: track as MediaStreamTrack,
    getParameters: () => ({ degradationPreference: preference }) as RTCRtpSendParameters,
    async setParameters(parameters: RTCRtpSendParameters) {
      if (acceptPreference) preference = parameters.degradationPreference
    },
    async getStats() {
      return new Map([
        ['screen', { type: 'media-source', frames: timestamp * .048 }],
        ['out', { type: 'outbound-rtp', kind: 'video', mediaSourceId: 'screen', timestamp, framesSent }],
      ]) as unknown as RTCStatsReport
    },
  }
  const motion = createDragMotion(sender)
  async function dragFor(milliseconds: number, sentFps: number) {
    await Promise.resolve()
    for (let elapsed = 0; elapsed < milliseconds; elapsed += 50) {
      timestamp += 50
      framesSent += sentFps / 20
      t.mock.timers.tick(50)
      await Promise.resolve()
      motion.input({ action: 'move', x: timestamp % 500 / 500, y: .4 })
    }
  }
  return { ...motion, dragFor, track, get preference() { return preference } }
}

test('slow delivery during a drag can switch to motion and successful trials keep it through release', async (t) => {
  const profile = controller(t)
  await profile.enable()
  assert.equal(profile.preference, 'maintain-resolution')

  profile.input({ action: 'down', x: .3, y: .4 })
  profile.input({ action: 'up', x: .3, y: .4 })
  profile.input({ action: 'wheel', x: .3, y: .4, delta: 120 })
  profile.input({ action: 'move', x: .5, y: .4 })
  assert.equal(profile.track.contentHint, 'detail')

  profile.input({ action: 'down', x: .3, y: .4 })
  profile.input({ action: 'move', x: .5, y: .4 })
  assert.equal(profile.track.contentHint, 'detail')
  await profile.dragFor(250, 18)
  assert.equal(profile.track.contentHint, 'motion')
  await profile.dragFor(750, 46)
  assert.equal(profile.track.contentHint, 'motion')
  profile.input({ action: 'up', x: .6, y: .4 })
  t.mock.timers.tick(249)
  assert.equal(profile.track.contentHint, 'motion')
  t.mock.timers.tick(1)
  assert.equal(profile.track.contentHint, 'detail')
})

test('healthy delivery keeps detail and an unsuccessful motion trial returns to detail', async (t) => {
  const profile = controller(t)
  await profile.enable()
  profile.input({ action: 'down', x: .2, y: .4 })
  profile.input({ action: 'move', x: .4, y: .4 })
  await profile.dragFor(500, 40)
  assert.equal(profile.track.contentHint, 'detail')
  await profile.dragFor(250, 18)
  assert.equal(profile.track.contentHint, 'motion')
  await profile.dragFor(750, 12)
  assert.equal(profile.track.contentHint, 'detail')
  await profile.dragFor(750, 12)
  assert.equal(profile.track.contentHint, 'detail')
})

test('motion returns to detail if delivery drops later in the same drag', async (t) => {
  const profile = controller(t)
  await profile.enable()
  profile.input({ action: 'down', x: .2, y: .4 })
  profile.input({ action: 'move', x: .4, y: .4 })
  await profile.dragFor(250, 18)
  await profile.dragFor(750, 45)
  assert.equal(profile.track.contentHint, 'motion')
  await profile.dragFor(750, 12)
  assert.equal(profile.track.contentHint, 'detail')
})

test('repeated stationary positions and disconnects restore detail', async (t) => {
  const profile = controller(t)
  await profile.enable()
  profile.input({ action: 'down', x: .2, y: .4 })
  profile.input({ action: 'move', x: .4, y: .4 })
  await profile.dragFor(250, 18)
  assert.equal(profile.track.contentHint, 'motion')
  t.mock.timers.tick(150)
  profile.input({ action: 'move', x: .5, y: .4 })
  t.mock.timers.tick(100)
  assert.equal(profile.track.contentHint, 'detail')

  profile.input({ action: 'move', x: .5, y: .6 })
  await profile.dragFor(250, 18)
  assert.equal(profile.track.contentHint, 'motion')
  profile.reset()
  assert.equal(profile.track.contentHint, 'detail')
  profile.input({ action: 'move', x: .8, y: .4 })
  t.mock.timers.tick(250)
  assert.equal(profile.track.contentHint, 'detail')
})

test('dragging keeps detail if the encoder cannot preserve resolution in motion mode', async (t) => {
  const profile = controller(t, false)
  await profile.enable()
  profile.input({ action: 'down', x: .2, y: .4 })
  profile.input({ action: 'move', x: .4, y: .4 })
  await profile.dragFor(500, 18)
  assert.equal(profile.track.contentHint, 'detail')
})

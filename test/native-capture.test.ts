import assert from 'node:assert/strict'
import test from 'node:test'
import { nativeCaptureTarget, nativeEncoderArgs, selectNativeFormat } from '../src/native-capture.ts'

test('native capture accepts a single matched DXGI adapter and output from the Windows helper', () => {
  assert.deepEqual(nativeCaptureTarget('0 5 2456 1600\r\n'), { adapter: 0, output: 5, width: 2456, height: 1600 })
  for (const invalid of ['0', '-1 2 1920 1080', '0 2 1920 1080\n1 2', '0 2 bad', '0 9007199254740992 1920 1080']) {
    assert.equal(nativeCaptureTarget(invalid), undefined)
  }
})

test('the encoder uses the explicitly matched adapter and output for 1080p60 video', () => {
  const target = { adapter: 1, output: 2, width: 1920, height: 1080 }
  const format = selectNativeFormat(target, 120, 1920, 60)
  assert.equal(format.fps, 60)
  const args = nativeEncoderArgs(target, format, 45100)
  assert.ok(args.includes('d3d11va=capture:1'))
  assert.ok(args.some((argument) => argument.includes('output_idx=2:framerate=60:dup_frames=0')))
  assert.ok(args.includes('h264_nvenc'))
  assert.equal(args[args.indexOf('-level:v') + 1], '4.2')
  assert.equal(args[args.indexOf('-b:v') + 1], '6M')
  assert.ok(args.at(-1)?.startsWith('rtp://127.0.0.1:45100?'))
})

test('native encoding follows the refresh rate and resolution of the selected Windows display', () => {
  for (const [width, height, hz, cap, fps, level] of [
    [1920, 1080, 119.88, 120, 120, '5.1'],
    [1920, 1080, 90, 120, 90, '5.1'],
    [2456, 1600, 59.94, 120, 60, '5.1'],
    [2456, 1600, 120, 120, 120, '5.2'],
    [2560, 1440, 120, 60, 60, '5.1'],
  ] as const) {
    const target = { adapter: 1, output: 2, width, height }
    const format = selectNativeFormat(target, hz, 2560, cap)
    assert.equal(format.fps, fps)
    const args = nativeEncoderArgs(target, format, 45100)
    assert.ok(args.includes(`ddagrab=output_idx=2:framerate=${fps}:dup_frames=0[screen]`))
    assert.equal(args[args.indexOf('-level:v') + 1], level)
    assert.equal(args[args.indexOf('-g') + 1], String(fps))
  }
})

test('native encoding rejects a source outside the chosen resolution cap or supported display modes', () => {
  assert.throws(() => selectNativeFormat({ width: 2456, height: 1600 }, 120, 1920, 120))
  assert.throws(() => selectNativeFormat({ width: 3840, height: 2160 }, 120, 2560, 120))
  assert.throws(() => selectNativeFormat({ width: 1920, height: 1081 }, 120, 1920, 120))
  assert.throws(() => selectNativeFormat({ width: 1920, height: 1080 }, 48, 1920, 120))
})

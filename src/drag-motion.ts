import type { PointerCommand } from './pointer.ts'

const detailDelayMs = 250
const sampleIntervalMs = 250
const trialDurationMs = 750

type FrameSample = { time: number; captured: number; sent: number }

export function createDragMotion(sender: Pick<RTCRtpSender, 'track' | 'getParameters' | 'setParameters' | 'getStats'>) {
  const track = sender.track
  let checked = false
  let enabled = false
  let lastPosition: { x: number; y: number } | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  let sampleTimer: ReturnType<typeof setTimeout> | undefined
  let dragRun = 0

  function useDetail() {
    if (track?.contentHint === 'motion') track.contentHint = 'detail'
  }

  function finishMotion() {
    clearTimeout(timer)
    timer = undefined
    clearTimeout(sampleTimer)
    dragRun++
    useDetail()
  }

  function reset() {
    lastPosition = undefined
    finishMotion()
  }

  async function observe(run: number, previous?: FrameSample, trial?: { start: FrameSample; detailFps: number }) {
    if (!track || run !== dragRun || !lastPosition) return
    try {
      const report = await sender.getStats()
      if (run !== dragRun || !lastPosition) return
      const outbound = [...report.values()].find((entry) => entry.type === 'outbound-rtp' && entry.kind === 'video')
      const source = outbound && report.get(outbound.mediaSourceId)
      if (!outbound || !Number.isFinite(outbound.framesSent) || !Number.isFinite(source?.frames)) {
        useDetail()
        return
      }
      const current = { time: outbound.timestamp, captured: source.frames, sent: outbound.framesSent }
      if (trial) {
        const duration = current.time - trial.start.time
        if (duration >= trialDurationMs) {
          const motionFps = (current.sent - trial.start.sent) * 1000 / duration
          if (motionFps < Math.max(24, trial.detailFps + 4)) {
            useDetail()
            return
          }
          trial = { ...trial, start: current }
        }
      } else if (previous && current.time > previous.time) {
        const seconds = (current.time - previous.time) / 1000
        const captured = (current.captured - previous.captured) / seconds
        const sent = (current.sent - previous.sent) / seconds
        if (captured >= 30 && sent >= 0 && sent < Math.min(28, captured * .7)) {
          trial = { start: current, detailFps: sent }
          track.contentHint = 'motion'
        }
      }
      sampleTimer = setTimeout(() => void observe(run, current, trial), sampleIntervalMs)
    } catch {
      if (run === dragRun) useDetail()
    }
  }

  return {
    async enable() {
      if (checked || !track || !('contentHint' in track)) return
      checked = true
      try {
        const parameters = sender.getParameters()
        parameters.degradationPreference = 'maintain-resolution'
        await sender.setParameters(parameters)
        enabled = sender.getParameters().degradationPreference === 'maintain-resolution'
      } catch {
        // Keep detail when the sender cannot protect resolution in motion mode.
      }
    },
    input(command: PointerCommand) {
      switch (command.action) {
        case 'cancel':
          reset()
          break
        case 'down':
          lastPosition ??= command
          break
        case 'move':
          if (!lastPosition || (lastPosition.x === command.x && lastPosition.y === command.y)) break
          lastPosition = command
          if (!enabled || !track) break
          if (timer === undefined) void observe(++dragRun)
          clearTimeout(timer)
          timer = setTimeout(finishMotion, detailDelayMs)
          break
        case 'up':
          lastPosition = undefined
          break
      }
    },
    reset,
  }
}

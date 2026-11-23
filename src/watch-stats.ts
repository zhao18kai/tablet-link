import type { ConnectionMode } from './wire.ts'

const historyDuration = 30_000

interface Sample {
  id: string
  time: number
  decoded: number
  received?: number
  presented?: number
  bytes?: number
  buffered?: number
  emitted?: number
}

function counterDelta(previous: number | undefined, current: number | undefined) {
  return previous !== undefined && current !== undefined && current >= previous ? current - previous : undefined
}

function displayFps(frames: number | undefined, seconds: number) {
  return (frames === undefined ? '—' : Math.round(frames / seconds)) + ' FPS'
}

function createFpsHistory(canvas: HTMLCanvasElement) {
  const points: { time: number; fps: number }[] = []
  const context = canvas.getContext('2d')

  function draw() {
    const width = canvas.clientWidth
    const height = canvas.clientHeight
    if (!context || !width || !height) return
    const density = Math.min(window.devicePixelRatio || 1, 2)
    const pixelWidth = Math.round(width * density)
    const pixelHeight = Math.round(height * density)
    if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
      canvas.width = pixelWidth
      canvas.height = pixelHeight
    }
    context.setTransform(pixelWidth / width, 0, 0, pixelHeight / height, 0, 0)
    context.clearRect(0, 0, width, height)
    context.beginPath()
    for (const level of [0.25, 0.5, 0.75]) {
      context.moveTo(0, height * level)
      context.lineTo(width, height * level)
    }
    context.strokeStyle = '#b2d4ca22'
    context.lineWidth = 1
    context.stroke()

    const latest = points.at(-1)
    if (!latest) return
    const maximum = Math.max(60, ...points.map(({ fps }) => fps))
    const plot = points.map(({ time, fps }) => ({
      x: width - 3 - (latest.time - time) / historyDuration * (width - 6),
      y: height - 3 - fps / maximum * (height - 6),
    }))
    const first = plot[0]
    const last = plot[plot.length - 1]
    context.beginPath()
    context.moveTo(first.x, first.y)
    for (const point of plot.slice(1)) context.lineTo(point.x, point.y)
    if (plot.length > 1) {
      context.lineTo(last.x, height)
      context.lineTo(first.x, height)
      context.closePath()
      const fill = context.createLinearGradient(0, 0, 0, height)
      fill.addColorStop(0, '#43db8c66')
      fill.addColorStop(1, '#43db8c12')
      context.fillStyle = fill
      context.fill()
      context.beginPath()
      context.moveTo(first.x, first.y)
      for (const point of plot.slice(1)) context.lineTo(point.x, point.y)
      context.strokeStyle = '#58e894'
      context.lineWidth = 1.5
      context.lineJoin = 'round'
      context.stroke()
    }
    context.beginPath()
    context.arc(last.x, last.y, 2, 0, Math.PI * 2)
    context.fillStyle = '#58e894'
    context.fill()
  }

  return {
    draw,
    append(time: number, fps: number) {
      points.push({ time, fps })
      while (points[0].time < time - historyDuration) points.shift()
      draw()
    },
    clear() {
      points.length = 0
    },
  }
}

export function createStreamStats(hud: HTMLElement, video: HTMLVideoElement) {
  const state = hud.querySelector<HTMLElement>('#stream-state')!
  const connection = hud.querySelector<HTMLElement>('#stream-connection')!
  const codec = hud.querySelector<HTMLElement>('#stream-codec')!
  const resolution = hud.querySelector<HTMLElement>('#stream-resolution')!
  const fps = hud.querySelector<HTMLElement>('#stream-fps')!
  const receivedFps = hud.querySelector<HTMLElement>('#stream-received-fps')!
  const presentedFps = hud.querySelector<HTMLElement>('#stream-presented-fps')!
  const bitrate = hud.querySelector<HTMLElement>('#stream-bitrate')!
  const roundTrip = hud.querySelector<HTMLElement>('#stream-rtt')!
  const bufferDelay = hud.querySelector<HTMLElement>('#stream-buffer-delay')!
  const history = createFpsHistory(hud.querySelector<HTMLCanvasElement>('#stream-history')!)
  let sample: Sample | undefined
  let frameCallback: number | undefined
  let presentedFrames: number | undefined

  function observePresentation() {
    if (frameCallback !== undefined || !video.requestVideoFrameCallback) return
    frameCallback = video.requestVideoFrameCallback((_time, frame) => {
      frameCallback = undefined
      presentedFrames = frame.presentedFrames
      if (!hud.hidden) observePresentation()
    })
  }

  function stopPresentation() {
    if (frameCallback !== undefined) video.cancelVideoFrameCallback?.(frameCallback)
    frameCallback = presentedFrames = undefined
    if (sample) sample.presented = undefined
    presentedFps.textContent = '— FPS'
  }

  function updateResolution() {
    const { videoWidth, videoHeight } = video
    resolution.textContent = videoWidth && videoHeight ? videoWidth + ' × ' + videoHeight : '— × —'
  }

  function setInterrupted(interrupted: boolean) {
    state.textContent = interrupted ? '连接暂中断' : '串流中'
    hud.dataset.state = interrupted ? 'interrupted' : 'active'
  }

  video.addEventListener('resize', updateResolution)
  window.addEventListener('resize', history.draw)

  return {
    setInterrupted,
    setVisible(visible: boolean) {
      hud.hidden = !visible
      if (!visible) {
        stopPresentation()
        return
      }
      observePresentation()
      updateResolution()
      history.draw()
    },
    reset() {
      hud.hidden = true
      setInterrupted(false)
      codec.hidden = true
      fps.textContent = '— FPS'
      receivedFps.textContent = '— FPS'
      stopPresentation()
      bitrate.textContent = '— Mb/s'
      roundTrip.textContent = '— ms'
      bufferDelay.textContent = '— ms'
      history.clear()
      sample = undefined
    },
    setConnection(mode: ConnectionMode | undefined) {
      connection.textContent = mode === 'usb' ? 'USB' : 'Wi-Fi / 局域网'
    },
    update(report: RTCStatsReport) {
      const inbound = [...report.values()].find((value) => value.type === 'inbound-rtp' && value.kind === 'video' &&
        Number.isFinite(value.framesDecoded) && Number.isFinite(value.timestamp))
      if (!inbound) return
      const current: Sample = {
        id: inbound.id,
        time: inbound.timestamp,
        decoded: inbound.framesDecoded,
        received: Number.isFinite(inbound.framesReceived) ? inbound.framesReceived : undefined,
        presented: presentedFrames,
        bytes: Number.isFinite(inbound.bytesReceived) ? inbound.bytesReceived : undefined,
        buffered: Number.isFinite(inbound.jitterBufferDelay) ? inbound.jitterBufferDelay : undefined,
        emitted: Number.isFinite(inbound.jitterBufferEmittedCount) ? inbound.jitterBufferEmittedCount : undefined,
      }
      const previous = sample
      if (previous?.id === current.id && current.time <= previous.time) return
      sample = current
      if (previous && previous.id === current.id && current.decoded >= previous.decoded) {
        const seconds = (current.time - previous.time) / 1000
        const presented = counterDelta(previous.presented, current.presented)
        fps.textContent = displayFps(current.decoded - previous.decoded, seconds)
        receivedFps.textContent = displayFps(counterDelta(previous.received, current.received), seconds)
        presentedFps.textContent = displayFps(presented, seconds)
        if (presented !== undefined) history.append(current.time, Math.round(presented / seconds))
        const buffered = counterDelta(previous.buffered, current.buffered)
        const emitted = counterDelta(previous.emitted, current.emitted)
        bufferDelay.textContent = emitted && buffered !== undefined ? Math.round(buffered * 1000 / emitted) + ' ms' : '— ms'
        if (current.bytes !== undefined && previous.bytes !== undefined && current.bytes >= previous.bytes) {
          bitrate.textContent = ((current.bytes - previous.bytes) * 8 / seconds / 1_000_000).toFixed(1) + ' Mb/s'
        } else bitrate.textContent = '— Mb/s'
      } else {
        fps.textContent = '— FPS'
        receivedFps.textContent = '— FPS'
        presentedFps.textContent = '— FPS'
        bitrate.textContent = '— Mb/s'
        bufferDelay.textContent = '— ms'
        history.clear()
        history.draw()
      }
      const codecName = report.get(inbound.codecId)?.mimeType?.split('/')[1] as string | undefined
      codec.hidden = !codecName
      if (codecName) codec.textContent = codecName.toUpperCase().replace(/^H26/, 'H.26')
      const pairId = report.get(inbound.transportId)?.selectedCandidatePairId
      const seconds = pairId && report.get(pairId)?.currentRoundTripTime
      roundTrip.textContent = Number.isFinite(seconds) && seconds >= 0 ? Math.round(seconds * 1000) + ' ms' : '— ms'
    },
  }
}

import type { DisplayOrientation } from './wire.ts'

const maxHoldMs = 3500
const completeFrameSettleMs = 100
const sampleSize = 24
const edges = ['left', 'right', 'top', 'bottom'] as const

function matchesOrientation(width: number, height: number, direction: DisplayOrientation) {
  return width > 0 && height > 0 && (direction === 'portrait' ? height > width : width > height)
}

function hasBlackEdge(video: HTMLVideoElement, sample: CanvasRenderingContext2D | null) {
  if (!sample) return false
  let pixels: Uint8ClampedArray
  try {
    sample.drawImage(video, 0, 0, sampleSize, sampleSize)
    pixels = sample.getImageData(0, 0, sampleSize, sampleSize).data
  } catch {
    return false
  }
  const black = (x: number, y: number) => {
    const index = (y * sampleSize + x) * 4
    return Math.max(pixels[index], pixels[index + 1], pixels[index + 2]) <= 22
  }
  return edges.some((edge) => {
    const near = edge === 'left' || edge === 'top' ? 1 : sampleSize - 2
    const vertical = edge === 'left' || edge === 'right'
    let count = 0
    for (let i = 3; i < sampleSize - 3; i++) count += Number(vertical ? black(near, i) : black(i, near))
    return count >= sampleSize - 7
  })
}

export function createRotationTransition(video: HTMLVideoElement, overlay: HTMLCanvasElement, onWaitingChange: (waiting: boolean) => void) {
  const hasVideoFrameCallback = typeof video.requestVideoFrameCallback === 'function'
  const probe = document.createElement('canvas')
  probe.width = probe.height = sampleSize
  const sample = probe.getContext('2d', { willReadFrequently: true })
  let direction: DisplayOrientation | undefined
  let timeout: number | undefined
  let completeFrameTimeout: number | undefined
  let videoCallback: number | undefined
  let paintCallback: number | undefined

  function stopWatchingFrames() {
    window.clearTimeout(completeFrameTimeout)
    if (videoCallback !== undefined) video.cancelVideoFrameCallback?.(videoCallback)
    if (paintCallback !== undefined) window.cancelAnimationFrame(paintCallback)
    videoCallback = paintCallback = completeFrameTimeout = undefined
  }

  function clear() {
    if (!direction) return
    direction = undefined
    window.clearTimeout(timeout)
    stopWatchingFrames()
    overlay.hidden = true
    overlay.width = overlay.height = 0
    onWaitingChange(false)
  }

  function watchFrame(onFrame: (width: number, height: number) => void) {
    if (hasVideoFrameCallback) {
      videoCallback = video.requestVideoFrameCallback((_, frame) => {
        videoCallback = undefined
        onFrame(frame.width, frame.height)
      })
    } else {
      paintCallback = window.requestAnimationFrame(() => {
        paintCallback = undefined
        onFrame(video.videoWidth, video.videoHeight)
      })
    }
  }

  return {
    get waiting() { return direction !== undefined },
    start(next: DisplayOrientation) {
      if (direction === next) return
      const wasWaiting = direction !== undefined
      const { videoWidth, videoHeight } = video
      const previous = next === 'portrait' ? 'landscape' : 'portrait'
      const context = overlay.getContext('2d')
      if (!context) return

      const drawOutgoingFrame = () => {
        try {
          context.drawImage(video, 0, 0)
          return true
        } catch {
          return false
        }
      }
      if (wasWaiting) {
        window.clearTimeout(timeout)
        stopWatchingFrames()
      } else {
        if (video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA ||
            !matchesOrientation(videoWidth, videoHeight, previous)) return
        // Keep the complete frame at its natural size and let CSS fit it into the viewport.
        overlay.width = videoWidth
        overlay.height = videoHeight
        if (!drawOutgoingFrame()) {
          overlay.width = overlay.height = 0
          return
        }
      }

      let lastVideoTime = video.currentTime

      function updateFrame(width: number, height: number) {
        if (direction !== next) return
        const targetFrame = matchesOrientation(width, height, next) && matchesOrientation(video.videoWidth, video.videoHeight, next)
        if (targetFrame && !hasBlackEdge(video, sample)) {
          completeFrameTimeout ??= window.setTimeout(() => {
            completeFrameTimeout = undefined
            if (direction === next && matchesOrientation(video.videoWidth, video.videoHeight, next) && !hasBlackEdge(video, sample)) clear()
          }, completeFrameSettleMs)
        } else {
          window.clearTimeout(completeFrameTimeout)
          completeFrameTimeout = undefined
          if ((hasVideoFrameCallback || video.currentTime !== lastVideoTime) &&
              width === overlay.width && height === overlay.height && width === video.videoWidth && height === video.videoHeight &&
              matchesOrientation(width, height, previous) && !hasBlackEdge(video, sample)) {
            drawOutgoingFrame()
            lastVideoTime = video.currentTime
          }
        }
        if (direction === next) watchFrame(updateFrame)
      }

      direction = next
      overlay.hidden = false
      timeout = window.setTimeout(clear, maxHoldMs)
      watchFrame(updateFrame)
      if (!wasWaiting) onWaitingChange(true)
    },
    clear,
  }
}

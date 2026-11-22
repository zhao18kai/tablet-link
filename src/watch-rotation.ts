import type { DisplayOrientation } from './wire.ts'

const maxHoldMs = 1800
const fadeMs = 90

function matchesOrientation(width: number, height: number, direction: DisplayOrientation) {
  return width > 0 && height > 0 && (height > width) === (direction === 'portrait')
}

export function createRotationTransition(video: HTMLVideoElement, overlay: HTMLCanvasElement, onWaitingChange: (waiting: boolean) => void) {
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)')
  let direction: DisplayOrientation | undefined
  let timeout: number | undefined
  let videoCallback: number | undefined
  let paintCallback: number | undefined
  let fade: Animation | undefined

  function clear() {
    if (!direction) return
    direction = undefined
    window.clearTimeout(timeout)
    if (videoCallback !== undefined) video.cancelVideoFrameCallback?.(videoCallback)
    if (paintCallback !== undefined) window.cancelAnimationFrame(paintCallback)
    videoCallback = paintCallback = undefined
    overlay.hidden = true
    overlay.width = overlay.height = 0
    const previousFade = fade
    fade = undefined
    previousFade?.cancel()
    onWaitingChange(false)
  }

  function reveal() {
    if (reducedMotion.matches || typeof overlay.animate !== 'function') {
      clear()
      return
    }
    const animation = overlay.animate([{ opacity: 1 }, { opacity: 0 }], { duration: fadeMs, fill: 'forwards' })
    fade = animation
    const finished = () => { if (fade === animation) clear() }
    void animation.finished.then(finished, finished)
  }

  function waitForPresentation() {
    if (!direction || fade || videoCallback !== undefined || paintCallback !== undefined ||
        !matchesOrientation(video.videoWidth, video.videoHeight, direction)) return
    if (typeof video.requestVideoFrameCallback === 'function') {
      videoCallback = video.requestVideoFrameCallback((_, frame) => {
        videoCallback = undefined
        if (direction && matchesOrientation(frame.width, frame.height, direction)) reveal()
        else waitForPresentation()
      })
    } else {
      paintCallback = window.requestAnimationFrame(() => {
        paintCallback = undefined
        if (direction && matchesOrientation(video.videoWidth, video.videoHeight, direction)) reveal()
      })
    }
  }

  video.addEventListener('resize', waitForPresentation)

  return {
    get waiting() { return direction !== undefined },
    start(next: DisplayOrientation) {
      if (direction === next) return
      clear()
      const { videoWidth, videoHeight } = video
      if (video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA || !videoWidth || !videoHeight ||
          matchesOrientation(videoWidth, videoHeight, next)) return
      const context = overlay.getContext('2d')
      if (!context) return
      overlay.width = videoWidth
      overlay.height = videoHeight
      try {
        context.drawImage(video, 0, 0)
      } catch {
        overlay.width = overlay.height = 0
        return
      }
      direction = next
      overlay.hidden = false
      timeout = window.setTimeout(clear, maxHoldMs)
      onWaitingChange(true)
    },
    clear,
  }
}

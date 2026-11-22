import { videoPointerPosition, type PointerCommand } from './pointer.ts'

export function createViewerPointer(
  area: HTMLElement,
  video: HTMLVideoElement,
  send: (command: PointerCommand) => void,
  toggleMenu: () => void,
) {
  let enabled = false
  const fingers = new Set<number>()
  let menuGesture = false
  let stroke: { id: number; initial: PointerEvent; point: { x: number; y: number }; last: { x: number; y: number }; dragging: boolean } | undefined
  let queued: PointerCommand | undefined
  let frame = 0

  function position(event: PointerEvent, clamp = false) {
    return videoPointerPosition(video.getBoundingClientRect(), video.videoWidth, video.videoHeight,
      video.classList.contains('video-cover'), event.clientX, event.clientY, clamp)
  }

  function clearMove() {
    window.cancelAnimationFrame(frame)
    frame = 0
    queued = undefined
  }

  function cancelStroke() {
    clearMove()
    if (stroke?.dragging) send({ action: 'cancel' })
    stroke = undefined
  }

  area.addEventListener('pointerdown', (event) => {
    if (!enabled || event.button !== 0 || stroke?.dragging || (fingers.size && event.pointerType !== 'touch')) return
    event.preventDefault()
    area.setPointerCapture(event.pointerId)
    fingers.add(event.pointerId)
    if (fingers.size > 1) {
      menuGesture = true
      cancelStroke()
      return
    }
    const point = position(event)
    if (point) stroke = { id: event.pointerId, initial: event, point, last: point, dragging: false }
  })

  area.addEventListener('pointermove', (event) => {
    if (stroke?.id !== event.pointerId) return
    if (!stroke.dragging) {
      if (Math.hypot(event.clientX - stroke.initial.clientX, event.clientY - stroke.initial.clientY) < 5) return
      stroke.dragging = true
      send({ action: 'down', ...stroke.point })
    }
    const point = position(event, true)
    if (point) {
      stroke.last = point
      queued = { action: 'move', ...point }
      if (!frame) frame = window.requestAnimationFrame(() => {
        if (queued) send(queued)
        frame = 0
        queued = undefined
      })
    }
  })

  area.addEventListener('pointerup', (event) => {
    if (!fingers.delete(event.pointerId)) return
    if (menuGesture) {
      if (!fingers.size) {
        menuGesture = false
        toggleMenu()
      }
      return
    }
    if (stroke?.id !== event.pointerId) return
    const point = position(event, stroke.dragging)
    if (!point) {
      cancelStroke()
      return
    }
    clearMove()
    if (!stroke.dragging) send({ action: 'down', ...point })
    send({ action: 'up', ...point })
    stroke = undefined
  })

  function cancelPointer(event: PointerEvent) {
    if (!fingers.delete(event.pointerId)) return
    if (stroke?.id === event.pointerId) cancelStroke()
    if (!fingers.size) menuGesture = false
  }

  area.addEventListener('pointercancel', cancelPointer)
  area.addEventListener('lostpointercapture', cancelPointer)
  window.setInterval(() => {
    if (stroke?.dragging && !queued) send({ action: 'move', ...stroke.last })
  }, 500)

  return {
    setEnabled(value: boolean) {
      enabled = value
      if (!enabled) {
        cancelStroke()
        fingers.clear()
        menuGesture = false
      }
      area.classList.toggle('touch-enabled', enabled)
    },
  }
}

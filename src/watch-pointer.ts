import { maxPointerWheelDelta, videoPointerPosition, type PointerCommand } from './pointer.ts'

const tapSlop = 8
const pixelsPerWheelNotch = 24
const wheelNotch = 120

type ClientPoint = Pick<PointerEvent, 'clientX' | 'clientY'>

function midpoint(a: ClientPoint, b: ClientPoint): ClientPoint {
  return { clientX: (a.clientX + b.clientX) / 2, clientY: (a.clientY + b.clientY) / 2 }
}

export function createViewerPointer(
  area: HTMLElement,
  video: HTMLVideoElement,
  send: (command: PointerCommand) => void,
  toggleMenu: () => void,
) {
  let enabled = false
  const fingers = new Map<number, { initial: PointerEvent; last: ClientPoint }>()
  let gesture: { active: boolean; tap: boolean; lastY: number; distance: number } | undefined
  let stroke: { id: number; initial: PointerEvent; point: { x: number; y: number }; last: { x: number; y: number }; dragging: boolean } | undefined
  let queued: PointerCommand | undefined
  let frame = 0

  function position(point: ClientPoint, clamp = false) {
    return videoPointerPosition(video.getBoundingClientRect(), video.videoWidth, video.videoHeight,
      video.classList.contains('video-cover'), point.clientX, point.clientY, clamp)
  }

  function clearMove() {
    window.cancelAnimationFrame(frame)
    frame = 0
    queued = undefined
  }

  function flushMove() {
    const command = queued
    clearMove()
    if (command) send(command)
  }

  function queueMove(command: PointerCommand) {
    queued = command
    if (!frame) frame = window.requestAnimationFrame(flushMove)
  }

  function cancelStroke() {
    clearMove()
    if (stroke?.dragging) send({ action: 'cancel' })
    stroke = undefined
  }

  function trackGesture(event: PointerEvent) {
    const finger = fingers.get(event.pointerId)
    if (!finger || !gesture) return
    finger.last = event
    if (Math.hypot(event.clientX - finger.initial.clientX, event.clientY - finger.initial.clientY) >= tapSlop) {
      gesture.tap = false
    }
    if (!gesture.active) return
    const [first, second] = fingers.values()
    const center = midpoint(first.last, second.last)
    gesture.distance += center.clientY - gesture.lastY
    gesture.lastY = center.clientY
    const point = position(center)
    if (!point) {
      gesture.distance = 0
      return
    }
    const notches = Math.trunc(gesture.distance / pixelsPerWheelNotch)
    if (!notches) return
    gesture.distance %= pixelsPerWheelNotch
    const pending = queued?.action === 'wheel' ? queued.delta : 0
    const delta = Math.max(-maxPointerWheelDelta, Math.min(maxPointerWheelDelta, pending + notches * wheelNotch))
    if (delta) queueMove({ action: 'wheel', ...point, delta })
    else clearMove()
  }

  area.addEventListener('pointerdown', (event) => {
    if (!enabled || event.button !== 0 || stroke?.dragging) return
    const first = fingers.values().next().value
    if (first && (event.pointerType !== 'touch' || first.initial.pointerType !== 'touch')) return
    event.preventDefault()
    area.setPointerCapture(event.pointerId)
    fingers.set(event.pointerId, { initial: event, last: event })
    if (gesture) {
      gesture.active = false
      gesture.tap = false
      clearMove()
      return
    }
    if (first) {
      gesture = { active: true, tap: true, lastY: midpoint(first.last, event).clientY, distance: 0 }
      cancelStroke()
      return
    }
    const point = position(event)
    if (point) stroke = { id: event.pointerId, initial: event, point, last: point, dragging: false }
  })

  area.addEventListener('pointermove', (event) => {
    if (gesture) {
      trackGesture(event)
      return
    }
    const finger = fingers.get(event.pointerId)
    if (finger) finger.last = event
    if (stroke?.id !== event.pointerId) return
    if (!stroke.dragging) {
      if (Math.hypot(event.clientX - stroke.initial.clientX, event.clientY - stroke.initial.clientY) < 5) return
      stroke.dragging = true
      send({ action: 'down', ...stroke.point })
    }
    const point = position(event, true)
    if (point) {
      stroke.last = point
      queueMove({ action: 'move', ...point })
    }
  })

  area.addEventListener('pointerup', (event) => {
    if (!fingers.has(event.pointerId)) return
    if (gesture) {
      trackGesture(event)
      fingers.delete(event.pointerId)
      gesture.active = false
      flushMove()
      if (!fingers.size) {
        const tap = gesture.tap
        gesture = undefined
        if (tap) toggleMenu()
      }
      return
    }
    fingers.delete(event.pointerId)
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
    if (gesture) {
      clearMove()
      gesture.active = false
      gesture.tap = false
      if (!fingers.size) gesture = undefined
    }
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
        gesture = undefined
      }
      area.classList.toggle('touch-enabled', enabled)
    },
  }
}

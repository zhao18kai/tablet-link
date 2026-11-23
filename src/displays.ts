import { AUTOMATIC_DISPLAY, type CaptureMode, type CaptureSource } from './wire.ts'

interface DisplayPosition {
  id: number
  bounds: { x: number; y: number }
}

export type DisplayRole = 'primary' | 'extension' | 'mirror' | 'unknown'
export type DisplaySide = 'left' | 'right' | 'above' | 'below'

interface DisplayRect extends DisplayPosition {
  bounds: DisplayPosition['bounds'] & { width: number; height: number }
}

export function matchesPhysicalBounds(
  native: DisplayRect['bounds'], electron: DisplayRect['bounds'], scaleFactor: number,
) {
  // Both DPI conversions enclose their input rectangles, so either edge can move by a few pixels.
  const tolerance = Math.ceil(scaleFactor) + 1
  return Math.abs(native.x - electron.x) <= tolerance && Math.abs(native.y - electron.y) <= tolerance &&
    Math.abs(native.x + native.width - electron.x - electron.width) <= tolerance &&
    Math.abs(native.y + native.height - electron.y - electron.height) <= tolerance
}

export function getDisplayPlacement(
  displays: readonly DisplayRect[], target: DisplayRect, reference: DisplayRect, side: DisplaySide,
) {
  const { width, height } = target.bounds
  const anchor = reference.bounds
  const x = side === 'left' ? anchor.x - width : side === 'right' ? anchor.x + anchor.width : anchor.x
  const y = side === 'above' ? anchor.y - height : side === 'below' ? anchor.y + anchor.height : anchor.y
  const occupied = displays.some(({ id, bounds: other }) => id !== target.id &&
    x < other.x + other.width && x + width > other.x && y < other.y + other.height && y + height > other.y)
  return occupied ? undefined : { x, y }
}

export function getDisplayRole(id: string, displays: readonly DisplayPosition[], primaryId: number): DisplayRole {
  const display = displays.find((candidate) => String(candidate.id) === id)
  const primary = displays.find((candidate) => candidate.id === primaryId)
  if (!display || !primary) return 'unknown'
  if (display.id === primary.id) return 'primary'
  if (display.bounds.x === primary.bounds.x && display.bounds.y === primary.bounds.y) return 'mirror'
  return 'extension'
}

export function selectCaptureSource<Source extends Pick<CaptureSource, 'id' | 'displayId' | 'role' | 'canRotate'>>(
  sources: readonly Source[],
  previous: Source | null | undefined,
  mode: CaptureMode = 'screen',
  automaticAvailable = false,
): Source | null | undefined {
  // Preserve a manual choice across refreshes, including when its display disappears.
  if (previous === null) return null
  if (previous) {
    return sources.find((source) => previous.displayId ? source.displayId === previous.displayId : source.id === previous.id) ?? null
  }
  if (mode === 'screen') return sources.find(({ role }) => role === 'primary') ?? sources[0]

  const active = sources.filter(({ id }) => id !== AUTOMATIC_DISPLAY)
  const automatic = automaticAvailable ? sources.find(({ id }) => id === AUTOMATIC_DISPLAY) : undefined
  return active.find(({ canRotate }) => canRotate) ?? automatic ?? active[0]
}

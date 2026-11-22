interface DisplayPosition {
  id: number
  bounds: { x: number; y: number }
}

export type DisplayRole = 'primary' | 'extension' | 'mirror' | 'unknown'
export type DisplaySide = 'left' | 'right' | 'above' | 'below'

interface DisplayRect extends DisplayPosition {
  bounds: DisplayPosition['bounds'] & { width: number; height: number }
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

export function selectCaptureSource<Source extends { id: string; displayId: string }>(
  sources: readonly Source[],
  previous: Source | null | undefined,
): Source | null | undefined {
  // undefined allows the initial default. null means the user needs to choose again.
  if (previous === null) return null
  if (!previous) return sources[0]
  return sources.find((source) => previous.displayId ? source.displayId === previous.displayId : source.id === previous.id) ?? null
}

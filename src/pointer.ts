type Point = { x: number; y: number }

export type PointerCommand = ({ action: 'down' | 'move' | 'up' } & Point) | { action: 'cancel' }

export function parsePointerCommand(raw: unknown): PointerCommand | undefined {
  if (typeof raw !== 'string' || raw.length > 160) return
  try {
    const value = JSON.parse(raw) as { action?: string; x?: number; y?: number } | null
    if (value?.action === 'cancel') return { action: 'cancel' }
    if (value?.action !== 'down' && value?.action !== 'move' && value?.action !== 'up') return
    const { x, y, action } = value
    if (typeof x === 'number' && x >= 0 && x <= 1 && typeof y === 'number' && y >= 0 && y <= 1) {
      return { action, x, y }
    }
  } catch {
    // Invalid messages do not reach the Windows input process.
  }
}

export function videoPointerPosition(
  rect: { left: number; top: number; width: number; height: number },
  sourceWidth: number,
  sourceHeight: number,
  cover: boolean,
  clientX: number,
  clientY: number,
  clamp = false,
): Point | undefined {
  if (!rect.width || !rect.height || !sourceWidth || !sourceHeight) return
  const scale = (cover ? Math.max : Math.min)(rect.width / sourceWidth, rect.height / sourceHeight)
  const width = sourceWidth * scale
  const height = sourceHeight * scale
  const x = (clientX - rect.left - (rect.width - width) / 2) / width
  const y = (clientY - rect.top - (rect.height - height) / 2) / height
  if (clamp) return { x: Math.max(0, Math.min(1, x)), y: Math.max(0, Math.min(1, y)) }
  if (x >= 0 && x <= 1 && y >= 0 && y <= 1) return { x, y }
}

export function displayPointerPosition(bounds: Point & { width: number; height: number }, point: Point): Point {
  return {
    x: bounds.x + Math.round(point.x * (bounds.width - 1)),
    y: bounds.y + Math.round(point.y * (bounds.height - 1)),
  }
}

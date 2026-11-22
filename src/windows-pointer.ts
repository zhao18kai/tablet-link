import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { createInterface } from 'node:readline'
import type { PointerCommand } from './pointer.ts'

export async function openWindowsPointer(
  executable: string,
  locate: (position: { x: number; y: number }) => {
    point: { x: number; y: number }
    bounds: { x: number; y: number; width: number; height: number }
  } | undefined,
) {
  const helper = spawn(executable, { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true })
  const sink = helper.stdin
  const pending: string[] = []
  let awaiting = false
  let closing = false
  const stopped = new Promise<void>((resolve) => { helper.once('close', () => resolve()) })
  function flush() {
    if (closing || awaiting || !sink.writable || !pending.length) return
    awaiting = true
    sink.write(`${pending.shift()}\n`)
  }
  function cancel() {
    pending.splice(0, pending.length, 'cancel')
    flush()
  }
  createInterface({ input: helper.stdout }).on('line', () => {
    awaiting = false
    flush()
  })
  sink.on('error', () => sink.destroy())
  helper.on('error', () => sink.destroy())
  await once(helper, 'spawn')

  return {
    send(command: PointerCommand) {
      if (closing || !sink.writable) return
      if (command.action === 'cancel') {
        cancel()
        return
      }
      const destination = locate(command)
      if (!destination) {
        cancel()
        return
      }
      const { point, bounds } = destination
      const message = `${command.action} ${point.x} ${point.y} ${bounds.x} ${bounds.y} ${bounds.x + bounds.width} ${bounds.y + bounds.height}`
      if (command.action === 'move' && pending.at(-1)?.startsWith('move ')) pending[pending.length - 1] = message
      else if (pending.length >= 8) cancel()
      else pending.push(message)
      flush()
    },
    async close() {
      if (closing) return stopped
      closing = true
      pending.length = 0
      if (sink.writable) sink.end('cancel\n')
      await stopped
    },
  }
}

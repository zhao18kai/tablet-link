import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'

export interface WindowsDisplaySession {
  bounds: { x: number; y: number; width: number; height: number }
  markAlreadyDetached(): void
  close(): Promise<void>
}

export async function openWindowsDisplay(executable: string): Promise<WindowsDisplaySession> {
  const helper = spawn(executable, ['--lease-display'], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
  const output = createInterface({ input: helper.stdout })
  let rejectReady!: (error: Error) => void
  let alreadyDetached = false
  helper.stdin.on('error', () => {})
  helper.stderr.resume()
  const ready = new Promise<WindowsDisplaySession['bounds']>((resolve, reject) => {
    rejectReady = reject
    helper.once('error', reject)
    output.on('line', (line) => {
      const match = /^READY (-?\d+) (-?\d+) (\d+) (\d+)$/.exec(line)
      if (match) {
        const [, x, y, width, height] = match.map(Number)
        resolve({ x, y, width, height })
      }
    })
  })
  const exited = new Promise<number | null>((resolve) => {
    helper.once('close', (code) => {
      output.close()
      rejectReady(new Error(code === 10
        ? '没有可用的备用虚拟屏。请在 Windows 显示设置中断开一块 VDD by MTT 虚拟屏，或选择现有屏幕。'
        : 'Windows 无法创建自动副屏。请确认虚拟显示驱动已启用并重试。'))
      resolve(code)
    })
  })

  async function close() {
    if (helper.stdin.writable) helper.stdin.end(alreadyDetached ? 'DETACHED\n' : undefined)
    const deadline = setTimeout(() => helper.kill(), 5000)
    try {
      const exit = await exited
      if (exit === 12 || exit === null) throw new Error('Windows 未能确认自动副屏已回收。请检查 Windows 显示设置。')
    } finally {
      clearTimeout(deadline)
    }
  }

  const deadline = setTimeout(() => rejectReady(new Error('等待 Windows 创建副屏超时。')), 8000)
  try {
    return { bounds: await ready, close, markAlreadyDetached: () => { alreadyDetached = true } }
  } catch (error) {
    await close()
    throw error
  } finally {
    clearTimeout(deadline)
  }
}

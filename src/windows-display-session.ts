import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'

export interface WindowsDisplaySession {
  bounds: { x: number; y: number; width: number; height: number }
  markAlreadyDetached(): void
  close(): Promise<void>
}

function displayError(code: number | null) {
  switch (code) {
    case 10:
      return new Error('没有可用的备用虚拟屏。请在 Windows 显示设置中断开一块 VDD by MTT 虚拟屏，或选择现有屏幕。')
    case 13:
      return new Error('未检测到 VDD by MTT 虚拟屏。请安装或启用 VDD 驱动并添加虚拟屏，或选择现有屏幕。')
    default:
      return new Error('Windows 无法准备自动副屏。请确认虚拟显示驱动已启用并重试。')
  }
}

export function checkWindowsDisplay(executable: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const probe = spawn(executable, ['--probe-display'], { windowsHide: true, stdio: 'ignore', timeout: 5000 })
    probe.once('error', () => reject(displayError(null)))
    probe.once('close', (code) => {
      if (code === 0) resolve()
      else reject(displayError(code))
    })
  })
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
      rejectReady(displayError(code))
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

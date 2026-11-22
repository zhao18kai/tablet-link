import { createHash, randomBytes } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { hostname } from 'node:os'
import { join } from 'node:path'

export async function loadRememberedComputer(directory: string) {
  const file = join(directory, 'lan-reconnect-token')
  let token: string
  try {
    token = (await readFile(file, 'utf8')).trim()
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    token = randomBytes(24).toString('base64url')
    try {
      await writeFile(file, token, { flag: 'wx', mode: 0o600 })
    } catch (writeError) {
      if ((writeError as NodeJS.ErrnoException).code !== 'EEXIST') throw writeError
      token = (await readFile(file, 'utf8')).trim()
    }
  }
  if (!/^[\w-]{32}$/.test(token)) throw new Error('Invalid LAN reconnect token')
  const id = createHash('sha256').update(token).digest('hex').slice(0, 32)
  return { id, name: hostname().trim().slice(0, 64) || 'Windows 电脑', token }
}

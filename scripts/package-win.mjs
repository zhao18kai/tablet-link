import { cp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

if (process.platform !== 'win32') throw new Error('Run this command on a Windows build machine.')

const require = createRequire(import.meta.url)
const executable = require('electron')
const runtime = dirname(executable)
const output = join('release', `Tablet-Link-win32-${process.arch}`)
const defaultApp = join(runtime, 'resources', 'default_app.asar')
const app = join(output, 'resources', 'app')
const { name, productName, version, main } = JSON.parse(await readFile('package.json', 'utf8'))

await cp(runtime, output, {
  recursive: true,
  filter: (path) => path !== executable && path !== defaultApp,
})
await mkdir(app, { recursive: true })
await Promise.all([
  cp(executable, join(output, 'Tablet-Link.exe')),
  cp('dist', join(app, 'dist'), { recursive: true }),
  writeFile(join(app, 'package.json'), JSON.stringify({ name, productName, version, main }, null, 2)),
])

console.log(`Ready to run: ${join(output, 'Tablet-Link.exe')}`)

import { execFile } from 'node:child_process'
import { cp, mkdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { build } from 'esbuild'

await mkdir('dist', { recursive: true })
await Promise.all([
  process.platform === 'win32' && promisify(execFile)(
    join(process.env.SystemRoot, 'Microsoft.NET', 'Framework', 'v4.0.30319', 'csc.exe'),
    ['/nologo', '/target:exe', '/optimize+', `/out:${resolve('dist', 'tablet-pointer.exe')}`,
      resolve('src', 'windows', 'TabletPointer.cs'), resolve('src', 'windows', 'VirtualDisplay.cs'),
      resolve('src', 'windows', 'DisplayLease.cs')],
    { windowsHide: true },
  ),
  build({
    entryPoints: { main: 'src/main.ts', preload: 'src/preload.ts' },
    outdir: 'dist',
    outExtension: { '.js': '.cjs' },
    bundle: true,
    external: ['electron'],
    platform: 'node',
    target: 'node24',
    format: 'cjs',
  }),
  build({
    entryPoints: { host: 'src/host.ts', watch: 'src/watch.ts' },
    outdir: 'dist',
    bundle: true,
    target: 'es2020',
    format: 'iife',
  }),
  cp('src/ui', 'dist', { recursive: true }),
])

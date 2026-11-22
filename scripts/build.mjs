import { cp, mkdir } from 'node:fs/promises'
import { build } from 'esbuild'

await mkdir('dist', { recursive: true })
await Promise.all([
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

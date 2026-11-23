import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cp, mkdir, mkdtemp, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'

const driverAssets = {
  x64: { id: 275640574, sha256: 'e24210692b442b39af763536330ce78b423f19342b7a7792c26de3944e418b3a', windows: 'x64os' },
  arm64: { id: 275640571, sha256: 'dcd487161469c726bab60f174a7e7f70ee02afd437cad0d5c0e6755953de5a25', windows: 'arm64' },
}
const driver = driverAssets[process.arch]
if (process.platform !== 'win32' || !driver) throw new Error('Run this command on x64 or ARM64 Windows with matching Node.js.')

async function findCompiler() {
  if (process.env.ISCC_PATH) return process.env.ISCC_PATH
  const roots = [process.env['ProgramFiles(x86)'], process.env.ProgramFiles]
  if (process.env.LOCALAPPDATA) roots.push(join(process.env.LOCALAPPDATA, 'Programs'))
  for (const root of roots.filter(Boolean)) {
    const file = join(root, 'Inno Setup 6', 'ISCC.exe')
    if (await stat(file).then((entry) => entry.isFile(), () => false)) return file
  }
  return 'ISCC.exe'
}

const vddRepository = 'VirtualDrivers/Virtual-Display-Driver'
const nefconRepository = 'nefarius/nefcon'
const release = resolve('release')
const payload = join(release, '.installer-vdd', process.arch)
const driverFolder = join(payload, 'VirtualDisplayDriver')
const { version } = JSON.parse(await readFile('package.json', 'utf8'))
const compiler = await findCompiler()
await mkdir(payload, { recursive: true })

async function extractRelease(repository, asset, sha256, name) {
  const archive = join(payload, name)
  const hash = (bytes) => createHash('sha256').update(bytes).digest('hex')
  const cached = await readFile(archive).catch((error) => {
    if (error.code !== 'ENOENT') throw error
  })
  if (!cached || hash(cached) !== sha256) {
    const address = `https://api.github.com/repos/${repository}/releases/assets/${asset}?download=${Date.now()}`
    const response = await fetch(address, { headers: { Accept: 'application/octet-stream' }, signal: AbortSignal.timeout(60000) })
    if (!response.ok) throw new Error(`Cannot download ${name} (HTTP ${response.status}).`)
    const bytes = Buffer.from(await response.arrayBuffer())
    if (hash(bytes) !== sha256) throw new Error(`SHA-256 mismatch for ${name}.`)
    await writeFile(archive, bytes)
  }
  execFileSync('tar.exe', ['-xf', archive, '-C', payload], { stdio: 'inherit', windowsHide: true })
}

async function includeLicense(repository, tag, name) {
  const response = await fetch(`https://raw.githubusercontent.com/${repository}/${tag}/LICENSE`, { signal: AbortSignal.timeout(30000) })
  if (!response.ok) throw new Error(`Cannot download license for ${repository} (HTTP ${response.status}).`)
  await writeFile(join(payload, name), await response.text())
}

await Promise.all([
  extractRelease(vddRepository, driver.id, driver.sha256, 'vdd-25.7.23.zip'),
  extractRelease(nefconRepository, 300786349, 'a15557da24a9efca203158de3b43b0eaf982db231f0194031f1ed428bc13e669', 'nefcon-1.14.0.zip'),
  includeLicense(vddRepository, '25.7.23', 'VDD-LICENSE.txt'),
  includeLicense(nefconRepository, 'v1.14.0', 'Nefcon-LICENSE.txt'),
])
await cp(join(payload, process.arch === 'arm64' ? 'ARM64' : 'x64', 'nefconc.exe'), join(payload, 'nefconc.exe'))

const staging = await mkdtemp(join(release, '.installer-app-'))
const appSource = join(staging, 'app')
const installerName = `Tablet-Link-${version}-Setup-${process.arch}.exe`
try {
  execFileSync(process.execPath, [resolve('scripts/package-win.mjs'), appSource], { stdio: 'inherit', windowsHide: true })
  execFileSync(compiler, [
    `/DAppVersion=${version}`, `/DAppArchitecture=${process.arch}`, `/DWindowsArchitecture=${driver.windows}`,
    `/DAppSource=${appSource}`, `/DVddPayload=${payload}`, `/DVddDriver=${driverFolder}`, `/O${staging}`,
    resolve('scripts/windows/Tablet-Link.iss'),
  ], { stdio: 'inherit', windowsHide: true })
  const installer = join(release, installerName)
  await rename(join(staging, installerName), installer)
  console.log(`Ready to install: ${installer}`)
} catch (error) {
  if (error.code === 'ENOENT') throw new Error('Install Inno Setup 6.4 or later, or set ISCC_PATH to its ISCC.exe.')
  throw error
} finally {
  const stagingPath = await realpath(staging)
  if (dirname(stagingPath) === await realpath(release)) await rm(stagingPath, { recursive: true, force: true })
}

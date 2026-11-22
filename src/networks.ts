import { execFile } from 'node:child_process'
import { networkInterfaces } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import type { NetworkAddress } from './wire.ts'

const run = promisify(execFile)
const usbAdapterQuery = String.raw`
  $ErrorActionPreference = 'Stop'
  [Console]::OutputEncoding = [Text.Encoding]::UTF8
  $adapters = Get-CimInstance Win32_NetworkAdapter -Filter 'NetConnectionStatus=2' |
    Where-Object { $_.PNPDeviceID -like 'USB\*' -and
      $_.Name -match 'RNDIS|Remote NDIS|(?:USB|CDC).*(?:Ethernet|NCM|Network)|(?:Ethernet|CDC).*USB' }
  ConvertTo-Json -InputObject @($adapters | ForEach-Object { $_.NetConnectionID }) -Compress
`

async function usbAdapterNames(): Promise<string[]> {
  if (process.platform !== 'win32' || !process.env.SystemRoot) return []
  const powershell = join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  try {
    const { stdout } = await run(powershell, ['-NoProfile', '-NonInteractive', '-Command', usbAdapterQuery], {
      windowsHide: true, timeout: 5000, encoding: 'utf8',
    })
    const names = JSON.parse(stdout) as unknown
    return Array.isArray(names) ? names.filter((name): name is string => typeof name === 'string') : []
  } catch {
    return []
  }
}

export async function networks(): Promise<NetworkAddress[]> {
  const usb = new Set((await usbAdapterNames()).map((name) => name.toLowerCase()))
  return Object.entries(networkInterfaces()).flatMap(([name, entries]) =>
    (entries ?? [])
      .filter(({ address, family, internal }) => family === 'IPv4' && !internal &&
        /^(192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/.test(address))
      .map<NetworkAddress>(({ address }) => ({ name, address, mode: usb.has(name.toLowerCase()) ? 'usb' : 'lan' })),
  ).sort((left, right) => Number(/wi-?fi|wlan/i.test(right.name)) - Number(/wi-?fi|wlan/i.test(left.name)))
}

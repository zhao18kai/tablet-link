import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const installer = fileURLToPath(new URL('../scripts/windows/install-vdd.ps1', import.meta.url)).replaceAll("'", "''")
const windowsOnly = { skip: process.platform !== 'win32' }

function runDriverSetup(devices: string) {
  return spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'RemoteSigned', '-Command', `
    $ErrorActionPreference = 'Stop'
    function Get-CimInstance {
      param([string]$ClassName, [string]$Filter)
      ${devices}
    }
    & '${installer}' -DisplayHelper 'unused.exe'
    exit $LASTEXITCODE
  `], { encoding: 'utf8', timeout: 15000, windowsHide: true })
}

test('Windows Setup leaves an existing healthy VDD installation alone', windowsOnly, () => {
  const result = runDriverSetup("[pscustomobject]@{DeviceID='ROOT\\DISPLAY\\0003'; HardwareID=@('Root\\MttVDD'); ConfigManagerErrorCode=0}")
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /VDD is already installed/)
})

test('Windows Setup reports a missing bundled driver when there is no VDD', windowsOnly, () => {
  const result = runDriverSetup('')
  assert.equal(result.status, 1, result.stderr)
  assert.match(result.stderr, /Bundled VDD files are missing/)
})

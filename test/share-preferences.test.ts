import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { loadRememberedComputer } from '../src/remembered-computer.ts'
import { readSavedShare, restoreNetwork, type SavedShare } from '../src/share-preferences.ts'

test('automatic sharing restores a changed IP only on the previous adapter', () => {
  const saved: SavedShare = {
    extension: true, displayId: '42', displayName: 'VDD by MTT', automatic: false,
    networkName: 'Wi-Fi', address: '192.168.1.9', mode: 'lan', allowTouch: true, followOrientation: true,
  }
  const current = { name: 'Wi-Fi', address: '192.168.1.12', mode: 'lan' as const }
  assert.deepEqual(readSavedShare(JSON.stringify(saved)), saved)
  assert.equal(readSavedShare('{"displayId":"42"}'), undefined)
  assert.deepEqual(restoreNetwork(saved, [current]), current)
  assert.equal(restoreNetwork(saved, [{ ...current, name: 'Ethernet' }]), undefined)
  assert.equal(restoreNetwork(saved, [current, { ...current, address: '192.168.1.13' }]), undefined)
})

test('a PC retains its LAN identity and token across sharing sessions', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'tablet-link-computer-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const first = await loadRememberedComputer(directory)
  assert.match(first.id, /^[0-9a-f]{32}$/)
  assert.match(first.token, /^[\w-]{32}$/)
  assert.notEqual(first.id, first.token)
  assert.deepEqual(await loadRememberedComputer(directory), first)
})

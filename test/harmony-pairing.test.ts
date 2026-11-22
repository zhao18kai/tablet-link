import assert from 'node:assert/strict'
import test from 'node:test'
import { parsePairingUrl } from '../harmony/entry/src/main/ets/connect/PairingUrl.ts'

const token = 'aB0123456789_-'.repeat(2) + 'Cd34'

test('HarmonyOS accepts the current Windows viewer links for each supported LAN range', () => {
  for (const address of ['192.168.42.17', '10.0.0.4', '172.16.1.2', '172.31.255.1']) {
    const link = `http://${address}:53820/#${token}`
    assert.equal(parsePairingUrl(`  ${link}\n`), link)
  }
})

test('HarmonyOS rejects malformed or unrelated QR links', () => {
  for (const link of [
    `http://172.32.1.2:53820/#${token}`,
    `http://192.168.1.256:53820/#${token}`,
    `http://192.168.001.1:53820/#${token}`,
    `http://192.168.1.2:65536/#${token}`,
    `http://192.168.1.2:0/#${token}`,
    `http://192.168.1.2:53820/admin#${token}`,
    `http://192.168.1.2:53820/?token=${token}`,
    'http://192.168.1.2:53820/#short',
    `http://192.168.1.2:53820/#${token}a`,
    `http://192.168.1.2:53820@1.2.3.4/#${token}`,
    `https://example.com/#${token}`,
  ]) assert.equal(parsePairingUrl(link), '', link)
})

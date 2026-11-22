import assert from 'node:assert/strict'
import test from 'node:test'
import * as pairing from '../harmony/entry/src/main/ets/connect/PairingUrl.ts'

const token = 'aB0123456789_-'.repeat(2) + 'Cd34'

test('HarmonyOS accepts the current Windows viewer links for each supported LAN range', () => {
  for (const address of ['192.168.42.17', '10.0.0.4', '172.16.1.2', '172.31.255.1']) {
    const link = `http://${address}:53820/#${token}`
    assert.equal(pairing.parsePairingUrl(`  ${link}\n`), link)
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
    `http://192.168.1.2:53820/#${token}.reconnect`,
    `http://192.168.1.2:53820@1.2.3.4/#${token}`,
    `https://example.com/#${token}`,
  ]) assert.equal(pairing.parsePairingUrl(link), '', link)
})

test('HarmonyOS generates reconnect links only for private IPv4 and valid credentials', () => {
  assert.equal(pairing.buildReconnectUrl('192.168.1.21', 53820, token),
    `http://192.168.1.21:53820/#${token}.reconnect`)
  assert.equal(pairing.buildReconnectUrl('127.0.0.1', 53820, token), '')
  assert.equal(pairing.buildReconnectUrl('fe80::1', 53820, token), '')
  assert.equal(pairing.buildReconnectUrl('192.168.1.21', 65536, token), '')
  assert.equal(pairing.buildReconnectUrl('192.168.1.21', 53820.5, token), '')
  assert.equal(pairing.buildReconnectUrl('192.168.1.21', 53820, 'a/b'), '')
})

test('HarmonyOS matches the announced computer ID and accepts the TXT IPv4 fallback', () => {
  const id = '0123456789abcdef0123456789abcdef'
  const serviceName = `TabletLink-${id}`
  assert.deepEqual(pairing.resolveComputer(serviceName, 53820, '192.168.1.21', '10.0.0.42'),
    { id, address: '192.168.1.21', port: 53820 })
  assert.deepEqual(pairing.resolveComputer(serviceName.toUpperCase(), 53820, 'fe80::1', '10.0.0.42'),
    { id, address: '10.0.0.42', port: 53820 })
  assert.equal(pairing.resolveComputer(`Other-${id}`, 53820, '192.168.1.21', ''), null)
  assert.equal(pairing.resolveComputer(serviceName, 53820, 'fe80::1', '192.168.001.21'), null)
})

test('HarmonyOS reads approved computer history in recent order and discards malformed entries', () => {
  const id = '0123456789abcdef0123456789abcdef'
  const otherId = 'abcdef0123456789abcdef0123456789'
  const recent = { id, name: '工作电脑', token }
  const older = { id: otherId, name: '家用电脑', token }
  const saved = JSON.stringify([recent, null, { id: 'bad', name: 'Laptop', token },
    { id: otherId, name: 'Laptop', token: 12 }, { id: otherId, name: 15, token },
    older, { ...recent, name: 'Older Name' }])
  assert.deepEqual(pairing.readRememberedComputers(saved), [recent, older])
  assert.deepEqual(pairing.readRememberedComputers('{'), [])
  assert.deepEqual(pairing.readRememberedComputers(JSON.stringify(recent)), [])
  assert.deepEqual(pairing.rememberComputer([recent, older], { ...older, name: '新名称' }),
    [{ ...older, name: '新名称' }, recent])
})

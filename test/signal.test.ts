import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import WebSocket from 'ws'
import { startLanServer } from '../src/lan.ts'

async function setup(t: test.TestContext) {
  const dir = await mkdtemp(join(tmpdir(), 'tablet-link-test-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  await writeFile(join(dir, 'watch.html'), '<title>Receiver</title>')
  await writeFile(join(dir, 'private.txt'), 'not public')
  const server = await startLanServer('127.0.0.1', dir)
  t.after(() => server.stop())
  const viewerUrl = new URL(server.viewerUrl)
  const viewerWs = new URL('/viewer', viewerUrl)
  viewerWs.protocol = 'ws:'
  viewerWs.searchParams.set('token', viewerUrl.hash.slice(1))
  return { server, viewerUrl, viewerWs }
}

function connect(url: URL | string, origin: string) {
  const socket = new WebSocket(url, { origin })
  return { socket, opened: once(socket, 'open') }
}

function receive(socket: WebSocket) {
  return once(socket, 'message').then(([data]) => JSON.parse(data.toString()))
}

test('the LAN server serves only viewer assets and shuts down', async (t) => {
  const { server, viewerUrl } = await setup(t)
  const response = await fetch(viewerUrl)
  assert.match(await response.text(), /Receiver/)
  assert.equal((await fetch(new URL('/private.txt', viewerUrl))).status, 404)
  await server.stop()
  await assert.rejects(fetch(viewerUrl))
})

test('invalid tokens and foreign browser origins cannot join a session', async (t) => {
  const { viewerUrl, viewerWs } = await setup(t)
  await assert.rejects(connect(viewerWs, 'http://foreign.test').opened, /403/)
  viewerWs.searchParams.set('token', 'wrong')
  await assert.rejects(connect(viewerWs, viewerUrl.origin).opened, /403/)
})

test('Electron can open the desktop channel from its file origin', async (t) => {
  const { server } = await setup(t)
  const desktop = connect(server.hostUrl, 'file://')
  await desktop.opened
  assert.equal(desktop.socket.readyState, WebSocket.OPEN)
})

test('a single viewer can exchange media signals only after desktop approval', async (t) => {
  const { server, viewerUrl, viewerWs } = await setup(t)
  const host = connect(server.hostUrl, 'null')
  await host.opened
  const request = receive(host.socket)
  const viewer = connect(viewerWs, viewerUrl.origin)
  await viewer.opened
  const { type, id } = await request
  assert.equal(type, 'viewer-request')
  await assert.rejects(connect(viewerWs, viewerUrl.origin).opened, /409/)

  const messages: string[] = []
  viewer.socket.on('message', (data) => messages.push(JSON.parse(data.toString()).type))
  const offer = { type: 'offer', id, description: { type: 'offer', sdp: 'example' } }
  host.socket.send(JSON.stringify(offer))
  const approved = receive(viewer.socket)
  host.socket.send(JSON.stringify({ type: 'approve', id }))
  assert.equal((await approved).type, 'approved')
  assert.deepEqual(messages, ['approved'])

  const forwardedOffer = receive(viewer.socket)
  host.socket.send(JSON.stringify(offer))
  assert.deepEqual(await forwardedOffer, offer)

  const forwardedAnswer = receive(host.socket)
  const answer = { type: 'answer', id, description: { type: 'answer', sdp: 'example' } }
  viewer.socket.send(JSON.stringify(answer))
  assert.deepEqual(await forwardedAnswer, answer)

  const departed = receive(host.socket)
  viewer.socket.close()
  assert.equal((await departed).type, 'viewer-left')
  const nextRequest = receive(host.socket)
  await connect(viewerWs, viewerUrl.origin).opened
  assert.equal((await nextRequest).type, 'viewer-request')
})

test('rejecting a viewer releases its slot for a fresh request', async (t) => {
  const { server, viewerUrl, viewerWs } = await setup(t)
  const host = connect(server.hostUrl, 'null')
  await host.opened
  const request = receive(host.socket)
  const viewer = connect(viewerWs, viewerUrl.origin)
  await viewer.opened
  const { id } = await request
  const refused = receive(viewer.socket)
  const closed = once(viewer.socket, 'close')
  host.socket.send(JSON.stringify({ type: 'reject', id }))
  assert.equal((await refused).type, 'rejected')
  await closed
  await connect(viewerWs, viewerUrl.origin).opened
})

test('approval for a departed viewer cannot approve the next viewer', async (t) => {
  const { server, viewerUrl, viewerWs } = await setup(t)
  const host = connect(server.hostUrl, 'null')
  await host.opened
  const receivedFirst = receive(host.socket)
  const first = connect(viewerWs, viewerUrl.origin)
  await first.opened
  const oldRequest = await receivedFirst
  const departed = receive(host.socket)
  first.socket.close()
  await departed
  const receivedSecond = receive(host.socket)
  const second = connect(viewerWs, viewerUrl.origin)
  await second.opened
  const newRequest = await receivedSecond
  assert.notEqual(oldRequest.id, newRequest.id)

  const firstReply = receive(second.socket)
  host.socket.send(JSON.stringify({ type: 'approve', id: oldRequest.id }))
  host.socket.send(JSON.stringify({ type: 'reject', id: newRequest.id }))
  assert.equal((await firstReply).type, 'rejected')
})

import assert from 'node:assert/strict'
import { on, once } from 'node:events'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { connect as openTcpSocket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import WebSocket from 'ws'
import { startLanServer } from '../src/lan.ts'

async function setup(t: test.TestContext, onOrientation?: (orientation: string) => void) {
  const dir = await mkdtemp(join(tmpdir(), 'tablet-link-test-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  await writeFile(join(dir, 'watch.html'), '<title>Receiver</title>')
  await writeFile(join(dir, 'private.txt'), 'not public')
  const server = await startLanServer('127.0.0.1', dir, onOrientation)
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

async function receiveMessages(socket: WebSocket, count: number) {
  const messages = []
  for await (const [data] of on(socket, 'message')) {
    messages.push(JSON.parse(data.toString()))
    if (messages.length === count) break
  }
  return messages
}

async function approveViewer(host: WebSocket, viewerWs: URL, origin: string) {
  const request = receive(host)
  const viewer = connect(viewerWs, origin)
  const guestApproval = receive(viewer.socket)
  await viewer.opened
  const { id } = await request
  const hostApproval = receive(host)
  host.send(JSON.stringify({ type: 'approve', id }))
  const approved = await guestApproval
  assert.equal(approved.type, 'approved')
  assert.equal(approved.id, id)
  assert.equal(typeof approved.resumeToken, 'string')
  assert.notEqual(approved.resumeToken, viewerWs.searchParams.get('token'))
  assert.deepEqual(await hostApproval, { type: 'approved', id })
  const resumeUrl = new URL(viewerWs)
  resumeUrl.searchParams.set('resume', approved.resumeToken)
  return { socket: viewer.socket, id, resumeUrl, resumeToken: approved.resumeToken }
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

test('rotation follows the most recent valid direction from an approved viewer', { timeout: 4000 }, async (t) => {
  const applied: string[] = []
  let resolveRotation!: () => void
  const rotated = new Promise<void>((resolve) => { resolveRotation = resolve })
  const { server, viewerUrl, viewerWs } = await setup(t, (orientation) => {
    applied.push(orientation)
    resolveRotation()
  })
  const host = connect(server.hostUrl, 'null')
  await host.opened
  const request = receive(host.socket)
  const viewer = connect(viewerWs, viewerUrl.origin)
  await viewer.opened
  const { id } = await request
  const orientation = (direction: string, session = id) => JSON.stringify({ type: 'orientation', id: session, direction })
  viewer.socket.send(orientation('portrait'))
  const received = once(viewer.socket, 'pong')
  viewer.socket.ping()
  await received
  const approved = receive(viewer.socket)
  host.socket.send(JSON.stringify({ type: 'approve', id }))
  assert.equal((await approved).followOrientation, true)
  await delay(200)
  assert.deepEqual(applied, [])

  viewer.socket.send(orientation('portrait'))
  viewer.socket.send(orientation('landscape'))
  viewer.socket.send(orientation('portrait', 'old-session'))
  viewer.socket.send(orientation('arbitrary-mode'))
  host.socket.send(orientation('portrait'))
  await rotated
  assert.deepEqual(applied, ['landscape'])
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

test('a disconnected approved viewer resumes with a new signaling id', { timeout: 5000 }, async (t) => {
  const { server, viewerUrl, viewerWs } = await setup(t)
  const host = connect(server.hostUrl, 'null')
  await host.opened
  const first = await approveViewer(host.socket, viewerWs, viewerUrl.origin)

  const departed = receive(host.socket)
  first.socket.terminate()
  assert.deepEqual(await departed, { type: 'viewer-left', id: first.id })

  const hostMessages = receiveMessages(host.socket, 2)
  const resumed = connect(first.resumeUrl, viewerUrl.origin)
  const approved = receive(resumed.socket)
  await resumed.opened
  const [request, confirmation] = await hostMessages
  assert.notEqual(request.id, first.id)
  assert.deepEqual(request, { type: 'viewer-request', id: request.id, resumed: true })
  assert.deepEqual(confirmation, { type: 'approved', id: request.id })
  assert.deepEqual(await approved, { type: 'approved', id: request.id, resumeToken: first.resumeToken })
})

test('a valid resume can take over its previous socket before the server detects loss', { timeout: 5000 }, async (t) => {
  const { server, viewerUrl, viewerWs } = await setup(t)
  const host = connect(server.hostUrl, 'null')
  await host.opened
  const first = await approveViewer(host.socket, viewerWs, viewerUrl.origin)

  const replaced = once(first.socket, 'close')
  const hostMessages = receiveMessages(host.socket, 3)
  const resumed = connect(first.resumeUrl, viewerUrl.origin)
  const approved = receive(resumed.socket)
  await resumed.opened
  const [left, request, confirmation] = await hostMessages
  assert.deepEqual(left, { type: 'viewer-left', id: first.id })
  assert.notEqual(request.id, first.id)
  assert.deepEqual(request, { type: 'viewer-request', id: request.id, resumed: true })
  assert.deepEqual(confirmation, { type: 'approved', id: request.id })
  assert.equal((await replaced)[0], 4002)
  assert.deepEqual(await approved, { type: 'approved', id: request.id, resumeToken: first.resumeToken })

  const forwarded = receive(resumed.socket)
  const offer = { type: 'offer', id: request.id, description: { type: 'offer', sdp: 'example' } }
  host.socket.send(JSON.stringify(offer))
  assert.deepEqual(await forwarded, offer)
})

test('the QR token alone still requires approval and a new approval revokes the previous resume token', { timeout: 5000 }, async (t) => {
  const { server, viewerUrl, viewerWs } = await setup(t)
  const host = connect(server.hostUrl, 'null')
  await host.opened
  const first = await approveViewer(host.socket, viewerWs, viewerUrl.origin)
  const departed = receive(host.socket)
  first.socket.terminate()
  await departed
  const wrong = new URL(viewerWs)
  wrong.searchParams.set('resume', viewerWs.searchParams.get('token')!)
  await assert.rejects(connect(wrong, viewerUrl.origin).opened, /403/)

  const requested = receive(host.socket)
  const second = connect(viewerWs, viewerUrl.origin)
  await second.opened
  const request = await requested
  assert.notEqual(request.id, first.id)
  assert.deepEqual(request, { type: 'viewer-request', id: request.id })
  const approved = receive(second.socket)
  host.socket.send(JSON.stringify({ type: 'approve', id: request.id }))
  const confirmation = await approved
  assert.equal(confirmation.type, 'approved')
  assert.notEqual(confirmation.resumeToken, first.resumeToken)
  const secondDeparture = receive(host.socket)
  second.socket.terminate()
  await secondDeparture
  await assert.rejects(connect(first.resumeUrl, viewerUrl.origin).opened, /403/)
})

test('a viewer cannot resume after explicitly leaving', { timeout: 5000 }, async (t) => {
  const { server, viewerUrl, viewerWs } = await setup(t)
  const host = connect(server.hostUrl, 'null')
  await host.opened
  const viewer = await approveViewer(host.socket, viewerWs, viewerUrl.origin)
  const departed = receive(host.socket)
  viewer.socket.close(4001)
  await departed
  await assert.rejects(connect(viewer.resumeUrl, viewerUrl.origin).opened, /403/)
})

test('a viewer cannot resume after the desktop rejects its approved connection', { timeout: 5000 }, async (t) => {
  const { server, viewerUrl, viewerWs } = await setup(t)
  const host = connect(server.hostUrl, 'null')
  await host.opened
  const viewer = await approveViewer(host.socket, viewerWs, viewerUrl.origin)
  const departed = receive(host.socket)
  const rejected = receive(viewer.socket)
  host.socket.send(JSON.stringify({ type: 'reject', id: viewer.id }))
  assert.equal((await rejected).type, 'rejected')
  await departed
  await assert.rejects(connect(viewer.resumeUrl, viewerUrl.origin).opened, /403/)
})

test('resume credentials expire after an unexpected loss', { timeout: 5000 }, async (t) => {
  t.mock.timers.enable({ apis: ['Date'] })
  const { server, viewerUrl, viewerWs } = await setup(t)
  const host = connect(server.hostUrl, 'null')
  await host.opened
  const viewer = await approveViewer(host.socket, viewerWs, viewerUrl.origin)
  const departed = receive(host.socket)
  viewer.socket.terminate()
  await departed
  t.mock.timers.tick(61_000)
  await assert.rejects(connect(viewer.resumeUrl, viewerUrl.origin).opened, /403/)
})

test('stopping the share tells a connected viewer the share ended', { timeout: 5000 }, async (t) => {
  const { server, viewerUrl, viewerWs } = await setup(t)
  const host = connect(server.hostUrl, 'null')
  await host.opened
  const viewer = connect(viewerWs, viewerUrl.origin)
  await viewer.opened
  const closed = once(viewer.socket, 'close')
  host.socket.pause()
  try {
    const stopped = await Promise.race([server.stop().then(() => true), delay(2500, false, { ref: false })])
    assert.ok(stopped, 'shutdown should finish even if the host never acknowledges its close frame')
    assert.equal((await closed)[0], 4000)
    await assert.rejects(fetch(viewerUrl))
  } finally {
    host.socket.terminate()
  }
})

test('a rejected upgrade releases its connection even if the client keeps its end open', { timeout: 5000 }, async (t) => {
  const { server, viewerUrl } = await setup(t)
  const client = openTcpSocket({ host: viewerUrl.hostname, port: Number(viewerUrl.port), allowHalfOpen: true })
  try {
    await once(client, 'connect')
    client.write([
      'GET /viewer?token=invalid HTTP/1.1',
      `Host: ${viewerUrl.host}`,
      'Connection: Upgrade',
      'Upgrade: websocket',
      '\r\n',
    ].join('\r\n'))
    const [response] = await once(client, 'data')
    assert.match(response.toString(), /^HTTP\/1.1 403 Forbidden/)
    const stopped = await Promise.race([server.stop().then(() => true), delay(2500, false, { ref: false })])
    assert.ok(stopped, 'a rejected upgrade should not block shutdown')
  } finally {
    client.destroy()
  }
})

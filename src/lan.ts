import { randomBytes, randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import type { Duplex } from 'node:stream'
import { WebSocket, WebSocketServer } from 'ws'
import { SHARE_ENDED, VIEWER_LEAVING, VIEWER_REPLACED, type Signal } from './wire.ts'

const resumeGraceMs = 60_000
const closeGraceMs = 1_000

type Viewer = { socket: WebSocket; id: string }
type ResumeGrant = { token: string; id: string; expiresAt?: number }

const assets: Record<string, [string, string]> = {
  '/': ['watch.html', 'text/html; charset=utf-8'],
  '/watch.js': ['watch.js', 'text/javascript; charset=utf-8'],
  '/app.css': ['app.css', 'text/css; charset=utf-8'],
}

function send(socket: WebSocket | undefined, signal: Signal) {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(signal))
}

function refuseUpgrade(socket: Duplex, status: '403 Forbidden' | '409 Conflict') {
  socket.once('error', () => socket.destroy())
  socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`, () => socket.destroy())
}

function readSignal(text: string): Signal | undefined {
  try {
    const message = JSON.parse(text) as Signal | null
    if (typeof message?.id !== 'string') return undefined
    switch (message?.type) {
      case 'approve':
      case 'reject':
        return message
      case 'offer':
      case 'answer':
        if (message.description?.type === message.type && typeof message.description.sdp === 'string') return message
        break
      case 'ice':
        if (typeof message.candidate?.candidate === 'string') return message
        break
    }
  } catch {
    return undefined
  }
}

export async function startLanServer(address: string, directory: string) {
  const hostToken = randomBytes(24).toString('base64url')
  const viewerToken = randomBytes(24).toString('base64url')
  const websocket = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 })
  let host: WebSocket | undefined
  let viewer: Viewer | undefined
  let resumeGrant: ResumeGrant | undefined
  let stopped: Promise<void> | undefined
  let authority = ''

  const http = createServer(async (request, response) => {
    const asset = assets[request.url ?? '']
    if (request.headers.host !== authority || request.method !== 'GET' || !Array.isArray(asset)) {
      response.writeHead(404).end()
      return
    }
    const [file, contentType] = asset
    try {
      const body = await readFile(join(directory, file))
      response.writeHead(200, {
        'Content-Type': contentType,
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'no-referrer',
        'Content-Security-Policy': `default-src 'none'; script-src 'self'; style-src 'self'; media-src blob:; connect-src ws://${authority}; frame-ancestors 'none'`,
      }).end(body)
    } catch {
      response.writeHead(500).end()
    }
  })

  function removeViewer(socket: WebSocket | undefined) {
    if (!viewer || viewer.socket !== socket) return
    const { id } = viewer
    viewer = undefined
    send(host, { type: 'viewer-left', id })
  }

  function approveViewer(current: Viewer, resumeToken: string) {
    resumeGrant = { token: resumeToken, id: current.id }
    send(current.socket, { type: 'approved', id: current.id, resumeToken })
    send(host, { type: 'approved', id: current.id })
  }

  const awaitingPong = new Set<WebSocket>()
  http.on('upgrade', (request, networkSocket, head) => {
    let endpoint: URL | undefined
    if (request.url?.startsWith('/')) {
      try {
        endpoint = new URL(request.url, `http://${authority}`)
      } catch {
        // Invalid request targets are rejected below.
      }
    }
    const origin = request.headers.origin
    const token = endpoint?.searchParams.get('token')
    const asHost = endpoint?.pathname === '/host' && token === hostToken && (origin === 'file://' || origin === 'null')
    const asViewer = endpoint?.pathname === '/viewer' && token === viewerToken && origin === `http://${authority}`
    const requestedResume = endpoint?.searchParams.get('resume') ?? null
    const grant = asViewer && resumeGrant?.token === requestedResume &&
      (resumeGrant.expiresAt === undefined || Date.now() < resumeGrant.expiresAt) ? resumeGrant : undefined
    if (request.headers.host !== authority || (!asHost && !asViewer) || (asViewer && requestedResume !== null && !grant)) {
      refuseUpgrade(networkSocket, '403 Forbidden')
      return
    }
    const viewerOccupied = viewer && viewer.id !== grant?.id
    if (stopped || (asHost ? host : viewerOccupied || host?.readyState !== WebSocket.OPEN)) {
      refuseUpgrade(networkSocket, '409 Conflict')
      return
    }
    websocket.handleUpgrade(request, networkSocket, head, (socket) => {
      if (asHost) host = socket
      else {
        const previous = viewer?.socket
        removeViewer(previous)
        previous?.close(VIEWER_REPLACED, 'viewer reconnected')
        viewer = { socket, id: randomUUID() }
        if (grant) {
          send(host, { type: 'viewer-request', id: viewer.id, resumed: true })
          approveViewer(viewer, grant.token)
        } else send(host, { type: 'viewer-request', id: viewer.id })
      }

      socket.on('pong', () => awaitingPong.delete(socket))
      socket.on('error', () => socket.terminate())
      socket.on('close', (code) => {
        awaitingPong.delete(socket)
        if (host === socket) {
          host = undefined
          resumeGrant = undefined
          viewer?.socket.close(SHARE_ENDED, 'host stopped')
          removeViewer(viewer?.socket)
        } else if (viewer?.socket === socket) {
          if (resumeGrant?.id === viewer.id) {
            if (code === VIEWER_LEAVING) resumeGrant = undefined
            else resumeGrant.expiresAt = Date.now() + resumeGraceMs
          }
          removeViewer(socket)
        }
      })
      socket.on('message', (raw, binary) => {
        const current = viewer
        if (stopped || binary || (socket !== host && socket !== current?.socket)) return
        const message = readSignal(raw.toString())
        if (!message) return
        if (socket === host && message.type === 'reject' && resumeGrant?.id === message.id) resumeGrant = undefined
        if (!current || message.id !== current.id) return
        const approved = resumeGrant?.id === current.id
        if (socket === host && message.type === 'approve' && !approved) {
          approveViewer(current, randomBytes(24).toString('base64url'))
        } else if (socket === host && message.type === 'reject') {
          send(current.socket, { type: 'rejected', id: current.id })
          removeViewer(current.socket)
          current.socket.close()
        } else if (approved) {
          if (socket === host && (message.type === 'offer' || message.type === 'ice')) send(current.socket, message)
          if (socket === current.socket && (message.type === 'answer' || message.type === 'ice')) send(host, message)
        }
      })
    })
  })

  await new Promise<void>((resolve, reject) => {
    http.once('error', reject)
    http.listen(0, address, () => {
      http.off('error', reject)
      authority = `${address}:${(http.address() as AddressInfo).port}`
      resolve()
    })
  })

  const heartbeat = setInterval(() => {
    for (const socket of websocket.clients) {
      if (socket.readyState !== WebSocket.OPEN) continue
      if (awaitingPong.has(socket)) socket.terminate()
      else {
        awaitingPong.add(socket)
        socket.ping()
      }
    }
  }, 12000)
  heartbeat.unref()

  return {
    hostUrl: `ws://${authority}/host?token=${hostToken}`,
    viewerUrl: `http://${authority}/#${viewerToken}`,
    stop() {
      if (stopped) return stopped
      clearInterval(heartbeat)
      resumeGrant = undefined
      const httpClosed = new Promise<void>((resolve) => http.close(() => resolve()))
      http.closeAllConnections()
      const socketsClosed = new Promise<void>((resolve) => websocket.close(() => resolve()))
      for (const socket of websocket.clients) socket.close(SHARE_ENDED, 'host stopped')
      const forceClose = setTimeout(() => {
        for (const socket of websocket.clients) socket.terminate()
      }, closeGraceMs)
      stopped = Promise.all([httpClosed, socketsClosed]).then(() => {
        clearTimeout(forceClose)
      })
      return stopped
    },
  }
}

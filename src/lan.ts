import { randomBytes, randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import type { Duplex } from 'node:stream'
import { WebSocket, WebSocketServer } from 'ws'
import { advertiseShare } from './lan-discovery.ts'
import { SHARE_ENDED, VIEWER_LEAVING, VIEWER_REPLACED, type ConnectionMode, type DisplayOrientation, type RememberedComputer, type Signal } from './wire.ts'

export type { RememberedComputer } from './wire.ts'

const resumeGraceMs = 60_000
const closeGraceMs = 1_000
const orientationSettleMs = 40

type ViewerCredential = 'qr' | 'remembered'
type Viewer = { socket: WebSocket; id: string; credential: ViewerCredential }
type ResumeGrant = { token: string; id: string; credential: ViewerCredential; expiresAt?: number }

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
      case 'orientation':
        if (message.direction === 'portrait' || message.direction === 'landscape') return message
        break
    }
  } catch {
    return undefined
  }
}

export async function startLanServer(
  address: string, directory: string, onOrientation?: (direction: DisplayOrientation) => void, connectionMode?: ConnectionMode,
  onViewerGone?: (id: string) => void,
  rememberedComputer?: RememberedComputer,
) {
  const hostToken = randomBytes(24).toString('base64url')
  const viewerToken = randomBytes(24).toString('base64url')
  const { id, name, token } = rememberedComputer ?? {}
  const remembered = connectionMode === 'lan' && id?.length === 32 && /^[0-9a-f]+$/.test(id) &&
    token?.length === 32 && /^[A-Za-z0-9_-]+$/.test(token) && name?.trim() ? { id, name, token } : undefined
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
    onViewerGone?.(id)
  }

  function approveViewer(current: Viewer, resumeToken: string) {
    resumeGrant = { token: resumeToken, id: current.id, credential: current.credential }
    send(current.socket, {
      type: 'approved', id: current.id, resumeToken,
      ...(onOrientation && { followOrientation: true as const }),
      ...(connectionMode && { connectionMode }),
      ...(remembered && { rememberedComputer: remembered }),
    })
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
    let viewerCredential: ViewerCredential | undefined
    if (endpoint?.pathname === '/viewer' && origin === `http://${authority}`) {
      if (token === viewerToken) viewerCredential = 'qr'
      else if (remembered && token === remembered.token) viewerCredential = 'remembered'
    }
    const requestedResume = endpoint?.searchParams.get('resume') ?? null
    const grant = viewerCredential && resumeGrant?.credential === viewerCredential && resumeGrant.token === requestedResume &&
      (resumeGrant.expiresAt === undefined || Date.now() < resumeGrant.expiresAt) ? resumeGrant : undefined
    if (request.headers.host !== authority || (!asHost && !viewerCredential) || (viewerCredential && requestedResume !== null && !grant)) {
      refuseUpgrade(networkSocket, '403 Forbidden')
      return
    }
    const viewerOccupied = viewer && viewer.id !== grant?.id
    if (stopped || (asHost ? host : viewerOccupied || host?.readyState !== WebSocket.OPEN)) {
      refuseUpgrade(networkSocket, '409 Conflict')
      return
    }
    websocket.handleUpgrade(request, networkSocket, head, (socket) => {
      let orientationTimer: ReturnType<typeof setTimeout> | undefined
      if (asHost) host = socket
      else if (viewerCredential) {
        const previous = viewer?.socket
        removeViewer(previous)
        previous?.close(VIEWER_REPLACED, 'viewer reconnected')
        viewer = { socket, id: randomUUID(), credential: viewerCredential }
        if (grant) {
          send(host, { type: 'viewer-request', id: viewer.id, resumed: true })
          approveViewer(viewer, grant.token)
        } else send(host, { type: 'viewer-request', id: viewer.id })
      }

      socket.on('pong', () => awaitingPong.delete(socket))
      socket.on('error', () => socket.terminate())
      socket.on('close', (code) => {
        clearTimeout(orientationTimer)
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
          if (socket === current.socket && message.type === 'orientation' && onOrientation) {
            clearTimeout(orientationTimer)
            orientationTimer = setTimeout(() => {
              if (!stopped && viewer === current && resumeGrant?.id === current.id) onOrientation(message.direction)
            }, orientationSettleMs)
          }
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
  const stopAdvertising = remembered && advertiseShare(address, (http.address() as AddressInfo).port, remembered.id)

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
    isViewerApproved(id: string) {
      return !stopped && !!viewer && viewer.id === id && viewer.socket.readyState === WebSocket.OPEN && resumeGrant?.id === id
    },
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
      stopped = Promise.all([httpClosed, socketsClosed, stopAdvertising?.()]).then(() => {
        clearTimeout(forceClose)
      })
      return stopped
    },
  }
}

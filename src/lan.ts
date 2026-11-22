import { randomBytes, randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import { WebSocket, WebSocketServer } from 'ws'
import type { Signal } from './wire.ts'

const assets: Record<string, [string, string]> = {
  '/': ['watch.html', 'text/html; charset=utf-8'],
  '/watch.js': ['watch.js', 'text/javascript; charset=utf-8'],
  '/app.css': ['app.css', 'text/css; charset=utf-8'],
}

function send(socket: WebSocket | undefined, signal: Signal) {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(signal))
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
  let viewer: { socket: WebSocket; id: string; approved: boolean } | undefined
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
    if (request.headers.host !== authority || (!asHost && !asViewer)) {
      networkSocket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n')
      return
    }
    if (asHost ? host : viewer || host?.readyState !== WebSocket.OPEN) {
      networkSocket.end('HTTP/1.1 409 Conflict\r\nConnection: close\r\nContent-Length: 0\r\n\r\n')
      return
    }
    websocket.handleUpgrade(request, networkSocket, head, (socket) => {
      if (asHost) host = socket
      else {
        viewer = { socket, id: randomUUID(), approved: false }
        send(host, { type: 'viewer-request', id: viewer.id })
      }

      socket.on('pong', () => awaitingPong.delete(socket))
      socket.on('error', () => socket.terminate())
      socket.on('close', () => {
        awaitingPong.delete(socket)
        if (host === socket) {
          host = undefined
          viewer?.socket.close(1001, 'host stopped')
          removeViewer(viewer?.socket)
        } else removeViewer(socket)
      })
      socket.on('message', (raw, binary) => {
        const current = viewer
        if (binary || !current || (socket !== host && socket !== current.socket)) return
        const message = readSignal(raw.toString())
        if (!message || message.id !== current.id) return
        if (socket === host && message.type === 'approve' && !current.approved) {
          current.approved = true
          const confirmation: Signal = { type: 'approved', id: current.id }
          send(current.socket, confirmation)
          send(host, confirmation)
        } else if (socket === host && message.type === 'reject') {
          send(current.socket, { type: 'rejected', id: current.id })
          removeViewer(current.socket)
          current.socket.close()
        } else if (current.approved) {
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

  let stopped: Promise<void> | undefined
  return {
    hostUrl: `ws://${authority}/host?token=${hostToken}`,
    viewerUrl: `http://${authority}/#${viewerToken}`,
    stop() {
      stopped ??= new Promise<void>((resolve) => {
        clearInterval(heartbeat)
        for (const socket of websocket.clients) socket.terminate()
        websocket.close()
        http.close(() => resolve())
        http.closeAllConnections()
      })
      return stopped
    },
  }
}

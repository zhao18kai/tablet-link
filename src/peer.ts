import type { Signal } from './wire.ts'

export function transmit(socket: WebSocket, message: Signal) {
  if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message))
}

export function createPeer(id: string, emit: (signal: Signal) => void) {
  const pc = new RTCPeerConnection({ iceServers: [] })
  const pending: RTCIceCandidateInit[] = []
  pc.onicecandidate = ({ candidate }) => {
    if (candidate) emit({ type: 'ice', id, candidate: candidate.toJSON() })
  }

  return {
    pc,
    id,
    async publish(type: 'offer' | 'answer') {
      const description = type === 'offer' ? await pc.createOffer() : await pc.createAnswer()
      await pc.setLocalDescription(description)
      emit({ type, id, description })
    },
    async accept(message: Signal) {
      if (message.type === 'offer' || message.type === 'answer') {
        await pc.setRemoteDescription(message.description)
        for (const candidate of pending.splice(0)) await pc.addIceCandidate(candidate)
      } else if (message.type === 'ice') {
        if (pc.remoteDescription) await pc.addIceCandidate(message.candidate)
        else pending.push(message.candidate)
      }
    },
  }
}

import type { Signal } from './wire.ts'

export function transmit(socket: WebSocket, message: Signal) {
  if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message))
}

export function preferScreenCodec(pc: RTCPeerConnection, sender: RTCRtpSender, mimeType: 'video/VP8' | 'video/H264') {
  const transceiver = pc.getTransceivers().find((candidate) => candidate.sender === sender)
  const codecs = RTCRtpSender.getCapabilities('video')?.codecs
  if (!transceiver || !codecs) return
  const preferred = codecs.filter((codec) => codec.mimeType === mimeType)
  if (!preferred.length) return
  try {
    transceiver.setCodecPreferences([...preferred, ...codecs.filter((codec) => codec.mimeType !== mimeType)])
  } catch {
    // Keep the default negotiation when the platform cannot reorder codecs.
  }
}

export function createPeer(id: string, emit: (signal: Signal) => void, localAddress?: string) {
  const pc = new RTCPeerConnection({ iceServers: [] })
  const pending: RTCIceCandidateInit[] = []
  pc.onicecandidate = ({ candidate }) => {
    if (candidate && (!localAddress || (candidate.address === localAddress && candidate.type === 'host'))) {
      emit({ type: 'ice', id, candidate: candidate.toJSON() })
    }
  }

  return {
    pc,
    id,
    async publish(type: 'offer' | 'answer') {
      const description = type === 'offer' ? await pc.createOffer() : await pc.createAnswer()
      await pc.setLocalDescription(description)
      const sdp = localAddress ? description.sdp?.replace(/^a=candidate:[^\r\n]*\r?\n/gm, '') : description.sdp
      emit({ type, id, description: { type, sdp } })
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

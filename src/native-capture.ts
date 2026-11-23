import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { createSocket } from 'node:dgram'
import { once } from 'node:events'
import { promisify } from 'node:util'
import { MediaStream, MediaStreamTrack, RTCPeerConnection, RtpPacket, useH264 } from 'werift'
import type { NativeStreamState, NativeVideoMode, Signal } from './wire.ts'

const run = promisify(execFile)
const payloadType = 102
export type DxgiTarget = { adapter: number; output: number; width: number; height: number }
type EncoderFormat = NativeVideoMode & { level: '4.2' | '5.1' | '5.2'; bitrate: number }

export function nativeCaptureTarget(text: string): DxgiTarget | undefined {
  const match = /^(\d+) (\d+) (\d+) (\d+)$/.exec(text.trim())
  if (!match) return
  const [adapter, output, width, height] = match.slice(1).map(Number)
  if ([adapter, output, width, height].every(Number.isSafeInteger) && width > 0 && height > 0) {
    return { adapter, output, width, height }
  }
}

export function selectNativeFormat(
  { width, height }: Pick<DxgiTarget, 'width' | 'height'>, refresh: number, sizeCap: number, fpsCap: number,
): EncoderFormat {
  if (!Number.isSafeInteger(sizeCap) || sizeCap < 1920 || sizeCap > 2560 ||
      !Number.isSafeInteger(fpsCap) || fpsCap < 60 || fpsCap > 120) {
    throw new Error('原生画质设置无效。')
  }
  if (width < 1920 || width > sizeCap || height < 1080 || height > 1600 || width % 2 || height % 2) {
    throw new Error('请选择画质上限内的横屏副屏，原生模式最高支持 2560 × 1600。')
  }
  if (!Number.isFinite(refresh) || refresh < 59) throw new Error('副屏需运行在 60 Hz 或更高刷新率。')
  const fps = Math.min(fpsCap, Math.max(60, Math.round(refresh)))
  // H.264 Annex A limits luma macroblocks per frame and per second.
  const blocks = Math.ceil(width / 16) * Math.ceil(height / 16)
  const blocksPerSecond = blocks * fps
  const level = blocks <= 8704 && blocksPerSecond <= 522240 ? '4.2' : blocksPerSecond <= 983040 ? '5.1' : '5.2'
  const bitrate = Math.min(18, Math.round(6 * width * height * fps / (1920 * 1080 * 60)))
  return { width, height, fps, level, bitrate }
}

function encoderBase({ adapter, output }: DxgiTarget, { fps, level, bitrate }: EncoderFormat) {
  return [
    '-hide_banner', '-loglevel', 'error', '-nostdin',
    '-init_hw_device', `d3d11va=capture:${adapter}`, '-filter_hw_device', 'capture',
    '-filter_complex', `ddagrab=output_idx=${output}:framerate=${fps}:dup_frames=0[screen]`, '-map', '[screen]',
    '-an', '-fps_mode', 'passthrough', '-c:v', 'h264_nvenc', '-preset', 'p1', '-tune', 'ull',
    '-zerolatency', '1', '-bf', '0', '-g', String(fps), '-profile:v', 'baseline', '-level:v', level,
    '-b:v', `${bitrate}M`, '-maxrate', `${Math.ceil(bitrate * 4 / 3)}M`, '-bufsize', `${Math.round(bitrate / 6 * 1000)}k`, '-forced-idr', '1',
  ]
}

export function nativeEncoderArgs(target: DxgiTarget, format: EncoderFormat, port: number) {
  return [...encoderBase(target, format), '-bsf:v', 'dump_extra=freq=keyframe', '-f', 'rtp', '-rtpflags', 'skip_rtcp',
    '-payload_type', String(payloadType), `rtp://127.0.0.1:${port}?pkt_size=1100`]
}

export async function probeNativeEncoder(executable: string, target: DxgiTarget, format: EncoderFormat, signal: AbortSignal) {
  await run(executable, [...encoderBase(target, format), '-frames:v', '1', '-f', 'null', 'NUL'], {
    timeout: 6000, maxBuffer: 65536, windowsHide: true, signal,
  })
}

export async function createNativePeer(options: {
  executable: string
  target: DxgiTarget
  format: EncoderFormat
  address: string
  signal: AbortSignal
  onState: (state: NativeStreamState) => void
  onPointer?: (data: string) => void
}) {
  const levelIdc = { '4.2': '2a', '5.1': '33', '5.2': '34' }[options.format.level]
  const pc = new RTCPeerConnection({
    iceServers: [], iceUseDefaultStunServer: false, iceUseIpv4: true, iceUseIpv6: false, iceUseTcp: false,
    iceInterfaceAddresses: { udp4: options.address },
    codecs: { video: [useH264({
      payloadType, parameters: `profile-level-id=42e0${levelIdc};packetization-mode=1;level-asymmetry-allowed=1`,
    })] },
  })
  const track = new MediaStreamTrack({ kind: 'video' })
  pc.addTrack(track, new MediaStream([track]))
  const pendingIce: RTCIceCandidateInit[] = []
  const receiver = createSocket({ type: 'udp4', recvBufferSize: 4 * 1024 * 1024 })
  let encoder: ChildProcess | undefined
  let closing: Promise<void> | undefined
  let ready = false
  let failed = false
  let frameTimer: ReturnType<typeof setTimeout> | undefined
  let encodedFrames = 0

  function fail() {
    if (closing || failed) return
    failed = true
    options.onState('failed')
  }

  function close() {
    if (closing) return closing
    closing = (async () => {
      options.signal.removeEventListener('abort', abort)
      clearTimeout(frameTimer)
      track.stop()
      const child = encoder
      const exited = child && child.exitCode === null && child.signalCode === null && child.pid
        ? once(child, 'close').catch(() => undefined) : undefined
      if (exited) child?.kill()
      await Promise.all([pc.close(), exited, new Promise<void>((resolve) => {
        try { receiver.close(() => resolve()) } catch { resolve() }
      })])
    })()
    return closing
  }

  function abort() { void close().catch(() => {}) }
  options.signal.addEventListener('abort', abort, { once: true })
  try {
    options.signal.throwIfAborted()
    receiver.bind(0, '127.0.0.1')
    await once(receiver, 'listening', { signal: options.signal })
    options.signal.throwIfAborted()
    if (receiver.getRecvBufferSize() < 1024 * 1024) throw new Error('本机视频缓冲不可用。')
    const port = receiver.address().port
    receiver.on('error', fail)
    receiver.on('message', (datagram) => {
      if (closing || failed || datagram.length < 12 || datagram[0] >>> 6 !== 2 || (datagram[1] & 127) !== payloadType) return
      try {
        const packet = RtpPacket.deSerialize(datagram)
        track.writeRtp(packet)
        if (!packet.header.marker) return
        encodedFrames++
        if (!ready) {
          ready = true
          clearTimeout(frameTimer)
          options.onState('streaming')
        }
      } catch {
        fail()
      }
    })
    if (options.onPointer) {
      const channel = pc.createDataChannel('tablet-link-pointer')
      channel.onMessage.subscribe((data) => {
        if (!closing && !failed && pc.connectionState === 'connected' && typeof data === 'string') options.onPointer?.(data)
      })
      channel.stateChanged.subscribe((state) => {
        if (state === 'closed' && !closing) options.onPointer?.('{"action":"cancel"}')
      })
    }
    pc.connectionStateChange.subscribe((state) => {
      if (closing || failed) return
      if (state === 'failed') fail()
      if (state === 'disconnected') options.onState('disconnected')
      if (state !== 'connected') return
      if (ready) options.onState('streaming')
      if (encoder) return
      clearTimeout(frameTimer)
      encoder = spawn(options.executable, nativeEncoderArgs(options.target, options.format, port), {
        windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'],
      })
      encoder.stderr?.resume()
      encoder.once('error', fail)
      encoder.once('exit', fail)
      frameTimer = setTimeout(fail, 6500)
    })
    await pc.setLocalDescription(await pc.createOffer())
    options.signal.throwIfAborted()
    const description = pc.localDescription
    if (!description || !/^a=candidate:/m.test(description.sdp)) throw new Error('所选局域网网卡未能建立视频连接。')
    frameTimer = setTimeout(fail, 7500)
    return {
      description,
      get encodedFrames() { return encodedFrames },
      async accept(message: Signal) {
        if (closing || failed) return
        if (message.type === 'answer') {
          await pc.setRemoteDescription({ type: 'answer', sdp: message.description.sdp ?? '' })
          for (const candidate of pendingIce.splice(0)) await pc.addIceCandidate(candidate)
        } else if (message.type === 'ice') {
          if (pc.remoteDescription) await pc.addIceCandidate(message.candidate)
          else pendingIce.push(message.candidate)
        }
      },
      close,
    }
  } catch (error) {
    await close()
    throw error
  }
}

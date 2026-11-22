import type { DisplayRole } from './displays.ts'

export type MediaSignal =
  | { type: 'offer' | 'answer'; description: RTCSessionDescriptionInit }
  | { type: 'ice'; candidate: RTCIceCandidateInit }

export type Signal = (MediaSignal | {
  type: 'viewer-request' | 'viewer-left' | 'approve' | 'reject' | 'approved' | 'rejected'
}) & { id: string }

export interface CaptureSource {
  id: string
  displayId: string
  role: DisplayRole
  name: string
  thumbnail: string
}

export type CaptureMode = 'screen' | 'extension'

export interface NetworkAddress {
  name: string
  address: string
}

export interface ShareInfo {
  viewerUrl: string
  hostUrl: string
  qr: string
}

export interface TabletLink {
  sources(): Promise<CaptureSource[]>
  networks(): Promise<NetworkAddress[]>
  selectSource(id: string, displayId: string, mode: CaptureMode): Promise<void>
  start(address: string, allowTouch: boolean): Promise<ShareInfo>
  stop(): Promise<void>
  remotePointer(command: string): void
  copy(text: string): Promise<void>
  openDisplaySettings(): Promise<void>
  onDisplaysChanged(callback: () => void): void
  onCaptureLost(callback: () => void): void
}

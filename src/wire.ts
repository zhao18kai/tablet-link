import type { DisplayRole } from './displays.ts'

export const SHARE_ENDED = 4000
export const VIEWER_LEAVING = 4001
export const VIEWER_REPLACED = 4002

export type MediaSignal =
  | { type: 'offer' | 'answer'; description: RTCSessionDescriptionInit }
  | { type: 'ice'; candidate: RTCIceCandidateInit }

export type DisplayOrientation = 'landscape' | 'portrait'

export type Signal = (
  | MediaSignal
  | { type: 'viewer-request'; resumed?: boolean }
  | { type: 'approved'; resumeToken?: string; followOrientation?: true }
  | { type: 'orientation'; direction: DisplayOrientation }
  | { type: 'viewer-left' | 'approve' | 'reject' | 'rejected' }
) & { id: string }

export interface CaptureSource {
  id: string
  displayId: string
  role: DisplayRole
  name: string
  thumbnail: string
  canRotate: boolean
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
  start(address: string, allowTouch: boolean, followOrientation: boolean): Promise<ShareInfo>
  stop(): Promise<void>
  remotePointer(command: string): void
  copy(text: string): Promise<void>
  openDisplaySettings(): Promise<void>
  onDisplaysChanged(callback: () => void): void
  onCaptureLost(callback: () => void): void
}

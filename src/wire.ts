export type MediaSignal =
  | { type: 'offer' | 'answer'; description: RTCSessionDescriptionInit }
  | { type: 'ice'; candidate: RTCIceCandidateInit }

export type Signal = (MediaSignal | {
  type: 'viewer-request' | 'viewer-left' | 'approve' | 'reject' | 'approved' | 'rejected'
}) & { id: string }

export interface CaptureSource {
  id: string
  name: string
  thumbnail: string
}

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
  selectSource(id: string): Promise<void>
  start(address: string): Promise<ShareInfo>
  stop(): Promise<void>
  copy(text: string): Promise<void>
}

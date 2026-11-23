import type { DisplayRole, DisplaySide } from './displays.ts'

export const SHARE_ENDED = 4000
export const VIEWER_LEAVING = 4001
export const VIEWER_REPLACED = 4002
export const AUTOMATIC_DISPLAY = 'automatic-display'
export const AUTOMATIC_CAPTURE_EVENT = 'tablet-link-automatic-capture'

export type MediaSignal =
  | { type: 'offer' | 'answer'; description: RTCSessionDescriptionInit }
  | { type: 'ice'; candidate: RTCIceCandidateInit }

export type DisplayOrientation = 'landscape' | 'portrait'
export type ConnectionMode = 'lan' | 'usb'
export type NativeStreamState = 'streaming' | 'disconnected' | 'failed'
export type NativeVideoMode = { width: number; height: number; fps: number }
export type RememberedComputer = { id: string; name: string; token: string }

export type Signal = (
  | MediaSignal
  | { type: 'viewer-request'; resumed?: boolean }
  | { type: 'approved'; resumeToken?: string; followOrientation?: true; connectionMode?: ConnectionMode; rememberedComputer?: RememberedComputer }
  | { type: 'orientation'; direction: DisplayOrientation }
  | { type: 'stream-hud'; visible: boolean }
  | { type: 'viewer-left' | 'approve' | 'reject' | 'rejected' | 'playback-ready' }
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
  mode: ConnectionMode
}

export interface ShareInfo {
  viewerUrl: string
  hostUrl: string
  qr: string
}

export interface TabletLink {
  sources(): Promise<CaptureSource[]>
  automaticDisplayAvailable(): Promise<boolean>
  networks(): Promise<NetworkAddress[]>
  selectSource(id: string, displayId: string, mode: CaptureMode): Promise<void>
  start(address: string, allowTouch: boolean, followOrientation: boolean, mode: ConnectionMode, automatic?: boolean, native?: boolean): Promise<ShareInfo>
  captureAutomaticDisplay(viewer: string, prepareOnly?: boolean): Promise<void>
  captureCurrentDisplay(viewer: string): Promise<void>
  nativeFfmpegConfigured(): Promise<boolean | null>
  chooseNativeFfmpeg(): Promise<boolean>
  createNativeOffer(viewer: string, sizeCap: number, fpsCap: number): Promise<{
    description: RTCSessionDescriptionInit
    mode: NativeVideoMode
  }>
  acceptNativeSignal(message: MediaSignal & { id: string }): Promise<void>
  reconnectNativeViewer(viewer: string): Promise<void>
  nativeEncodedFrames(viewer: string): Promise<number | undefined>
  stop(): Promise<void>
  remotePointer(command: string): void
  copy(text: string): Promise<void>
  openDisplaySettings(): Promise<void>
  openVddDriver(): Promise<void>
  placeDisplay(displayId: string, referenceId: string, side: DisplaySide): Promise<void>
  getVersion(): Promise<string>
  launchAtLogin(enabled?: boolean): Promise<boolean | null>
  startedAtLogin(): Promise<boolean>
  startLoginShare(): Promise<void>
  openProject(): Promise<void>
  onDisplaysChanged(callback: () => void): void
  onCaptureLost(callback: () => void): void
  onDisplayCleanupFailed(callback: () => void): void
  onNativeStreamState(callback: (viewer: string, state: NativeStreamState) => void): void
}

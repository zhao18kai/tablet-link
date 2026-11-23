import { contextBridge, ipcRenderer } from 'electron'
import type { TabletLink } from './wire.ts'

const api: TabletLink = {
  sources: () => ipcRenderer.invoke('sources'),
  automaticDisplayAvailable: () => ipcRenderer.invoke('automatic-display-available'),
  networks: () => ipcRenderer.invoke('networks'),
  selectSource: (id, displayId, mode) => ipcRenderer.invoke('select-source', id, displayId, mode),
  start: (address, allowTouch, followOrientation, mode, automatic, native) => ipcRenderer.invoke('start-share',
    address, allowTouch ? 'touch' : 'view', followOrientation ? 'follow' : 'fixed', mode, automatic ? 'automatic' : native ? 'native' : ''),
  captureAutomaticDisplay: (viewer, prepareOnly) => ipcRenderer.invoke('capture-automatic-display', viewer, prepareOnly ? 'prepare' : ''),
  captureCurrentDisplay: (viewer) => ipcRenderer.invoke('capture-current-display', viewer),
  nativeFfmpegConfigured: () => ipcRenderer.invoke('native-ffmpeg-configured'),
  chooseNativeFfmpeg: () => ipcRenderer.invoke('choose-native-ffmpeg'),
  createNativeOffer: (viewer, sizeCap, fpsCap) => ipcRenderer.invoke('create-native-offer', viewer, String(sizeCap), String(fpsCap)),
  acceptNativeSignal: (message) => ipcRenderer.invoke('accept-native-signal', JSON.stringify(message)),
  reconnectNativeViewer: (viewer) => ipcRenderer.invoke('reconnect-native-viewer', viewer),
  nativeEncodedFrames: (viewer) => ipcRenderer.invoke('native-encoded-frames', viewer),
  stop: () => ipcRenderer.invoke('stop-share'),
  remotePointer: (command) => ipcRenderer.send('remote-pointer', command),
  copy: (text) => ipcRenderer.invoke('copy', text),
  openDisplaySettings: () => ipcRenderer.invoke('open-display-settings'),
  openVddDriver: () => ipcRenderer.invoke('open-vdd-driver'),
  placeDisplay: (displayId, referenceId, side) => ipcRenderer.invoke('place-display', displayId, referenceId, side),
  getVersion: () => ipcRenderer.invoke('app-version'),
  launchAtLogin: (enabled) => ipcRenderer.invoke('launch-at-login', enabled === undefined ? undefined : enabled ? 'on' : 'off'),
  startedAtLogin: () => ipcRenderer.invoke('started-at-login'),
  startLoginShare: () => ipcRenderer.invoke('start-login-share'),
  openProject: () => ipcRenderer.invoke('open-project'),
  onDisplaysChanged: (callback) => { ipcRenderer.on('displays-changed', () => callback()) },
  onCaptureLost: (callback) => { ipcRenderer.on('capture-lost', () => callback()) },
  onDisplayCleanupFailed: (callback) => { ipcRenderer.on('display-cleanup-failed', () => callback()) },
  onNativeStreamState: (callback) => { ipcRenderer.on('native-stream-state', (_event, viewer, state) => callback(viewer, state)) },
}

contextBridge.exposeInMainWorld('tabletLink', api)

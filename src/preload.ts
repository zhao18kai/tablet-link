import { contextBridge, ipcRenderer } from 'electron'
import type { TabletLink } from './wire.ts'

const api: TabletLink = {
  sources: () => ipcRenderer.invoke('sources'),
  networks: () => ipcRenderer.invoke('networks'),
  selectSource: (id, displayId, mode) => ipcRenderer.invoke('select-source', id, displayId, mode),
  start: (address, allowTouch, followOrientation, mode, automatic) => ipcRenderer.invoke('start-share', address, allowTouch ? 'touch' : 'view', followOrientation ? 'follow' : 'fixed', mode, automatic ? 'automatic' : ''),
  captureAutomaticDisplay: (viewer) => ipcRenderer.invoke('capture-automatic-display', viewer),
  stop: () => ipcRenderer.invoke('stop-share'),
  remotePointer: (command) => ipcRenderer.send('remote-pointer', command),
  copy: (text) => ipcRenderer.invoke('copy', text),
  openDisplaySettings: () => ipcRenderer.invoke('open-display-settings'),
  placeDisplay: (displayId, referenceId, side) => ipcRenderer.invoke('place-display', displayId, referenceId, side),
  getVersion: () => ipcRenderer.invoke('app-version'),
  launchAtLogin: (enabled) => ipcRenderer.invoke('launch-at-login', enabled === undefined ? undefined : enabled ? 'on' : 'off'),
  startedAtLogin: () => ipcRenderer.invoke('started-at-login'),
  startLoginShare: () => ipcRenderer.invoke('start-login-share'),
  openProject: () => ipcRenderer.invoke('open-project'),
  onDisplaysChanged: (callback) => { ipcRenderer.on('displays-changed', () => callback()) },
  onCaptureLost: (callback) => { ipcRenderer.on('capture-lost', () => callback()) },
  onDisplayCleanupFailed: (callback) => { ipcRenderer.on('display-cleanup-failed', () => callback()) },
}

contextBridge.exposeInMainWorld('tabletLink', api)

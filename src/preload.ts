import { contextBridge, ipcRenderer } from 'electron'
import type { TabletLink } from './wire.ts'

const api: TabletLink = {
  sources: () => ipcRenderer.invoke('sources'),
  networks: () => ipcRenderer.invoke('networks'),
  selectSource: (id, displayId, mode) => ipcRenderer.invoke('select-source', id, displayId, mode),
  start: (address, allowTouch, followOrientation) => ipcRenderer.invoke('start-share', address, allowTouch ? 'touch' : 'view', followOrientation ? 'follow' : 'fixed'),
  stop: () => ipcRenderer.invoke('stop-share'),
  remotePointer: (command) => ipcRenderer.send('remote-pointer', command),
  copy: (text) => ipcRenderer.invoke('copy', text),
  openDisplaySettings: () => ipcRenderer.invoke('open-display-settings'),
  onDisplaysChanged: (callback) => { ipcRenderer.on('displays-changed', () => callback()) },
  onCaptureLost: (callback) => { ipcRenderer.on('capture-lost', () => callback()) },
}

contextBridge.exposeInMainWorld('tabletLink', api)

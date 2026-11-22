import { contextBridge, ipcRenderer } from 'electron'
import type { TabletLink } from './wire.ts'

const api: TabletLink = {
  sources: () => ipcRenderer.invoke('sources'),
  networks: () => ipcRenderer.invoke('networks'),
  selectSource: (id, displayId, mode) => ipcRenderer.invoke('select-source', id, displayId, mode),
  start: (address) => ipcRenderer.invoke('start-share', address),
  stop: () => ipcRenderer.invoke('stop-share'),
  copy: (text) => ipcRenderer.invoke('copy', text),
  openDisplaySettings: () => ipcRenderer.invoke('open-display-settings'),
  onDisplaysChanged: (callback) => { ipcRenderer.on('displays-changed', () => callback()) },
  onCaptureLost: (callback) => { ipcRenderer.on('capture-lost', () => callback()) },
}

contextBridge.exposeInMainWorld('tabletLink', api)

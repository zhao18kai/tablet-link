import { contextBridge, ipcRenderer } from 'electron'
import type { TabletLink } from './wire.ts'

const api: TabletLink = {
  sources: () => ipcRenderer.invoke('sources'),
  networks: () => ipcRenderer.invoke('networks'),
  selectSource: (id) => ipcRenderer.invoke('select-source', id),
  start: (address) => ipcRenderer.invoke('start-share', address),
  stop: () => ipcRenderer.invoke('stop-share'),
  copy: (text) => ipcRenderer.invoke('copy', text),
}

contextBridge.exposeInMainWorld('tabletLink', api)

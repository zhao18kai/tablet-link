import type { ConnectionMode, NetworkAddress } from './wire.ts'

export interface SavedShare {
  extension: boolean
  displayId: string
  displayName: string
  automatic: boolean
  networkName: string
  address: string
  mode: ConnectionMode
  allowTouch: boolean
  followOrientation: boolean
}

export function readSavedShare(raw: string | null): SavedShare | undefined {
  try {
    const value = JSON.parse(raw ?? 'null') as Partial<SavedShare> | null
    if (value && typeof value.extension === 'boolean' && typeof value.automatic === 'boolean' &&
        typeof value.displayId === 'string' && typeof value.displayName === 'string' &&
        typeof value.networkName === 'string' && typeof value.address === 'string' &&
        (value.mode === 'lan' || value.mode === 'usb') && typeof value.allowTouch === 'boolean' &&
        typeof value.followOrientation === 'boolean') return value as SavedShare
  } catch { /* An unavailable saved configuration can be replaced by the next manual share. */ }
}

export function restoreNetwork(settings: SavedShare, networks: NetworkAddress[]) {
  const adapter = networks.filter(({ name, mode }) => name === settings.networkName && mode === settings.mode)
  return adapter.find(({ address }) => address === settings.address) ?? (adapter.length === 1 ? adapter[0] : undefined)
}

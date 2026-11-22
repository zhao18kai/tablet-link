import { common } from '@kit.AbilityKit'
import { mdns } from '@kit.NetworkKit'
import { computerServiceType, DiscoveredComputer, discoveryComputerId, resolveComputer } from './PairingUrl'

export class ComputerDiscovery {
  private service: mdns.DiscoveryService | null = null
  private readonly resolving: Map<string, mdns.LocalServiceInfo> = new Map()
  private readonly available: Map<string, DiscoveredComputer> = new Map()
  private readonly onChange: (computers: DiscoveredComputer[]) => void
  private readonly onFailure: () => void

  constructor(onChange: (computers: DiscoveredComputer[]) => void, onFailure: () => void) {
    this.onChange = onChange
    this.onFailure = onFailure
  }

  start(context: common.Context, knownIds: Set<string>): void {
    if (this.service || knownIds.size === 0) return
    try {
      const service = mdns.createDiscoveryService(context, computerServiceType)
      this.service = service
      service.on('discoveryStart', (event: mdns.DiscoveryEventInfo) => {
        if (this.service !== service || event.errorCode === undefined) return
        this.stop()
        this.onFailure()
      })
      service.on('serviceFound', (info: mdns.LocalServiceInfo) => {
        const id = discoveryComputerId(info.serviceName)
        if (this.service !== service || !knownIds.has(id) || this.resolving.has(id)) return
        void this.resolve(context, service, id, info)
      })
      service.on('serviceLost', (info: mdns.LocalServiceInfo) => {
        if (this.service !== service) return
        const id = discoveryComputerId(info.serviceName)
        this.resolving.delete(id)
        if (this.available.delete(id)) this.onChange(Array.from(this.available.values()))
      })
      service.startSearchingMDNS()
    } catch {
      this.stop()
      this.onFailure()
    }
  }

  stop(): void {
    const service = this.service
    this.service = null
    this.resolving.clear()
    if (this.available.size > 0) {
      this.available.clear()
      this.onChange([])
    }
    if (!service) return
    try {
      service.stopSearchingMDNS()
    } catch {
      // Discovery may already have stopped after a network change.
    }
    service.off('serviceFound')
    service.off('serviceLost')
    service.off('discoveryStart')
  }

  private async resolve(context: common.Context, service: mdns.DiscoveryService, id: string,
    info: mdns.LocalServiceInfo): Promise<void> {
    this.resolving.set(id, info)
    try {
      const resolved = await mdns.resolveLocalService(context, info)
      if (this.service !== service || this.resolving.get(id) !== info) return
      const txt = resolved.serviceAttribute?.find((attribute: mdns.ServiceAttribute) => attribute.key === 'address')
      const txtAddress = txt && txt.value.length <= 15 ?
        txt.value.map((byte: number) => String.fromCharCode(byte)).join('') : ''
      const computer = resolveComputer(resolved.serviceName, resolved.port ?? 0,
        resolved.host?.address ?? '', txtAddress)
      if (!computer || computer.id !== id) return
      this.available.set(id, computer)
      this.onChange(Array.from(this.available.values()))
    } catch {
      // The service can disappear during resolution. The manual connection remains available.
    } finally {
      if (this.resolving.get(id) === info) this.resolving.delete(id)
    }
  }
}

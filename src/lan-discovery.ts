import { isIPv4 } from 'node:net'
import { getResponder, type CiaoService, type Responder } from '@homebridge/ciao'

export function advertiseShare(address: string, port: number, id: string) {
  if (!isIPv4(address) || !/^(10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.)/.test(address)) return

  let responder: Responder | undefined
  let service: CiaoService | undefined
  let stopping: Promise<void> | undefined
  function stop() {
    return stopping ??= (async () => {
      // Discovery is optional even when the adapter disappears during shutdown.
      await service?.destroy().catch(() => {})
      await responder?.shutdown().catch(() => {})
    })()
  }

  try {
    responder = getResponder({ interface: address, disableIpv6: true })
    service = responder.createService({
      name: `TabletLink-${id}`,
      type: 'tablet-link',
      port,
      restrictedAddresses: [address],
      disabledIpv6: true,
      txt: { address },
    })
    void service.advertise().catch(stop)
  } catch {
    void stop()
  }
  return stop
}

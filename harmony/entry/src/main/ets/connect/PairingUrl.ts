const pairingLink = /^http:\/\/((?:0|[1-9]\d{0,2})(?:\.(?:0|[1-9]\d{0,2})){3}):([1-9]\d{0,4})\/#([\w-]{32})$/
const ipv4Address = /^(?:0|[1-9]\d{0,2})(?:\.(?:0|[1-9]\d{0,2})){3}$/
const computerIdPattern = /^[a-f0-9]{32}$/
const reconnectToken = /^[A-Za-z0-9_-]{32}$/
const serviceNamePattern = /^TabletLink-([a-f0-9]{32})$/i
const historyLimit = 20

export const computerServiceType = '_tablet-link._tcp'

export interface RememberedComputer {
  id: string
  name: string
  token: string
}

export interface DiscoveredComputer {
  id: string
  address: string
  port: number
}

function isPrivateIpv4(candidate: string): boolean {
  if (!ipv4Address.test(candidate)) return false
  const address = candidate.split('.').map((octet: string) => Number(octet))
  if (address.some((octet: number) => octet > 255)) return false
  return address[0] === 10 || (address[0] === 192 && address[1] === 168) ||
    (address[0] === 172 && address[1] >= 16 && address[1] <= 31)
}

function isValidPort(port: number): boolean {
  return Number.isInteger(port) && port > 0 && port <= 65535
}

export function parsePairingUrl(input: string): string {
  const candidate = input.trim()
  const match = pairingLink.exec(candidate)
  if (!match || !isValidPort(Number(match[2]))) return ''
  return isPrivateIpv4(match[1]) ? candidate : ''
}

export function buildReconnectUrl(address: string, port: number, token: string): string {
  if (!isPrivateIpv4(address) || !isValidPort(port) || !reconnectToken.test(token)) return ''
  return `http://${address}:${port}/#${token}.reconnect`
}

export function discoveryComputerId(serviceName: string): string {
  const match = serviceNamePattern.exec(serviceName)
  return match ? match[1].toLowerCase() : ''
}

export function resolveComputer(serviceName: string, port: number, hostAddress: string,
  txtAddress: string): DiscoveredComputer | null {
  const id = discoveryComputerId(serviceName)
  if (!id || !isValidPort(port)) return null
  if (isPrivateIpv4(hostAddress)) return { id, address: hostAddress, port }
  if (isPrivateIpv4(txtAddress)) return { id, address: txtAddress, port }
  return null
}

export function approvedComputer(id: string, name: string, token: string): RememberedComputer | null {
  if (typeof id !== 'string' || !computerIdPattern.test(id) ||
    typeof token !== 'string' || !reconnectToken.test(token) || typeof name !== 'string') return null
  const label = name.trim()
  if (!label || label.length > 255) return null
  return { id, name: label, token }
}

export function rememberComputer(history: RememberedComputer[], computer: RememberedComputer): RememberedComputer[] {
  return [computer, ...history.filter((item: RememberedComputer) => item.id !== computer.id)].slice(0, historyLimit)
}

export function readRememberedComputers(raw: string): RememberedComputer[] {
  const history: RememberedComputer[] = []
  try {
    const saved = JSON.parse(raw) as RememberedComputer[]
    if (!Array.isArray(saved)) return history
    const ids = new Set<string>()
    for (const item of saved) {
      if (!item || typeof item !== 'object') continue
      const computer = approvedComputer(item.id, item.name, item.token)
      if (!computer || ids.has(computer.id)) continue
      ids.add(computer.id)
      history.push(computer)
      if (history.length === historyLimit) break
    }
  } catch {
    // The receiver can still pair by QR code if its saved history is unreadable.
  }
  return history
}

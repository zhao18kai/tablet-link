const pairingLink = /^http:\/\/((?:0|[1-9]\d{0,2})(?:\.(?:0|[1-9]\d{0,2})){3}):([1-9]\d{0,4})\/#([\w-]{32})$/

export function parsePairingUrl(input: string): string {
  const candidate = input.trim()
  const match = pairingLink.exec(candidate)
  if (!match || Number(match[2]) > 65535) return ''

  const address = match[1].split('.').map((octet: string) => Number(octet))
  if (address.some((octet: number) => octet > 255)) return ''
  const privateAddress = address[0] === 10 || (address[0] === 192 && address[1] === 168) ||
    (address[0] === 172 && address[1] >= 16 && address[1] <= 31)
  return privateAddress ? candidate : ''
}

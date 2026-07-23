import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

export const MIN_HTTP_TIMEOUT_MS = 1_000;
export const MAX_HTTP_TIMEOUT_MS = 600_000;

export function clampHttpTimeoutMs(value: unknown, fallback = 300_000): number {
  const candidate = typeof value === 'number' && Number.isFinite(value)
    ? value
    : fallback;
  return Math.min(MAX_HTTP_TIMEOUT_MS, Math.max(MIN_HTTP_TIMEOUT_MS, Math.trunc(candidate)));
}

export function validateHttpTimeoutMs(value: unknown): string | null {
  if (
    typeof value !== 'number'
    || !Number.isInteger(value)
    || value < MIN_HTTP_TIMEOUT_MS
    || value > MAX_HTTP_TIMEOUT_MS
  ) {
    return `timeout_ms must be an integer between ${MIN_HTTP_TIMEOUT_MS} and ${MAX_HTTP_TIMEOUT_MS}.`;
  }
  return null;
}

export function stripTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value.charCodeAt(end - 1) === 47) {
    end -= 1;
  }
  return value.slice(0, end);
}

function isPrivateIpv4(address: string): boolean {
  const octets = address.split('.').map(Number);
  if (octets.length !== 4 || octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return true;
  }

  const [a, b, c] = octets;
  return a === 0
    || a === 10
    || a === 127
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 0 && c === 0)
    || (a === 192 && b === 0 && c === 2)
    || (a === 192 && b === 168)
    || (a === 198 && (b === 18 || b === 19))
    || (a === 198 && b === 51 && c === 100)
    || (a === 203 && b === 0 && c === 113)
    || a >= 224;
}

function ipv6Bytes(address: string): number[] | null {
  let normalized = address.toLowerCase().split('%', 1)[0];
  const dottedTail = normalized.match(/(\d+\.\d+\.\d+\.\d+)$/)?.[1];
  if (dottedTail) {
    const octets = dottedTail.split('.').map(Number);
    if (octets.length !== 4 || octets.some((part) => part < 0 || part > 255)) return null;
    const replacement = `${((octets[0] << 8) | octets[1]).toString(16)}:${((octets[2] << 8) | octets[3]).toString(16)}`;
    normalized = normalized.slice(0, -dottedTail.length) + replacement;
  }

  const halves = normalized.split('::');
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves[1] ? halves[1].split(':') : [];
  const missing = halves.length === 2 ? 8 - left.length - right.length : 0;
  const groups = [...left, ...Array(Math.max(0, missing)).fill('0'), ...right];
  if (groups.length !== 8) return null;

  const bytes: number[] = [];
  for (const group of groups) {
    if (!/^[0-9a-f]{1,4}$/.test(group)) return null;
    const value = Number.parseInt(group, 16);
    bytes.push(value >> 8, value & 0xff);
  }
  return bytes;
}

function isPrivateIpv6(address: string): boolean {
  const bytes = ipv6Bytes(address);
  if (!bytes) return true;

  const isUnspecified = bytes.every((value) => value === 0);
  const isLoopback = bytes.slice(0, 15).every((value) => value === 0) && bytes[15] === 1;
  if (isUnspecified || isLoopback) return true;

  const hasZeroPrefix = bytes.slice(0, 10).every((value) => value === 0);
  const isMappedIpv4 = hasZeroPrefix && bytes[10] === 0xff && bytes[11] === 0xff;
  const isCompatibleIpv4 = bytes.slice(0, 12).every((value) => value === 0);
  if (isMappedIpv4 || isCompatibleIpv4) {
    return isPrivateIpv4(bytes.slice(12).join('.'));
  }

  return (bytes[0] & 0xfe) === 0xfc
    || (bytes[0] === 0xfe && (bytes[1] & 0xc0) === 0x80)
    || bytes[0] === 0xff
    || (bytes[0] === 0x20 && bytes[1] === 0x01 && bytes[2] === 0x0d && bytes[3] === 0xb8);
}

export function isPrivateNetworkAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return isPrivateIpv4(address);
  if (family === 6) return isPrivateIpv6(address);
  return true;
}

export function parseOutboundUrl(rawUrl: string): URL {
  const url = new URL(rawUrl);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('Only http:// and https:// protocols are allowed.');
  }
  if (url.username || url.password) {
    throw new Error('Credentials must not be embedded in provider URLs.');
  }
  return url;
}

export async function assertSafeOutboundUrl(
  rawUrl: string,
  allowPrivateNetwork = false,
): Promise<URL> {
  const url = parseOutboundUrl(rawUrl);
  if (allowPrivateNetwork) return url;

  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (hostname === 'localhost' || hostname.endsWith('.localhost')) {
    throw new Error('Private-network provider URLs require allow_private_network=true.');
  }

  if (isIP(hostname)) {
    if (isPrivateNetworkAddress(hostname)) {
      throw new Error('Private-network provider URLs require allow_private_network=true.');
    }
    return url;
  }

  const addresses = await lookup(hostname, { all: true, verbatim: true });
  if (addresses.length === 0 || addresses.some(({ address }) => isPrivateNetworkAddress(address))) {
    throw new Error('Provider hostname resolves to a private or reserved network address.');
  }
  return url;
}

export async function safeOutboundFetch(
  rawUrl: string,
  init: RequestInit,
  allowPrivateNetwork = false,
): Promise<Response> {
  const validatedUrl = await assertSafeOutboundUrl(rawUrl, allowPrivateNetwork);
  const response = await fetch(validatedUrl, {
    ...init,
    redirect: 'manual',
  });

  if (response.status >= 300 && response.status < 400) {
    throw new Error('HTTP provider redirects are not allowed. Configure the final endpoint URL.');
  }
  return response;
}

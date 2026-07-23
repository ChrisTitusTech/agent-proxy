import { describe, expect, it, vi } from 'vitest';
import {
  assertSafeOutboundUrl,
  clampHttpTimeoutMs,
  isPrivateNetworkAddress,
  parseOutboundUrl,
  safeOutboundFetch,
  stripTrailingSlashes,
  validateHttpTimeoutMs,
} from './outbound-http.js';

describe('outbound HTTP security', () => {
  it.each([
    '127.0.0.1',
    '10.0.0.1',
    '169.254.169.254',
    '172.16.0.1',
    '192.168.1.1',
    '::1',
    'fc00::1',
    'fe80::1',
    '::ffff:127.0.0.1',
    '::ffff:7f00:1',
    '::ffff:c0a8:101',
    '0:0:0:0:0:0:0:1',
  ])('identifies private or reserved address %s', (address) => {
    expect(isPrivateNetworkAddress(address)).toBe(true);
  });

  it.each(['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111'])(
    'allows public address %s',
    (address) => {
      expect(isPrivateNetworkAddress(address)).toBe(false);
    },
  );

  it('rejects unsupported protocols and embedded credentials', () => {
    expect(() => parseOutboundUrl('file:///etc/passwd')).toThrow(/Only http/);
    expect(() => parseOutboundUrl('https://user:pass@example.com')).toThrow(/Credentials/);
  });

  it('blocks localhost unless private-network access is explicitly enabled', async () => {
    await expect(assertSafeOutboundUrl('http://localhost:8080/v1')).rejects.toThrow(
      /allow_private_network=true/,
    );
    await expect(assertSafeOutboundUrl('http://127.0.0.1:8080/v1')).rejects.toThrow(
      /allow_private_network=true/,
    );
    await expect(assertSafeOutboundUrl('http://localhost:8080/v1', true)).resolves.toBeInstanceOf(URL);
  });

  it('disables redirects after validating the destination', async () => {
    const fetchMock = vi.fn(async () => new Response(null, {
      status: 302,
      headers: { location: 'http://127.0.0.1/private' },
    }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(safeOutboundFetch('https://1.1.1.1/v1', {})).rejects.toThrow(/redirects are not allowed/);
    expect(fetchMock).toHaveBeenCalledWith(
      expect.any(URL),
      expect.objectContaining({ redirect: 'manual' }),
    );
    vi.unstubAllGlobals();
  });

  it('clamps and validates timeouts', () => {
    expect(clampHttpTimeoutMs(1)).toBe(1_000);
    expect(clampHttpTimeoutMs(900_000)).toBe(600_000);
    expect(clampHttpTimeoutMs(Number.NaN, 10_000)).toBe(10_000);
    expect(clampHttpTimeoutMs(Number.NaN, 900_000)).toBe(600_000);
    expect(validateHttpTimeoutMs(1_000)).toBeNull();
    expect(validateHttpTimeoutMs(600_001)).toMatch(/between/);
  });

  it('strips trailing slashes in linear time', () => {
    expect(stripTrailingSlashes('https://example.com/v1///')).toBe('https://example.com/v1');
    expect(stripTrailingSlashes('')).toBe('');
  });
});

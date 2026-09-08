import { afterEach, expect, test, vi } from 'vitest';

afterEach(() => { vi.unstubAllEnvs(); vi.resetModules(); });

test('single-host default trusts only loopback', async () => {
  vi.stubEnv('CROWDMOVIE_TRUSTED_PROXIES', undefined);
  vi.resetModules();
  const { TRUSTED_PROXIES } = await import('../src/lib/trusted-proxies');
  expect(TRUSTED_PROXIES).toEqual(['127.0.0.1', '::1']);
});

test('operators can supply an explicit private ingress chain', async () => {
  vi.stubEnv('CROWDMOVIE_TRUSTED_PROXIES', '127.0.0.1, 192.168.10.10,');
  vi.resetModules();
  const { TRUSTED_PROXIES } = await import('../src/lib/trusted-proxies');
  expect(TRUSTED_PROXIES).toEqual(['127.0.0.1', '192.168.10.10']);
});

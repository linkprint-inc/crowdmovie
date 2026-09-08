/** Explicit trusted proxy addresses/CIDRs; configure the actual ingress chain locally.
 * Loopback is the single-host Caddy default. Never trust arbitrary forwarded headers.
 * For a CDN, obtain its current ranges from the provider and configure both Caddy
 * and this process; no operator or public address is embedded in source.
 */
export const TRUSTED_PROXIES: string[] = (
  process.env.CROWDMOVIE_TRUSTED_PROXIES ?? '127.0.0.1,::1'
).split(',').map((value) => value.trim()).filter(Boolean);

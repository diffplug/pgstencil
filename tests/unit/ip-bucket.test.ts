import { test, expect } from 'vitest';
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ipBucket } from '../../packages/auth/src/better-auth-security.ts';

test("ipBucket groups addresses by /64 as Better Auth's own normalizeIP does", async () => {
  // Better Auth's copy of @better-auth/core, the one its limiter runs.
  const betterAuth = realpathSync(
    resolve('packages/auth/node_modules/better-auth'),
  );
  const { normalizeIP } = (await import(
    pathToFileURL(resolve(betterAuth, '../@better-auth/core/dist/utils/ip.mjs'))
      .href
  )) as {
    normalizeIP: (ip: string, options: { ipv6Subnet: number }) => string;
  };
  for (const ip of [
    '192.0.2.1',
    '203.0.113.255',
    '2001:db8::1',
    '2001:DB8:1:2:ffff:ffff:ffff:b',
    '2001:db8:1:2::a',
    'fe80::1',
    '::1',
    '::',
    '::ffff:192.0.2.1',
    '::ffff:c000:201',
    '0:0:0:0:0:ffff:198.51.100.7',
    '2001:0db8:0000:0000:0000:0000:0000:0001',
    '1:2:3:4:5:6:7:8',
    'unknown',
  ])
    expect(ipBucket(ip), ip).toBe(normalizeIP(ip, { ipv6Subnet: 64 }));
});

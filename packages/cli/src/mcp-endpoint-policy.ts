import { spawn } from 'node:child_process';
import { isIP } from 'node:net';

import type { CliCommandDefinition } from './command-registry';

const MAX_URL_BYTES = 2_048;
const MAX_DNS_RESULTS = 16;
const DNS_OBSERVATION_DEADLINE_MS = 3_000;
const MAX_RESOLVER_OUTPUT_BYTES = 16 * 1_024;

const SPECIAL_USE_SUFFIXES = [
  'localhost',
  'local',
  'localdomain',
  'internal',
  'lan',
  'home',
  'home.arpa',
  'corp',
  'svc',
  'cluster.local',
  'onion',
  'alt',
  'test',
  'invalid',
  'example',
  'arpa',
  'example.com',
  'example.net',
  'example.org',
] as const;

// IANA IPv4 Special-Purpose Address Registry, checked 2026-08-25:
// https://www.iana.org/assignments/iana-ipv4-special-registry/
// Broader containing prefixes intentionally cover nested registry entries.
const SPECIAL_PURPOSE_IPV4_CIDRS: readonly (readonly [string, number, string])[] = [
  ['0.0.0.0', 8, 'current network and host'],
  ['10.0.0.0', 8, 'private use'],
  ['100.64.0.0', 10, 'shared address space'],
  ['127.0.0.0', 8, 'loopback'],
  ['169.254.0.0', 16, 'link local'],
  ['172.16.0.0', 12, 'private use'],
  ['192.0.0.0', 24, 'IETF protocol assignments and anycasts'],
  ['192.0.2.0', 24, 'documentation TEST-NET-1'],
  ['192.31.196.0', 24, 'AS112-v4'],
  ['192.52.193.0', 24, 'automatic multicast tunneling'],
  ['192.88.99.0', 24, 'deprecated 6to4 relay and 6a44 anycast'],
  ['192.168.0.0', 16, 'private use'],
  ['192.175.48.0', 24, 'direct delegation AS112 service'],
  ['198.18.0.0', 15, 'benchmarking'],
  ['198.51.100.0', 24, 'documentation TEST-NET-2'],
  ['203.0.113.0', 24, 'documentation TEST-NET-3'],
  ['224.0.0.0', 4, 'multicast'],
  ['240.0.0.0', 4, 'reserved and limited broadcast'],
];

// IANA IPv6 Special-Purpose Address Registry, checked 2026-08-25:
// https://www.iana.org/assignments/iana-ipv6-special-registry/
// The 2000::/3 outer gate below rejects every registry entry outside global
// unicast. These are all registry allocations inside that outer range.
const SPECIAL_PURPOSE_IPV6_CIDRS: readonly (readonly [string, number, string])[] = [
  ['2001::', 23, 'IETF protocol assignments, anycasts, benchmarking, AMT, AS112, ORCHID, and DETs'],
  ['2001:db8::', 32, 'documentation'],
  ['2002::', 16, '6to4'],
  ['2620:4f:8000::', 48, 'direct delegation AS112 service'],
  ['3fff::', 20, 'documentation'],
];

export type ResolvedAddress = {
  address: string;
  family: 4 | 6;
};

export type EndpointResolver = (
  hostname: string,
  options: { signal: AbortSignal },
) => Promise<readonly ResolvedAddress[]>;

export type ValidatedMcpEndpoint = {
  canonicalUrl: string;
  origin: string;
  hostname: string;
  port: number;
  pathname: string;
};

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function hasSpecialUseSuffix(hostname: string): boolean {
  return SPECIAL_USE_SUFFIXES.some(suffix => hostname === suffix || hostname.endsWith(`.${suffix}`));
}

function parseIpv4(address: string): number | null {
  const pieces = address.split('.');
  if (pieces.length !== 4) return null;
  let value = 0;
  for (const piece of pieces) {
    if (!/^\d{1,3}$/.test(piece)) return null;
    const octet = Number(piece);
    if (octet > 255) return null;
    value = value * 256 + octet;
  }
  return value >>> 0;
}

function ipv4InCidr(value: number, base: number, prefix: number): boolean {
  const mask = prefix === 0 ? 0 : (0xffff_ffff << (32 - prefix)) >>> 0;
  return (value & mask) === (base & mask);
}

function isGlobalIpv4(address: string): boolean {
  const value = parseIpv4(address);
  if (value === null) return false;
  return !SPECIAL_PURPOSE_IPV4_CIDRS.some(
    ([base, prefix]) => ipv4InCidr(value, parseIpv4(base)!, prefix),
  );
}

function ipv4TailToHextets(value: string): [string, string] | null {
  const parsed = parseIpv4(value);
  if (parsed === null) return null;
  return [((parsed >>> 16) & 0xffff).toString(16), (parsed & 0xffff).toString(16)];
}

function parseIpv6(address: string): bigint | null {
  const normalized = address.toLowerCase();
  if (normalized.includes('%') || normalized.split('::').length > 2) return null;
  const expandSide = (side: string): string[] | null => {
    if (!side) return [];
    const pieces = side.split(':');
    const last = pieces.at(-1);
    if (last?.includes('.')) {
      const replacement = ipv4TailToHextets(last);
      if (!replacement) return null;
      pieces.splice(-1, 1, ...replacement);
    }
    return pieces.every(piece => /^[0-9a-f]{1,4}$/.test(piece)) ? pieces : null;
  };
  const [leftRaw, rightRaw] = normalized.split('::');
  const left = expandSide(leftRaw ?? '');
  const right = expandSide(rightRaw ?? '');
  if (!left || !right) return null;
  const hasCompression = normalized.includes('::');
  const missing = 8 - left.length - right.length;
  if ((hasCompression && missing < 1) || (!hasCompression && missing !== 0)) return null;
  const pieces = [...left, ...Array.from({ length: missing }, () => '0'), ...right];
  if (pieces.length !== 8) return null;
  return pieces.reduce((value, piece) => (value << 16n) | BigInt(`0x${piece}`), 0n);
}

function ipv6InCidr(value: bigint, base: bigint, prefix: number): boolean {
  const shift = BigInt(128 - prefix);
  return (value >> shift) === (base >> shift);
}

function ipv6Base(address: string): bigint {
  const value = parseIpv6(address);
  if (value === null) throw new Error(`Invalid internal IPv6 CIDR base: ${address}`);
  return value;
}

function isGlobalIpv6(address: string): boolean {
  const value = parseIpv6(address);
  if (value === null) return false;
  // Ordinary global unicast currently occupies 2000::/3. Exclude every IANA
  // special-purpose assignment inside that outer range as listed above.
  if (!ipv6InCidr(value, ipv6Base('2000::'), 3)) return false;
  return !SPECIAL_PURPOSE_IPV6_CIDRS.some(
    ([base, prefix]) => ipv6InCidr(value, ipv6Base(base), prefix),
  );
}

export function isGlobalIpAddress(address: string): boolean {
  // This is deliberately stricter than IANA's Globally Reachable column: MCP
  // endpoints must resolve to ordinary public unicast, never special-purpose
  // service anycasts or protocol allocations that happen to be reachable.
  const family = isIP(address);
  return family === 4 ? isGlobalIpv4(address) : family === 6 ? isGlobalIpv6(address) : false;
}

export function validateMcpEndpointUrl(rawUrl: string): ValidatedMcpEndpoint {
  if (!rawUrl || rawUrl.trim() !== rawUrl) throw new Error('MCP endpoint URL must not have surrounding whitespace');
  if (byteLength(rawUrl) > MAX_URL_BYTES) throw new Error(`MCP endpoint URL exceeds ${MAX_URL_BYTES} bytes`);
  if (/[\u0000-\u001f\u007f]/.test(rawUrl)) throw new Error('MCP endpoint URL contains control characters');
  if (rawUrl.includes('\\')) throw new Error('MCP endpoint URL must not contain backslashes');
  if (/%(?![0-9a-f]{2})/i.test(rawUrl)) throw new Error('MCP endpoint URL contains invalid percent encoding');
  if (/%25/i.test(rawUrl)) throw new Error('MCP endpoint URL must not contain double encoding');
  if (/%(?:2f|5c)/i.test(rawUrl)) throw new Error('MCP endpoint URL must not contain encoded separators');
  if (/%(?:0[0-9a-f]|1[0-9a-f]|7f)/i.test(rawUrl)) throw new Error('MCP endpoint URL contains encoded control characters');
  if (/(?:^|\/)(?:\.{1,2}|%(?:2e)(?:%(?:2e))?)(?:\/|$)/i.test(rawUrl) || /%2e/i.test(rawUrl)) {
    throw new Error('MCP endpoint URL must not contain dot segments');
  }

  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error('MCP endpoint URL must be an absolute URL');
  }
  if (url.protocol !== 'https:') throw new Error('MCP endpoint URL must use HTTPS');
  if (url.username || url.password) throw new Error('MCP endpoint URL must not contain userinfo');
  if (url.search) throw new Error('MCP endpoint URL must not contain a query string');
  if (url.hash) throw new Error('MCP endpoint URL must not contain a fragment');

  const hostname = url.hostname.toLowerCase();
  if (hostname.endsWith('.')) throw new Error('MCP endpoint hostname must not use a trailing dot');
  if (isIP(hostname.replace(/^\[|\]$/g, '')) !== 0) throw new Error('MCP endpoint hostname must not be an IP literal');
  if (!hostname.includes('.')) throw new Error('MCP endpoint hostname must be a fully qualified domain name');
  if (byteLength(hostname) > 253) throw new Error('MCP endpoint hostname exceeds 253 bytes');
  for (const label of hostname.split('.')) {
    if (!label || byteLength(label) > 63 || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label)) {
      throw new Error('MCP endpoint hostname contains an invalid DNS label');
    }
  }
  if (hasSpecialUseSuffix(hostname)) throw new Error('MCP endpoint hostname uses an internal or special-use suffix');

  const port = url.port ? Number(url.port) : 443;
  return {
    canonicalUrl: url.toString(),
    origin: url.origin,
    hostname,
    port,
    pathname: url.pathname,
  };
}

const LOOKUP_CHILD_SOURCE = `
const { lookup } = await import('node:dns/promises');
try {
  const records = await lookup(process.argv[1], { all: true, order: 'verbatim' });
  process.stdout.write(JSON.stringify(records));
} catch {
  process.exitCode = 2;
}
`;

// dns.promises.lookup has no AbortSignal option. Run the one OS-resolver call
// in an isolated child so the CLI can kill and detach it at the observation
// deadline instead of leaving a getaddrinfo request attached to the CLI.
const defaultResolver: EndpointResolver = (hostname, { signal }) => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, ['--eval', LOOKUP_CHILD_SOURCE, hostname], {
    stdio: ['ignore', 'pipe', 'ignore'],
    windowsHide: true,
  });
  let output = '';
  let settled = false;

  const cleanup = () => {
    signal.removeEventListener('abort', onAbort);
  };
  const finish = (action: () => void) => {
    if (settled) return;
    settled = true;
    cleanup();
    action();
  };
  const terminate = () => {
    child.stdout?.destroy();
    if (!child.killed) child.kill(process.platform === 'win32' ? undefined : 'SIGKILL');
    child.unref();
  };
  const onAbort = () => finish(() => {
    terminate();
    reject(signal.reason instanceof Error ? signal.reason : new Error('DNS resolution was aborted'));
  });

  signal.addEventListener('abort', onAbort, { once: true });
  child.once('error', error => finish(() => reject(error)));
  child.stdout?.on('data', chunk => {
    output += String(chunk);
    if (Buffer.byteLength(output) > MAX_RESOLVER_OUTPUT_BYTES) {
      finish(() => {
        terminate();
        reject(new Error('DNS resolver output exceeded its local bound'));
      });
    }
  });
  child.once('close', code => finish(() => {
    if (code !== 0) {
      reject(new Error('DNS resolution failed in the isolated OS-resolver process'));
      return;
    }
    try {
      const records = JSON.parse(output) as unknown;
      if (!Array.isArray(records)) throw new Error('DNS resolver output was not an array');
      resolve(records as ResolvedAddress[]);
    } catch {
      reject(new Error('DNS resolver returned invalid bounded output'));
    }
  }));
  if (signal.aborted) onAbort();
});

async function resolveOnce(
  hostname: string,
  resolver: EndpointResolver,
  deadlineMs: number,
): Promise<ResolvedAddress[]> {
  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const deadlineError = new Error(`DNS resolution exceeded ${deadlineMs}ms observation deadline`);
    const records = await Promise.race([
      resolver(hostname, { signal: controller.signal }),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => {
          controller.abort(deadlineError);
          reject(deadlineError);
        }, deadlineMs);
      }),
    ]);
    if (records.length === 0) throw new Error('DNS resolution returned no addresses');
    if (records.length > MAX_DNS_RESULTS) throw new Error(`DNS resolution returned more than ${MAX_DNS_RESULTS} addresses`);
    const unique = new Map<string, ResolvedAddress>();
    for (const record of records) {
      const detectedFamily = isIP(record.address);
      if (detectedFamily !== record.family || (record.family !== 4 && record.family !== 6)) {
        throw new Error('DNS resolution returned an invalid address record');
      }
      if (!isGlobalIpAddress(record.address)) {
        throw new Error('DNS resolution returned a non-public or special-purpose address');
      }
      unique.set(`${record.family}:${record.address}`, { address: record.address, family: record.family });
    }
    return [...unique.values()].sort((left, right) => left.family - right.family || left.address.localeCompare(right.address));
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function parseResolveFlag(value: string | undefined): boolean {
  if (value === undefined) return false;
  if (value === 'true' || value === '1' || value === 'yes') return true;
  if (value === 'false' || value === '0' || value === 'no') return false;
  throw new Error(`--resolve expects a boolean, received ${value}`);
}

export async function checkMcpEndpoint(
  rawUrl: string,
  options: {
    resolve?: boolean;
    resolver?: EndpointResolver;
    dnsObservationDeadlineMs?: number;
  } = {},
): Promise<Record<string, unknown>> {
  const endpoint = validateMcpEndpointUrl(rawUrl);
  const shouldResolve = options.resolve === true;
  const addresses = shouldResolve
    ? await resolveOnce(
        endpoint.hostname,
        options.resolver ?? defaultResolver,
        options.dnsObservationDeadlineMs ?? DNS_OBSERVATION_DEADLINE_MS,
      )
    : null;
  return {
    ok: true,
    operation: 'mcp_endpoint_check',
    endpoint: {
      origin: endpoint.origin,
      hostname: endpoint.hostname,
      port: endpoint.port,
      pathConfigured: endpoint.pathname !== '/',
    },
    networkObservation: shouldResolve
      ? {
          kind: 'local_dns_only',
          answerCount: addresses!.length,
          addresses,
          observationDeadlineMs: options.dnsObservationDeadlineMs ?? DNS_OBSERVATION_DEADLINE_MS,
          limitation: 'Local DNS results do not prove Hoplite-side resolution, redirect safety, or protection against DNS rebinding. At the deadline, the default CLI resolver kills and detaches its isolated lookup child; this bounds CLI observation, not all underlying OS resolver work.',
        }
      : {
          kind: 'none',
          limitation: 'Hostname syntax was checked without DNS resolution.',
        },
    hopliteRequestSent: false,
    targetHttpRequestSent: false,
    remoteActions: {
      authAnalysis: 'blocked',
      probe: 'blocked',
      reason: 'CLI credential compatibility and Hoplite-side DNS, redirect, and rebinding controls are unverified.',
    },
  };
}

export const mcpEndpointPolicyCommandDefinitions: readonly CliCommandDefinition[] = [
  {
    name: 'mcp-endpoint-check',
    description: 'Validate one HTTPS MCP endpoint locally; optional --resolve performs DNS-only observation',
    transport: 'local',
    run: async ({ positionals, flags }) => {
      if (positionals.length > 0) throw new Error('mcp-endpoint-check accepts URL input only through --url');
      const supportedFlags = new Set(['url', 'resolve']);
      for (const name of flags.keys()) {
        if (!supportedFlags.has(name)) throw new Error(`mcp-endpoint-check does not support --${name}`);
      }
      const rawUrl = flags.get('url');
      if (!rawUrl || rawUrl === 'true') throw new Error('mcp-endpoint-check requires --url <https-url>');
      return checkMcpEndpoint(rawUrl, { resolve: parseResolveFlag(flags.get('resolve')) });
    },
  },
];

import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

export const ORIGIN = 'https://hoplite.sh';
export const MCP = 'https://api.hoplite.sh/mcp';
export const ROOTS = ['/docs/cli', '/docs/factory', '/docs/platform', '/docs/api', '/docs/agent/mcp'];
export const SOURCES = ['/docs/openapi.json', '/docs/platform-openapi.json', '/llms.txt', '/docs/factory-example.mjs'];
const MAX_BYTES = 8 * 1024 * 1024;
export type Snapshot = { formatVersion: 1; hashes: Record<string, string>; cliVersion: string };
export type Fetcher = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
export const hash = (text: string) => createHash('sha256').update(text).digest('hex');
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([key, item]) => JSON.stringify(key) + ':' + canonical(item)).join(',') + '}';
  return JSON.stringify(value);
}

export function docsUrls(xml: string): string[] {
  if (!/<urlset[\s>]/.test(xml) || !xml.includes('</urlset>') || /<!DOCTYPE|<!ENTITY/i.test(xml)) {
    throw new Error('Expected a bounded sitemap urlset');
  }
  const urls = new Set<string>();
  for (const match of xml.matchAll(/<loc>\s*([^<]+?)\s*<\/loc>/g)) {
    const raw = match[1]!;
    // Reject alternate origins, query strings, encoded paths and markup before fetching.
    if (!/^https:\/\/hoplite\.sh\/docs(?:\/[A-Za-z0-9_-]+)*\/?$/.test(raw)) continue;
    urls.add(raw.replace(/\/$/, ''));
  }
  if (!urls.size || urls.size > 1000) throw new Error('Unexpected docs URL count');
  return [...urls].sort();
}
export const selectedPage = (url: string) => ROOTS.some(root => url === ORIGIN + root || url.startsWith(ORIGIN + root + '/'));

async function bounded(response: Response): Promise<string> {
  if (!response.ok || !response.body) throw new Error('Upstream HTTP failure');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BYTES) throw new Error('Upstream body exceeds 8 MiB');
      chunks.push(value);
    }
  } finally { await reader.cancel(); }
  return Buffer.concat(chunks).toString('utf8');
}

async function publicText(path: string, fetcher: Fetcher): Promise<string> {
  const response = await fetcher(ORIGIN + path, {
    headers: { Accept: path.endsWith('.json') ? 'application/json' : path.endsWith('.xml') ? 'application/xml' : path.endsWith('.mjs') ? 'text/javascript' : 'text/markdown' },
    credentials: 'omit', redirect: 'error', signal: AbortSignal.timeout(25_000),
  });
  const text = await bounded(response);
  if (!text.trim() || /^\s*(?:<!doctype html|<html)/i.test(text)) throw new Error('Unexpected upstream document');
  if (path.endsWith('.json')) {
    const spec = JSON.parse(text);
    if (!spec.openapi || !spec.paths) throw new Error('Expected OpenAPI document');
  }
  return text;
}

export async function mcpHash(key: string, fetcher: Fetcher = fetch): Promise<string> {
  const transport = new StreamableHTTPClientTransport(new URL(MCP), {
    requestInit: { headers: { Authorization: 'Bearer ' + key } },
    reconnectionOptions: { maxRetries: 0, initialReconnectionDelay: 1000, maxReconnectionDelay: 1000, reconnectionDelayGrowFactor: 1 },
    fetch: async (url, init) => {
      if (String(url) !== MCP) throw new Error('Unexpected MCP destination');
      const response = await fetcher(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(25_000) });
      // The collector uses request responses, not a long-lived notification stream.
      if (init?.method === 'GET') {
        await response.body?.cancel();
        throw new Error('Notification stream is not collected');
      }
      if (response.status === 202 || response.status === 204) {
        await response.body?.cancel();
        return new Response(null, { status: response.status, headers: response.headers });
      }
      const body = await bounded(response);
      return new Response(body, { status: response.status, headers: response.headers });
    },
  });
  const client = new Client({ name: 'hoplite-toolkit-drift', version: '1.0.0' });
  try {
    await client.connect(transport);
    const tools = new Map<string, unknown>();
    const cursors = new Set<string>();
    let cursor: string | undefined;
    for (let page = 0; page < 20; page++) {
      const result = await client.listTools(cursor ? { cursor } : {}, { timeout: 30_000 });
      for (const tool of result.tools) {
        if (tools.has(tool.name) || tools.size >= 1000) throw new Error('Invalid tool inventory');
        tools.set(tool.name, tool);
      }
      cursor = result.nextCursor;
      if (!cursor) return hash(canonical([...tools.entries()].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([, tool]) => tool)));
      if (cursors.has(cursor)) throw new Error('Repeated MCP cursor');
      cursors.add(cursor);
    }
    throw new Error('MCP page bound exceeded');
  } finally { await client.close(); }
}

export async function collect(previous: Snapshot, options: {
  fetcher?: Fetcher; version: () => Promise<string>; mcpKey?: string;
}): Promise<{ snapshot: Snapshot; mcpSkipped: boolean }> {
  const fetcher = options.fetcher ?? fetch;
  const hashes: Record<string, string> = {};
  for (const source of SOURCES) hashes[ORIGIN + source] = hash(await publicText(source, fetcher));
  const urls = docsUrls(await publicText('/sitemap.xml', fetcher));
  hashes[ORIGIN + '/sitemap.xml#docs-urls'] = hash(urls.join('\n'));
  const pages = [...new Set([...urls.filter(selectedPage), ...ROOTS.map(root => ORIGIN + root)])].sort();
  let index = 0;
  await Promise.all(Array.from({ length: 4 }, async () => {
    while (index < pages.length) {
      const url = pages[index++]!;
      hashes[url] = hash(await publicText(url.slice(ORIGIN.length), fetcher));
    }
  }));
  if (options.mcpKey) hashes[MCP] = await mcpHash(options.mcpKey, fetcher);
  else if (previous.hashes[MCP]) hashes[MCP] = previous.hashes[MCP]!;
  const cliVersion = (await options.version()).trim();
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(cliVersion) || cliVersion.length > 100) {
    throw new Error('Invalid npm version');
  }
  return { snapshot: { formatVersion: 1, hashes: Object.fromEntries(Object.entries(hashes).sort()), cliVersion }, mcpSkipped: !options.mcpKey };
}

export function changes(before: Snapshot, after: Snapshot): string[] {
  const lines: string[] = [];
  for (const key of [...new Set([...Object.keys(before.hashes), ...Object.keys(after.hashes)])].sort()) {
    if (before.hashes[key] !== after.hashes[key]) {
      // Only approved labels and digest values may enter a public issue.
      if (!(key === MCP || key === ORIGIN + '/sitemap.xml#docs-urls' ||
        SOURCES.some(path => key === ORIGIN + path) ||
        (selectedPage(key) && /^https:\/\/hoplite\.sh\/docs(?:\/[A-Za-z0-9_-]+)+$/.test(key)))) throw new Error('Unexpected snapshot URL');
      const digest = (value?: string) => value === undefined ? 'absent' : /^[a-f0-9]{64}$/.test(value) ? value : (() => { throw new Error('Invalid digest'); })();
      lines.push('- ' + key + ': ' + digest(before.hashes[key]) + ' → ' + digest(after.hashes[key]));
    }
  }
  if (before.cliVersion !== after.cliVersion) {
    for (const version of [before.cliVersion, after.cliVersion]) if (version && !/^[0-9A-Za-z.+-]{1,100}$/.test(version)) throw new Error('Invalid version');
    lines.push('- @usehoplite/cli: ' + (before.cliVersion || 'absent') + ' → ' + after.cliVersion);
  }
  return lines;
}

async function main() {
  const args = process.argv.slice(2);
  if (!['--live', '--live --write'].includes(args.join(' '))) throw new Error('Usage: bun scripts/check-upstream-drift.ts --live [--write]');
  const path = fileURLToPath(new URL('../docs/upstream-snapshot.json', import.meta.url));
  const previous: Snapshot = JSON.parse(await readFile(path, 'utf8'));
  if (previous.formatVersion !== 1) throw new Error('Unsupported snapshot');
  const { snapshot, mcpSkipped } = await collect(previous, {
    mcpKey: process.env.HOPLITE_DRIFT_MCP_KEY,
    version: async () => {
      const process = Bun.spawn(['npm', 'view', '@usehoplite/cli', 'version', '--fetch-retries=0', '--fetch-timeout=25000'], { stdout: 'pipe', stderr: 'ignore', timeout: 30_000 });
      const output = await bounded(new Response(process.stdout));
      if (await process.exited !== 0) throw new Error('npm version query failed');
      return output;
    },
  });
  const diff = changes(previous, snapshot);
  const fingerprint = hash(canonical(snapshot));
  const summary = '# Upstream drift ' + fingerprint.slice(0, 16) + '\n\n' +
    'Snapshot-only refresh. Review upstream changes separately; no client, policy, dependency, or contract-pin changes. Never auto-merge.\n\n' +
    (mcpSkipped ? 'MCP skipped: optional HOPLITE_DRIFT_MCP_KEY absent; previous hash retained.\n\n' : 'MCP inventory checked (schemas only; no tools called).\n\n') +
    diff.slice(0, 150).join('\n') + (diff.length > 150 ? '\nAdditional changes are in the snapshot diff.' : '') + '\n';
  console.log(summary);
  if (args.includes('--write')) {
    if (diff.length) await writeFile(path, JSON.stringify(snapshot, null, 2) + '\n');
    if (process.env.GITHUB_OUTPUT) {
      await writeFile(process.env.GITHUB_OUTPUT, 'changed=' + Boolean(diff.length) + '\nfingerprint=' + fingerprint + '\n', { flag: 'a' });
    }
    await writeFile('upstream-drift-summary.md', summary);
  } else if (diff.length) process.exitCode = 1;
}
if (import.meta.main) main().catch(() => {
  console.error('Upstream collection failed; no snapshot refresh published. Check connectivity, source formats, or optional MCP credential. Response bodies and credentials suppressed.');
  process.exitCode = 1;
});

import { describe, expect, test } from 'bun:test';
import { canonical, changes, collect, docsUrls, hash, MCP, mcpHash, ORIGIN, ROOTS, selectedPage, type Snapshot, type Fetcher } from '../../../scripts/check-upstream-drift';

const empty: Snapshot = { formatVersion: 1, hashes: {}, cliVersion: '' };
const xml = '<urlset><url><loc>https://hoplite.sh/docs/cli</loc></url><url><loc>https://hoplite.sh/docs/cli/fixture</loc></url></urlset>';
const fixtureFetch = (overrides: Record<string, string> = {}) => (async (input: string | URL | Request, init?: RequestInit) => {
  const url = String(input);
  expect(url.startsWith(ORIGIN + '/')).toBe(true);
  expect(init?.redirect).toBe('error');
  const path = url.slice(ORIGIN.length);
  if (path === '/sitemap.xml') return new Response(overrides[path] ?? xml);
  if (path.endsWith('.json')) return Response.json({ openapi: '3.1.0', paths: {} });
  expect(new Headers(init?.headers).get('Accept')).toBe('text/markdown');
  return new Response(overrides[path] ?? '# Obvious offline fixture');
}) as Fetcher;

describe('upstream drift (offline fixtures only)', () => {
  test('sitemap inventory is sorted, deduplicated, origin restricted and independent of lastmod', () => {
    expect(docsUrls(xml)).toEqual([ORIGIN + '/docs/cli', ORIGIN + '/docs/cli/fixture']);
    expect(docsUrls(xml.replace('</url>', '<lastmod>fixture</lastmod></url>'))).toEqual(docsUrls(xml));
    expect(docsUrls(xml.replace('</urlset>', '<loc>https://evil.invalid/docs/cli</loc><loc>https://hoplite.sh/docs/cli?secret=fixture</loc></urlset>'))).toEqual(docsUrls(xml));
    expect(() => docsUrls('<sitemapindex/>')).toThrow();
    expect(() => docsUrls('<urlset></urlset>')).toThrow();
    expect(selectedPage(ORIGIN + '/docs/cliff')).toBe(false);
    expect(selectedPage(ORIGIN + '/docs/agent/mcp')).toBe(true);
  });

  test('collects public sources and roots, retains skipped MCP, detects changes and deletions', async () => {
    const first = await collect(empty, { fetcher: fixtureFetch(), version: async () => '3.0.0\n' });
    expect(first.mcpSkipped).toBe(true);
    expect(first.snapshot.hashes).not.toHaveProperty(MCP);
    for (const root of ROOTS) expect(first.snapshot.hashes[ORIGIN + root]).toBe(hash('# Obvious offline fixture'));
    const second = await collect(first.snapshot, { fetcher: fixtureFetch(), version: async () => '3.0.0' });
    expect(changes(first.snapshot, second.snapshot)).toEqual([]);
    first.snapshot.hashes[MCP] = hash('fixture tool schema');
    const updated = await collect(first.snapshot, {
      fetcher: fixtureFetch({ '/docs/cli': '# Changed fixture', '/sitemap.xml': '<urlset><loc>https://hoplite.sh/docs/cli</loc></urlset>' }),
      version: async () => '3.0.1',
    });
    expect(updated.snapshot.hashes[MCP]).toBe(first.snapshot.hashes[MCP]);
    const diff = changes(first.snapshot, updated.snapshot);
    expect(diff).toHaveLength(4);
    expect(diff.some(line => line.includes('/docs/cli/fixture:') && line.endsWith('absent'))).toBe(true);
    expect(diff.join('\n')).not.toContain('Changed fixture');
  });

  test('fails closed on unavailable, oversized, HTML, and malformed sources or npm output', async () => {
    for (const response of [new Response('fixture secret', { status: 503 }), new Response('x'.repeat(8 * 1024 * 1024 + 1)), new Response('<html>fixture</html>'), new Response('{}')]) {
      await expect(collect(empty, { fetcher: (async () => response) as Fetcher, version: async () => '3.0.0' })).rejects.toThrow();
    }
    await expect(collect(empty, { fetcher: fixtureFetch(), version: async () => 'fixture secret\nextra' })).rejects.toThrow('Invalid npm version');
    expect(empty.hashes).toEqual({});
  });

  test('canonical object keys are stable and summaries reject untrusted labels or digests', () => {
    expect(canonical({ b: 2, a: 1 })).toBe(canonical({ a: 1, b: 2 }));
    expect(() => changes(empty, { ...empty, hashes: { 'fixture-secret-url': hash('x') } })).toThrow();
    expect(() => changes(empty, { ...empty, hashes: { [ORIGIN + '/docs/cli']: 'fixture-secret' } })).toThrow();
  });

  test('MCP performs initialization and paginated tools/list only, without leaking key or metadata', async () => {
    const methods: string[] = [];
    const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe(MCP);
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer fixture-key');
      expect(init?.redirect).toBe('error');
      const body = JSON.parse(String(init?.body));
      methods.push(body.method);
      if (body.method === 'notifications/initialized') return new Response(null, { status: 202 });
      const result = body.method === 'initialize'
        ? { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1' } }
        : body.params?.cursor
          ? { tools: [{ name: 'fixture_b', inputSchema: { type: 'object' } }] }
          : { tools: [{ name: 'fixture_a', inputSchema: { type: 'object' } }], nextCursor: 'fixture-cursor' };
      return Response.json({ jsonrpc: '2.0', id: body.id, result });
    }) as Fetcher;
    const digest = await mcpHash('fixture-key', fetcher);
    expect(digest).toMatch(/^[a-f0-9]{64}$/);
    expect(methods).toEqual(['initialize', 'notifications/initialized', 'tools/list', 'tools/list']);
    expect(digest).not.toContain('fixture');
  });

  test('MCP failures do not become skipped checks or trigger retries', async () => {
    let calls = 0;
    await expect(mcpHash('fixture-key', (async () => { calls++; return new Response('fixture-secret', { status: 401 }); }) as Fetcher)).rejects.toThrow();
    expect(calls).toBe(1);
  });
});

import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

export const HOSTED_MCP_URL = 'https://api.hoplite.sh/mcp';
type Fetcher = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export function mcpApiKey(env: Record<string, string | undefined> = process.env): string | undefined {
  const key = env.HOPLITE_API_KEY;
  if (key === undefined) return undefined;
  if (!/^hop_(?:svc_)?[A-Za-z0-9_-]+$/.test(key) || key.length > 4096) {
    throw new Error('HOPLITE_API_KEY must be a hop_ or hop_svc_ API key; unset it to use OAuth');
  }
  return key;
}

export function hostedTransport(authorization: string, fetcher: Fetcher = fetch): StreamableHTTPClientTransport {
  return new StreamableHTTPClientTransport(new URL(HOSTED_MCP_URL), {
    requestInit: { headers: { Authorization: authorization } },
    reconnectionOptions: { maxRetries: 0, initialReconnectionDelay: 1000, maxReconnectionDelay: 1000, reconnectionDelayGrowFactor: 1 },
    fetch: async (url, init) => {
      if (String(url) !== HOSTED_MCP_URL) throw new Error('Unexpected MCP endpoint');
      // This command client consumes POST responses, not unsolicited server streams.
      if (init?.method === 'GET') return new Response(null, { status: 405 });
      const signal = AbortSignal.any([AbortSignal.timeout(20_000), ...(init?.signal ? [init.signal] : [])]);
      const response = await fetcher(url, { ...init, redirect: 'error', credentials: 'omit', signal });
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error('MCP HTTP request failed');
      }
      if (response.status === 202 || response.status === 204) {
        await response.body?.cancel();
        return new Response(null, { status: response.status, headers: response.headers });
      }
      if (!response.body) throw new Error('Empty MCP response');
      const chunks: Uint8Array[] = [];
      let bytes = 0;
      const reader = response.body.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          bytes += value.byteLength;
          if (bytes > 2 * 1024 * 1024) throw new Error('MCP response exceeds 2 MiB');
          chunks.push(value);
        }
      } finally { await reader.cancel(); }
      return new Response(Buffer.concat(chunks), { status: response.status, headers: response.headers });
    },
  });
}

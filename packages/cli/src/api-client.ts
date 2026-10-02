export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export type HopliteApiCredentials = {
  key: string;
  baseUrl: string;
  orgId?: string;
};

export type HopliteApiRequest = {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD';
  path: string;
  query?: Record<string, unknown>;
  body?: unknown;
  idempotencyKey?: string;
};

export type ApiRequest = HopliteApiRequest;

export type HopliteApiResponse = {
  ok: boolean;
  status: number;
  body: unknown;
  operationId: string | null;
  requestId: string | null;
};

const TIMEOUT_MS = 20_000;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD']);

class TransportError extends Error {}

function validatedOrigin(value: string): string {
  try {
    if (!/^https:\/\/[^/?#@\\\s]+\/?$/i.test(value)) throw new Error();
    const url = new URL(value);
    if (url.protocol !== 'https:' || !url.hostname || url.username || url.password
      || url.pathname !== '/' || url.search || url.hash) throw new Error();
    return url.origin;
  } catch {
    throw new Error('Hoplite API base URL must be an HTTPS origin');
  }
}

function validatedHeader(value: string): string {
  if (typeof value !== 'string' || !/^[\x21-\x7e]+$/.test(value)) {
    throw new Error('Invalid Hoplite API credential or request header');
  }
  return value;
}

function validatedPath(path: string): string {
  try {
    if (!path.startsWith('/api/') || /[\s\\?#\u0000-\u001f\u007f]/.test(path)
      || path.includes('//') || /%(?:2e|2f|5c|25|3f|23)/i.test(path)
      || path.split('/').some(segment => segment === '.' || segment === '..')) {
      throw new Error();
    }
    decodeURIComponent(path);
    if (new URL(path, 'https://fixture.invalid').pathname !== path) throw new Error();
    return path;
  } catch {
    throw new Error('Hoplite API path must be a safe /api/ path');
  }
}

async function readJsonBody(response: Response, signal: AbortSignal): Promise<unknown> {
  if (!response.body) return null;
  const reader = response.body.getReader();
  const cancel = () => { void reader.cancel().catch(() => undefined); };
  signal.addEventListener('abort', cancel, { once: true });
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    if (signal.aborted) {
      cancel();
      throw new TransportError('Hoplite API request timed out');
    }
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) {
        cancel();
        throw new TransportError('Hoplite API response exceeded the size limit');
      }
      chunks.push(value);
    }
    if (size === 0) return null;
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    try {
      return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    } catch {
      throw new TransportError('Hoplite API response was not valid JSON');
    }
  } finally {
    signal.removeEventListener('abort', cancel);
    reader.releaseLock();
  }
}

function bodyId(body: unknown, field: string): string | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const value = (body as Record<string, unknown>)[field];
  return typeof value === 'string' ? value : null;
}

// Internal transport: callers enforce mutation gates and sanitize returned output.
export class HopliteApiClient {
  readonly #origin: string;
  readonly #key: string;
  readonly #orgId?: string;
  readonly #fetcher: FetchLike;

  constructor(credentials: HopliteApiCredentials, fetcher: FetchLike = fetch) {
    this.#origin = validatedOrigin(credentials.baseUrl);
    this.#key = validatedHeader(credentials.key);
    this.#orgId = credentials.orgId === undefined ? undefined : validatedHeader(credentials.orgId);
    this.#fetcher = fetcher;
  }

  async request(request: HopliteApiRequest): Promise<HopliteApiResponse> {
    if (!METHODS.has(request.method)) throw new Error('Unsupported Hoplite API method');
    const url = new URL(validatedPath(request.path), this.#origin);
    if ((request.method === 'GET' || request.method === 'HEAD') && request.body !== undefined) {
      throw new Error('Read-only Hoplite API requests cannot include a body');
    }
    const headers = new Headers({ Authorization: `Bearer ${this.#key}`, Accept: 'application/json' });
    if (this.#orgId !== undefined) headers.set('x-hoplite-org-id', this.#orgId);
    if (request.idempotencyKey !== undefined) {
      headers.set('Idempotency-Key', validatedHeader(request.idempotencyKey));
    }
    let body: string | undefined;
    try {
      for (const [name, value] of Object.entries(request.query ?? {})) {
        if (value !== undefined && value !== null) url.searchParams.set(name, String(value));
      }
      if (request.body !== undefined) {
        body = JSON.stringify(request.body);
        if (body === undefined) throw new Error();
        headers.set('Content-Type', 'application/json');
      }
    } catch {
      throw new Error('Invalid Hoplite API request data');
    }

    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(new TransportError('Hoplite API request timed out'));
        controller.abort();
      }, TIMEOUT_MS);
    });
    try {
      const work = async (): Promise<HopliteApiResponse> => {
        const response = await this.#fetcher(url, {
          method: request.method,
          headers,
          body,
          signal: controller.signal,
          redirect: 'error',
        });
        const parsed = await readJsonBody(response, controller.signal);
        return {
          ok: response.ok,
          status: response.status,
          body: parsed,
          operationId: response.headers.get('x-hoplite-operation-id')
            ?? response.headers.get('x-operation-id') ?? bodyId(parsed, 'operationId'),
          requestId: response.headers.get('x-request-id')
            ?? response.headers.get('x-hoplite-request-id') ?? bodyId(parsed, 'requestId'),
        };
      };
      return await Promise.race([work(), deadline]);
    } catch (error) {
      controller.abort();
      if (error instanceof TransportError) throw error;
      throw new Error('Hoplite API request failed');
    } finally {
      clearTimeout(timer);
    }
  }
}

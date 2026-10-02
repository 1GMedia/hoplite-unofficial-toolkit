import { describe, expect, mock, spyOn, test } from 'bun:test';

import { HopliteApiClient, type FetchLike, type HopliteApiRequest } from './api-client';

const CREDENTIALS = {
  key: 'fixture_api_key_not_a_real_secret',
  baseUrl: 'https://api.fixture.invalid',
};
const encoder = new TextEncoder();

function streamedResponse(chunks: Uint8Array[], cancel?: () => void): Response {
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
    cancel,
  }));
}

describe('internal Hoplite API transport (offline fixtures)', () => {
  test('sends credentials, encoded query values and disables redirects', async () => {
    const fetcher = mock<FetchLike>(async () => Response.json({ items: ['fixture'] }));
    const client = new HopliteApiClient({ ...CREDENTIALS, orgId: 'org_fixture' }, fetcher);
    const result = await client.request({
      method: 'GET', path: '/api/projects',
      query: { search: 'fixture & # /?', limit: 10, enabled: false, skip: undefined, absent: null },
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [input, init] = fetcher.mock.calls[0]!;
    const url = new URL(String(input));
    expect(url.origin).toBe(CREDENTIALS.baseUrl);
    expect(url.pathname).toBe('/api/projects');
    expect(Object.fromEntries(url.searchParams)).toEqual({ search: 'fixture & # /?', limit: '10', enabled: 'false' });
    const headers = new Headers(init?.headers);
    expect(headers.get('Authorization')).toBe(`Bearer ${CREDENTIALS.key}`);
    expect(headers.get('x-hoplite-org-id')).toBe('org_fixture');
    expect(headers.get('Idempotency-Key')).toBeNull();
    expect(headers.get('Content-Type')).toBeNull();
    expect(init?.redirect).toBe('error');
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    expect(result).toEqual({ ok: true, status: 200, body: { items: ['fixture'] }, operationId: null, requestId: null });
  });

  test('serializes JSON and forwards only an explicitly supplied idempotency key', async () => {
    const fetcher = mock<FetchLike>(async () => Response.json({ operationId: 'op_fixture' }, {
      status: 201, headers: { 'x-request-id': 'req_fixture' },
    }));
    const client = new HopliteApiClient(CREDENTIALS, fetcher);
    const result = await client.request({
      method: 'POST', path: '/api/threads', body: { prompt: 'fixture prompt' }, idempotencyKey: 'fixture-create-001',
    });
    const init = fetcher.mock.calls[0]![1]!;
    const headers = new Headers(init.headers);
    expect(init.body).toBe('{"prompt":"fixture prompt"}');
    expect(headers.get('Content-Type')).toBe('application/json');
    expect(headers.get('Idempotency-Key')).toBe('fixture-create-001');
    expect(headers.get('x-hoplite-org-id')).toBeNull();
    expect(result.operationId).toBe('op_fixture');
    expect(result.requestId).toBe('req_fixture');
    expect(result.status).toBe(201);
  });

  test('prefers response metadata headers and preserves unsanitized JSON for its caller', async () => {
    const payload = { operationId: 'op_body_fixture', requestId: 'req_body_fixture', token: 'fixture_sensitive_output' };
    const client = new HopliteApiClient(CREDENTIALS, async () => Response.json(payload, {
      headers: { 'x-hoplite-operation-id': 'op_header_fixture', 'x-request-id': 'req_header_fixture' },
    }));
    expect(await client.request({ method: 'GET', path: '/api/fixture' })).toEqual({
      ok: true, status: 200, body: payload, operationId: 'op_header_fixture', requestId: 'req_header_fixture',
    });
  });

  test('supports every typed method without implementing caller authorization policy', async () => {
    const fetcher = mock<FetchLike>(async () => new Response(null, { status: 204 }));
    const client = new HopliteApiClient(CREDENTIALS, fetcher);
    for (const method of ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'] as const) {
      expect((await client.request({ method, path: '/api/fixture' })).body).toBeNull();
      expect(fetcher.mock.calls.at(-1)![1]?.method).toBe(method);
    }
    expect(fetcher).toHaveBeenCalledTimes(6);
  });

  test('rejects invalid origins without disclosing their contents', () => {
    const fetcher = mock<FetchLike>(async () => Response.json({}));
    for (const baseUrl of [
      'http://api.fixture.invalid', 'https://user:fixture_password@api.fixture.invalid',
      'https://@api.fixture.invalid', 'https://api.fixture.invalid/api',
      'https://api.fixture.invalid/../', 'https://api.fixture.invalid//',
      'https://api.fixture.invalid?query=fixture', 'https://api.fixture.invalid#fragment',
      'https://api.fixture.invalid\\', ' https://api.fixture.invalid', 'not-a-url',
    ]) {
      expect(() => new HopliteApiClient({ ...CREDENTIALS, baseUrl }, fetcher))
        .toThrow('Hoplite API base URL must be an HTTPS origin');
    }
    expect(fetcher).not.toHaveBeenCalled();
    expect(() => new HopliteApiClient({ ...CREDENTIALS, baseUrl: 'https://api.fixture.invalid:8443/' }, fetcher)).not.toThrow();
  });

  test('rejects unsafe paths before issuing any request', async () => {
    const fetcher = mock<FetchLike>(async () => Response.json({}));
    const client = new HopliteApiClient(CREDENTIALS, fetcher);
    for (const path of [
      '/not-api/fixture', '/api', '//other.fixture.invalid/api/fixture', 'https://other.fixture.invalid/api/fixture',
      '/api/../secret', '/api/./fixture', '/api/fixture/..', '/api/%2e%2E/secret',
      '/api/fixture%2Fsecret', '/api/fixture%5csecret', '/api/%252e%252e/secret',
      '/api/fixture?query=1', '/api/fixture#hash', '/api/fixture\\secret', '/api//fixture',
      '/api/fixture\n', '/api/%', '/api/%GG', '/api/fixture%3fquery', '/api/fixture%23hash',
    ]) {
      await expect(client.request({ method: 'GET', path })).rejects.toThrow('Hoplite API path must be a safe /api/ path');
    }
    expect(fetcher).not.toHaveBeenCalled();
    await client.request({ method: 'GET', path: '/api/fixture-name.json' });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  test('rejects invalid headers, methods and request bodies locally', async () => {
    const fetcher = mock<FetchLike>(async () => Response.json({}));
    expect(() => new HopliteApiClient({ ...CREDENTIALS, key: '' }, fetcher)).toThrow('Invalid Hoplite API');
    expect(() => new HopliteApiClient({ ...CREDENTIALS, key: 'fixture\r\nInjected: header' }, fetcher)).toThrow('Invalid Hoplite API');
    expect(() => new HopliteApiClient({ ...CREDENTIALS, orgId: 'fixture\norg' }, fetcher)).toThrow('Invalid Hoplite API');
    const client = new HopliteApiClient(CREDENTIALS, fetcher);
    await expect(client.request({ method: 'POST', path: '/api/fixture', idempotencyKey: '' })).rejects.toThrow('Invalid Hoplite API');
    for (const method of ['GET', 'HEAD'] as const) {
      await expect(client.request({ method, path: '/api/fixture', body: {} })).rejects.toThrow('cannot include a body');
    }
    await expect(client.request({ method: 'TRACE' as HopliteApiRequest['method'], path: '/api/fixture' })).rejects.toThrow('Unsupported');
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    await expect(client.request({ method: 'POST', path: '/api/fixture', body: cyclic })).rejects.toThrow('Invalid Hoplite API request data');
    expect(fetcher).not.toHaveBeenCalled();
  });

  test('never retries a network rejection or exposes the original error', async () => {
    const fetcher = mock<FetchLike>(async () => { throw new Error(`fixture network failure ${CREDENTIALS.key}`); });
    const client = new HopliteApiClient(CREDENTIALS, fetcher);
    const error = await client.request({ method: 'POST', path: '/api/fixture', body: {} }).catch(error => error);
    expect(error.message).toBe('Hoplite API request failed');
    expect(error.cause).toBeUndefined();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  test('returns HTTP failures as structured results without retries', async () => {
    for (const status of [401, 429, 500, 503]) {
      const fetcher = mock<FetchLike>(async () => Response.json({ error: 'fixture failure' }, { status }));
      const client = new HopliteApiClient(CREDENTIALS, fetcher);
      expect(await client.request({ method: 'POST', path: '/api/fixture' })).toEqual({
        ok: false, status, body: { error: 'fixture failure' }, operationId: null, requestId: null,
      });
      expect(fetcher).toHaveBeenCalledTimes(1);
    }
  });

  test('returns null for an empty streamed body and parses split UTF-8 JSON', async () => {
    const bytes = encoder.encode('{"fixture":"🌱"}');
    const client = new HopliteApiClient(CREDENTIALS, async () => streamedResponse([
      bytes.slice(0, 14), bytes.slice(14),
    ]));
    expect((await client.request({ method: 'GET', path: '/api/fixture' })).body).toEqual({ fixture: '🌱' });
    const empty = new HopliteApiClient(CREDENTIALS, async () => streamedResponse([]));
    expect((await empty.request({ method: 'GET', path: '/api/fixture' })).body).toBeNull();
  });

  test('enforces the byte limit during streaming, even without Content-Length', async () => {
    const limit = 2 * 1024 * 1024;
    const exact = encoder.encode(`"${'x'.repeat(limit - 2)}"`);
    const client = new HopliteApiClient(CREDENTIALS, async () => streamedResponse([exact]));
    expect(String((await client.request({ method: 'GET', path: '/api/fixture' })).body).length).toBe(limit - 2);
    let canceled = false;
    const fetcher = mock<FetchLike>(async () => new Response(new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(exact); controller.enqueue(encoder.encode(' ')); },
      cancel() { canceled = true; },
    }), { headers: { 'Content-Length': '1' } }));
    const oversized = new HopliteApiClient(CREDENTIALS, fetcher);
    await expect(oversized.request({ method: 'GET', path: '/api/fixture' })).rejects.toThrow('exceeded the size limit');
    expect(canceled).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  test('does not leak malformed JSON or stream errors', async () => {
    for (const response of [
      new Response(`fixture invalid JSON ${CREDENTIALS.key}`),
      streamedResponse([new Uint8Array([0xff])]),
    ]) {
      const client = new HopliteApiClient(CREDENTIALS, async () => response);
      await expect(client.request({ method: 'GET', path: '/api/fixture' })).rejects.toThrow('Hoplite API response was not valid JSON');
    }
    const broken = new HopliteApiClient(CREDENTIALS, async () => new Response(new ReadableStream({
      start(controller) { controller.error(new Error(`fixture stream error ${CREDENTIALS.key}`)); },
    })));
    await expect(broken.request({ method: 'GET', path: '/api/fixture' })).rejects.toThrow('Hoplite API request failed');
  });

  test('times out an uncooperative fetch after exactly 20 seconds without retrying', async () => {
    let expire: (() => void) | undefined;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    const nativeSetTimeout = globalThis.setTimeout;
    const nativeClearTimeout = globalThis.clearTimeout;
    const timer = spyOn(globalThis, 'setTimeout').mockImplementation(((callback: () => void, delay?: number, ...args: unknown[]) => {
      const handle = nativeSetTimeout(callback, delay, ...args);
      if (delay === 20_000) {
        expire = callback;
        deadline = handle as ReturnType<typeof setTimeout>;
      }
      return handle;
    }) as typeof setTimeout);
    const clear = spyOn(globalThis, 'clearTimeout').mockImplementation(nativeClearTimeout);
    try {
      let signal: AbortSignal | undefined;
      const fetcher = mock<FetchLike>((_, init) => {
        signal = init?.signal ?? undefined;
        return new Promise(() => undefined);
      });
      const request = new HopliteApiClient(CREDENTIALS, fetcher).request({ method: 'POST', path: '/api/fixture' });
      const rejection = request.catch(error => error);
      expect(timer.mock.calls.filter(([, delay]) => delay === 20_000)).toHaveLength(1);
      expect(signal?.aborted).toBe(false);
      expire!();
      expect((await rejection).message).toBe('Hoplite API request timed out');
      expect(signal?.aborted).toBe(true);
      expect(fetcher).toHaveBeenCalledTimes(1);
      expect(clear).toHaveBeenCalledWith(deadline);
    } finally {
      nativeClearTimeout(deadline);
      timer.mockRestore();
      clear.mockRestore();
    }
  });

  test('uses the same deadline for fetch and body streaming and cancels a stalled body', async () => {
    let expire: (() => void) | undefined;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    const nativeSetTimeout = globalThis.setTimeout;
    const nativeClearTimeout = globalThis.clearTimeout;
    const timer = spyOn(globalThis, 'setTimeout').mockImplementation(((callback: () => void, delay?: number, ...args: unknown[]) => {
      const handle = nativeSetTimeout(callback, delay, ...args);
      if (delay === 20_000) {
        expire = callback;
        deadline = handle as ReturnType<typeof setTimeout>;
      }
      return handle;
    }) as typeof setTimeout);
    const clear = spyOn(globalThis, 'clearTimeout').mockImplementation(nativeClearTimeout);
    try {
      let canceled = false;
      let deliver: ((response: Response) => void) | undefined;
      const fetcher = mock<FetchLike>(() => new Promise(resolve => { deliver = resolve; }));
      const request = new HopliteApiClient(CREDENTIALS, fetcher).request({ method: 'GET', path: '/api/fixture' });
      const rejection = request.catch(error => error);
      deliver!(new Response(new ReadableStream<Uint8Array>({
        start(controller) { controller.enqueue(encoder.encode('{')); },
        cancel() { canceled = true; },
      })));
      await Promise.resolve();
      await Promise.resolve();
      expect(timer.mock.calls.filter(([, delay]) => delay === 20_000)).toHaveLength(1);
      expect(canceled).toBe(false);
      expire!();
      expect((await rejection).message).toBe('Hoplite API request timed out');
      expect(canceled).toBe(true);
      expect(fetcher).toHaveBeenCalledTimes(1);
      expect(clear).toHaveBeenCalledWith(deadline);
    } finally {
      nativeClearTimeout(deadline);
      timer.mockRestore();
      clear.mockRestore();
    }
  });

  test('a native deadline cancels the body and releases its reader lock', async () => {
    const nativeSetTimeout = globalThis.setTimeout;
    const timer = spyOn(globalThis, 'setTimeout').mockImplementation(((callback: () => void, delay?: number, ...args: unknown[]) => {
      return nativeSetTimeout(callback, delay === 20_000 ? 1 : delay, ...args);
    }) as typeof setTimeout);
    try {
      let canceled = false;
      let signal: AbortSignal | undefined;
      const response = new Response(new ReadableStream<Uint8Array>({
        start(controller) { controller.enqueue(encoder.encode('{')); },
        cancel() { canceled = true; },
      }));
      const fetcher = mock<FetchLike>(async (_, init) => {
        signal = init?.signal ?? undefined;
        return response;
      });
      const rejection = await new HopliteApiClient(CREDENTIALS, fetcher)
        .request({ method: 'GET', path: '/api/fixture' }).catch(error => error);
      expect(rejection.message).toBe('Hoplite API request timed out');
      expect(signal?.aborted).toBe(true);
      expect(canceled).toBe(true);
      expect(response.body?.locked).toBe(false);
      expect(fetcher).toHaveBeenCalledTimes(1);
    } finally {
      timer.mockRestore();
    }
  });
});

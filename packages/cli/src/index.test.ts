import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { createCommandRegistry, LEGACY_COMMAND_NAMES } from './command-registry';
import { foundationCommandDefinitions } from './foundation-commands';
import {
  checkMcpEndpoint,
  isGlobalIpAddress,
  mcpEndpointPolicyCommandDefinitions,
  validateMcpEndpointUrl,
} from './mcp-endpoint-policy';
import {
  apiKeySummary,
  authSummary,
  buildReadApiRequest,
  buildThreadActionRequest,
  canonicalizeGenericApiPath,
  createThreadBodyFromFlags,
  parseBoolean,
  parseCliArgs,
  redactText,
  redactSecrets,
  requireConfirmation,
  run,
  messageTextFromFlags,
  normalizeOAuthRefreshResponse,
  oauthNeedsRefresh,
  refreshOAuthState,
  sanitizeOutput,
  summarizeTimeline,
  summarizeApiResponse,
  validateMutationPath,
} from './index';
import {
  compatibilitySnapshot,
  compatibilityStatus,
  defaultCallerEvidence,
  diffCompatibility,
  loadResourcePolicy,
  parseResourcePolicy,
  settingsCapabilitySnapshot,
  validateResourcePolicyGrant,
} from './compatibility';

const TEST_THREAD_IDS = ['thr_testalpha123', 'thr_testbeta456'] as const;
const TEST_ALLOWLIST = new Set<string>(TEST_THREAD_IDS);

describe('hoplite-cli', () => {
  test('forbids feature modules from shadowing every legacy command and help alias', () => {
    for (const name of LEGACY_COMMAND_NAMES) {
      expect(() => createCommandRegistry([[{
        name,
        description: 'must not register',
        transport: 'local',
        run: () => ({}),
      }]])).toThrow('reserved legacy command');
    }
    expect(() => createCommandRegistry([[
      { name: 'feature-one', description: 'one', transport: 'local', run: () => ({}) },
      { name: 'feature-one', description: 'two', transport: 'local', run: () => ({}) },
    ]])).toThrow('Duplicate registered command');
  });

  test('reserves every legacy command advertised by help', async () => {
    const help = await run(['help']);
    const commands = help.commands as Record<string, string>;
    const featureNames = new Set([
      ...foundationCommandDefinitions,
      ...mcpEndpointPolicyCommandDefinitions,
    ].map(command => command.name));
    const advertisedLegacyNames = Object.keys(commands).filter(name => !featureNames.has(name));
    expect(advertisedLegacyNames.length).toBeGreaterThan(0);
    for (const name of advertisedLegacyNames) expect(LEGACY_COMMAND_NAMES.has(name)).toBe(true);
    for (const alias of ['help', '--help', '-h']) expect(LEGACY_COMMAND_NAMES.has(alias)).toBe(true);
  });

  test('parses positional values and both flag forms', () => {
    const parsed = parseCliArgs([
      'inspect',
      'thr_abc123',
      '--limit=25',
      '--archived',
      'false',
    ]);
    expect(parsed.command).toBe('inspect');
    expect(parsed.positionals).toEqual(['thr_abc123']);
    expect(parsed.flags.get('limit')).toBe('25');
    expect(parsed.flags.get('archived')).toBe('false');
  });

  test('parses strict booleans', () => {
    expect(parseBoolean('true', false)).toBe(true);
    expect(parseBoolean('no', true)).toBe(false);
    expect(() => parseBoolean('sometimes', false)).toThrow();
  });

  test('redacts token-like fields and URLs', () => {
    const input = 'password=hunter2 accessToken: abc123 see https://example.com/private?q=1';
    const output = redactText(input);
    expect(output).not.toContain('hunter2');
    expect(output).not.toContain('abc123');
    expect(output).not.toContain('example.com');
    expect(output).toContain('[redacted]');
    expect(output).toContain('[url]');
  });

  test('redacts an exact API key without exposing it', () => {
    const secret = 'fixture_api_key_value_123456789';
    expect(redactSecrets(`Authorization: Bearer ${secret}`, [secret])).not.toContain(secret);
  });

  test('requires confirmation for direct API mutations', () => {
    const flags = new Map<string, string>();
    expect(() => requireConfirmation(flags, 'POST')).toThrow('--confirm');
    flags.set('confirm', 'true');
    expect(() => requireConfirmation(flags, 'POST')).not.toThrow();
    expect(() => requireConfirmation(new Map(), 'GET')).not.toThrow();
  });

  test('permanently disables generic API mutations', () => {
    const [threadId] = TEST_THREAD_IDS;
    expect(() => validateMutationPath(`/api/threads/${threadId}/messages`, threadId, TEST_ALLOWLIST)).toThrow('permanently disabled');
  });

  test('canonicalizes only unambiguous generic API read paths', () => {
    expect(canonicalizeGenericApiPath('/api/projects?limit=25')).toBe('/api/projects?limit=25');
    expect(canonicalizeGenericApiPath('/api/threads/thr_testalpha123/messages')).toBe('/api/threads/thr_testalpha123/messages');
    for (const path of [
      '/api/threads/thr_testalpha123/../../projects/prj_target',
      '/api/threads/thr_testalpha123/%2e%2e/%2e%2e/projects/prj_target',
      '/api/threads/thr_testalpha123/%252e%252e/%252e%252e/projects/prj_target',
    ]) {
      expect(() => canonicalizeGenericApiPath(path)).toThrow('dot segments');
    }
    for (const path of [
      '/api/threads/thr_testalpha123%2f..%2fprojects/prj_target',
      '/api/threads/thr_testalpha123%252f..%252fprojects/prj_target',
      '/api/threads/thr_testalpha123%5c..%5cprojects/prj_target',
      '/api/threads/thr_testalpha123%255c..%255cprojects/prj_target',
    ]) {
      expect(() => canonicalizeGenericApiPath(path)).toThrow('encoded separator');
    }
    expect(() => canonicalizeGenericApiPath('/api/threads/thr_testalpha123\\..\\projects')).toThrow('backslashes');
    expect(() => canonicalizeGenericApiPath('//example.test/api/projects')).toThrow();
    expect(() => canonicalizeGenericApiPath('/health')).toThrow('/api/');
  });

  test('validates message targets and bounded content', () => {
    const [threadId] = TEST_THREAD_IDS;
    expect(messageTextFromFlags([threadId], new Map([['text', 'status']]), TEST_ALLOWLIST)).toBe('status');
    expect(() => messageTextFromFlags(['thr_notallowlisted'], new Map([['text', 'status']]), TEST_ALLOWLIST)).toThrow('allowlist');
    expect(() => messageTextFromFlags([threadId], new Map(), TEST_ALLOWLIST)).toThrow('message is required');
  });

  test('builds reviewed read-only API routes with bounded query values', () => {
    expect(buildReadApiRequest('repositories', [], new Map())).toEqual({
      method: 'GET',
      path: '/api/source-control/github/repositories',
    });
    expect(buildReadApiRequest('branches', ['repo/acme'], new Map())).toEqual({
      method: 'GET',
      path: '/api/source-control/github/repositories/repo%2Facme/branches',
    });
    expect(buildReadApiRequest('messages', ['thr_abc123'], new Map([
      ['limit', '50'],
      ['activity-limit', '200'],
    ]))).toEqual({
      method: 'GET',
      path: '/api/threads/thr_abc123/messages',
      query: { limit: 50, activityLimit: 200 },
    });
    expect(() => buildReadApiRequest('messages', ['thr_abc123'], new Map([['limit', '501']]))).toThrow();
    expect(() => buildReadApiRequest('messages', ['thr_abc123'], new Map([
      ['cursor', 'x'.repeat(513)],
    ]))).toThrow('message cursor');
  });

  test('builds only confirmed allowlisted lifecycle actions', () => {
    const [threadId] = TEST_THREAD_IDS;
    expect(() => buildThreadActionRequest('thread-retry', [threadId], new Map(), TEST_ALLOWLIST)).toThrow('--confirm');
    expect(() => buildThreadActionRequest('thread-retry', ['thr_notallowed'], new Map([
      ['confirm', 'true'],
    ]), TEST_ALLOWLIST)).toThrow('allowlist');
    const request = buildThreadActionRequest('thread-stop', [threadId], new Map([
      ['confirm', 'true'],
      ['run-id', 'run_abc123'],
      ['client-operation-id', 'codex-stop-001'],
    ]), TEST_ALLOWLIST);
    expect(request).toEqual({
      action: 'thread-stop',
      threadId,
      clientOperationId: 'codex-stop-001',
      method: 'POST',
      path: `/api/threads/${threadId}/stop`,
      body: { clientOperationId: 'codex-stop-001', runId: 'run_abc123' },
    });
    expect(() => buildThreadActionRequest('thread-stop', [threadId], new Map([
      ['confirm', 'true'],
    ]), TEST_ALLOWLIST)).toThrow('run id');
    for (const [command, suffix] of [
      ['thread-retry', 'retry'],
      ['thread-compact', 'compact'],
      ['thread-auto-title', 'title'],
    ] as const) {
      const action = buildThreadActionRequest(command, [threadId], new Map([
        ['confirm', 'true'],
        ['client-operation-id', `codex-${suffix}-001`],
      ]), TEST_ALLOWLIST);
      expect(action.path).toBe(`/api/threads/${threadId}/${suffix}`);
      expect(action.body).toEqual({ clientOperationId: `codex-${suffix}-001` });
    }
  });

  test('requires an explicit idempotency key before creating a task', () => {
    expect(() => createThreadBodyFromFlags(['prj_abc', 'Do', 'the', 'work'], new Map([
      ['confirm', 'true'],
    ]))).toThrow('client-operation-id');
    expect(createThreadBodyFromFlags(['prj_abc'], new Map([
      ['confirm', 'true'],
      ['prompt', 'Do the work'],
      ['client-operation-id', 'create-001'],
      ['model', 'gpt-5.6-terra'],
    ]))).toEqual({
      projectId: 'prj_abc',
      prompt: 'Do the work',
      clientOperationId: 'create-001',
      model: 'gpt-5.6-terra',
    });
  });

  test('bounds and redacts nested unofficial API output', () => {
    const sanitized = sanitizeOutput({
      token: 'must-never-appear',
      nested: {
        url: 'https://example.com/private',
        content: 'safe text',
      },
    });
    expect(JSON.stringify(sanitized)).not.toContain('must-never-appear');
    expect(JSON.stringify(sanitized)).not.toContain('example.com');
    expect(JSON.stringify(sanitized)).toContain('safe text');
  });

  test('summarizes bounded timeline roles and age', () => {
    const body = {
      items: [
        {
          kind: 'message',
          message: {
            role: 'user',
            createdAt: '2026-08-03T00:00:00.000Z',
            content: 'status?',
          },
        },
        {
          kind: 'message',
          message: {
            role: 'assistant',
            createdAt: '2026-08-03T00:00:10.000Z',
            content: 'running at https://secret.example/token',
          },
        },
      ],
      hasMore: false,
    };
    const summary = summarizeTimeline(body, Date.parse('2026-08-03T00:00:20.000Z'));
    expect(summary.lastActivityAgeSeconds).toBe(10);
    expect(JSON.stringify(summary)).not.toContain('secret.example');
  });

  test('reports expiry and safe permissions without exposing token values', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hoplite-cli-test-'));
    try {
      const path = join(dir, 'oauth.json');
      writeFileSync(path, JSON.stringify({
        resource: 'https://api.hoplite.sh/mcp',
        accessToken: 'must-never-appear',
        tokenType: 'Bearer',
        expiresAt: '2026-08-03T00:00:00.000Z',
      }), { mode: 0o600 });
      const summary = authSummary(path, Date.parse('2026-08-03T00:00:01.000Z'));
      expect(summary.expired).toBe(true);
      expect(JSON.stringify(summary)).not.toContain('must-never-appear');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('refreshes an expired OAuth token and persists it with safe permissions', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hoplite-oauth-refresh-test-'));
    const path = join(dir, 'oauth.json');
    try {
      writeFileSync(path, JSON.stringify({
        baseUrl: 'https://api.hoplite.sh',
        clientId: 'client_test',
        resource: 'https://api.hoplite.sh/mcp',
        refreshToken: 'refresh_secret_value',
        accessToken: 'expired_access_value',
        tokenType: 'Bearer',
        expiresAt: '2026-08-03T00:00:00.000Z',
        scope: 'openid offline_access',
      }), { mode: 0o600 });
      let requestBody = '';
      const refreshed = await refreshOAuthState(
        path,
        Date.parse('2026-08-03T00:00:01.000Z'),
        async (_input, init) => {
          requestBody = String(init?.body);
          return new Response(JSON.stringify({
            access_token: 'fresh_access_value',
            refresh_token: 'fresh_refresh_value',
            token_type: 'Bearer',
            expires_in: 3600,
          }), { status: 200 });
        },
      );
      expect(requestBody).toContain('grant_type=refresh_token');
      expect(requestBody).toContain('client_id=client_test');
      expect(refreshed.accessToken).toBe('fresh_access_value');
      expect(refreshed.refreshToken).toBe('fresh_refresh_value');
      expect(oauthNeedsRefresh(refreshed, Date.parse('2026-08-03T00:00:02.000Z'))).toBe(false);
      expect(statSync(path).mode & 0o777).toBe(0o600);
      const persisted = readFileSync(path, 'utf8');
      expect(persisted).toContain('fresh_access_value');
      expect(persisted).not.toContain('expired_access_value');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('normalizes refresh responses that rotate only the access token', () => {
    const current = {
      resource: 'https://api.hoplite.sh/mcp',
      clientId: 'client_test',
      refreshToken: 'refresh_value',
      accessToken: 'old_access',
      tokenType: 'Bearer',
      expiresAt: '2026-08-03T00:00:00.000Z',
    };
    const refreshed = normalizeOAuthRefreshResponse(current, {
      access_token: 'new_access',
      expires_in: 1800,
    }, Date.parse('2026-08-03T00:00:00.000Z'));
    expect(refreshed.accessToken).toBe('new_access');
    expect(refreshed.refreshToken).toBe('refresh_value');
    expect(refreshed.expiresAt).toBe('2026-08-03T00:30:00.000Z');
  });

  test('reports API-key presence without exposing its value', () => {
    const previous = process.env.HOPLITE_API_KEY;
    const previousCredentialsPath = process.env.HOPLITE_CREDENTIALS_PATH;
    const dir = mkdtempSync(join(tmpdir(), 'hoplite-api-key-test-'));
    try {
      delete process.env.HOPLITE_API_KEY;
      process.env.HOPLITE_CREDENTIALS_PATH = join(dir, 'missing.json');
      expect(apiKeySummary().keyPresent).toBe(false);
      process.env.HOPLITE_API_KEY = 'fixture_api_key_value_123456789';
      const summary = apiKeySummary();
      expect(summary.keyPresent).toBe(true);
      expect(JSON.stringify(summary)).not.toContain('fixture_api_key_value_123456789');
    } finally {
      if (previous === undefined) delete process.env.HOPLITE_API_KEY;
      else process.env.HOPLITE_API_KEY = previous;
      if (previousCredentialsPath === undefined) delete process.env.HOPLITE_CREDENTIALS_PATH;
      else process.env.HOPLITE_CREDENTIALS_PATH = previousCredentialsPath;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('accepts the native Hoplite credentials file without printing the key', () => {
    const previous = process.env.HOPLITE_API_KEY;
    const previousCredentialsPath = process.env.HOPLITE_CREDENTIALS_PATH;
    const dir = mkdtempSync(join(tmpdir(), 'hoplite-api-key-file-test-'));
    const path = join(dir, 'credentials.json');
    try {
      delete process.env.HOPLITE_API_KEY;
      process.env.HOPLITE_CREDENTIALS_PATH = path;
      writeFileSync(path, JSON.stringify({
        credentials: [{ apiKey: 'fixture_file_key_value_123456789', baseUrl: 'https://api.hoplite.sh' }],
      }), { mode: 0o600 });
      const summary = apiKeySummary();
      expect(summary.ok).toBe(true);
      expect(JSON.stringify(summary)).not.toContain('fixture_file_key_value_123456789');
    } finally {
      if (previous === undefined) delete process.env.HOPLITE_API_KEY;
      else process.env.HOPLITE_API_KEY = previous;
      if (previousCredentialsPath === undefined) delete process.env.HOPLITE_CREDENTIALS_PATH;
      else process.env.HOPLITE_CREDENTIALS_PATH = previousCredentialsPath;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('bounds direct API responses and drops timeline content', () => {
    const summary = summarizeApiResponse(JSON.stringify({
      ok: true,
      hasMore: false,
      items: [{ kind: 'message', message: { content: 'private prompt' } }],
    }), 'fixture_api_key_value_123456789');
    expect(summary.itemCount).toBe(1);
    expect(JSON.stringify(summary)).not.toContain('private prompt');
  });

  test('emits a bounded settings capability and compatibility status registry', () => {
    const snapshot = settingsCapabilitySnapshot(new Date('2026-08-25T12:00:00.000Z'));
    expect(snapshot.identity.registryVersion).toBe(1);
    expect(snapshot.capabilities.some(entry => entry.id === 'mcp.servers.list')).toBe(true);
    expect(snapshot.capabilities.some(entry => entry.id === 'project.delete' && entry.status === 'blocked')).toBe(true);
    expect(snapshot.capabilities.every(entry => Boolean(entry.payloadEvidence && entry.callerEvidence && entry.sideEffects))).toBe(true);
    const status = compatibilityStatus(snapshot);
    expect(status.capabilityCount).toBe(snapshot.capabilities.length);
    expect(JSON.stringify(status)).not.toMatch(/token|cookie|authorization/i);
  });

  test('classifies MCP auth analysis and probe as blocked external-contact actions', () => {
    const capabilities = settingsCapabilitySnapshot(new Date('2026-08-25T12:00:00.000Z')).capabilities;
    for (const id of ['mcp.auth.analyze', 'mcp.server.probe']) {
      const capability = capabilities.find(entry => entry.id === id);
      expect(capability?.risk).toBe('W2');
      expect(capability?.status).toBe('blocked');
      expect(capability?.notes).toContain('Hoplite-side DNS');
    }
  });

  test('reports a strict public HTTPS MCP endpoint without echoing its path', async () => {
    let resolverCalls = 0;
    const secretPath = 'access_token=fixture-path-secret';
    const result = await checkMcpEndpoint(`https://MCP.vendor.dev:443/mcp/${secretPath}`, {
      resolver: async () => {
        resolverCalls += 1;
        return [{ address: '203.0.114.10', family: 4 }];
      },
    });
    expect(resolverCalls).toBe(0);
    expect(result.endpoint).toEqual({
      origin: 'https://mcp.vendor.dev',
      hostname: 'mcp.vendor.dev',
      port: 443,
      pathConfigured: true,
    });
    expect(JSON.stringify(result)).not.toContain(secretPath);
    expect(JSON.stringify(result)).not.toContain('canonicalUrl');
    expect(JSON.stringify(result)).not.toContain('pathname');
    expect(result.networkObservation).toEqual({
      kind: 'none',
      limitation: 'Hostname syntax was checked without DNS resolution.',
    });
    expect(result.hopliteRequestSent).toBe(false);
    expect(result.targetHttpRequestSent).toBe(false);
  });

  test('rejects ambiguous, internal, and non-HTTPS MCP endpoint URLs', () => {
    const invalid = [
      'http://mcp.vendor.dev/mcp',
      'https://user:password@mcp.vendor.dev/mcp',
      'https://mcp.vendor.dev/mcp?token=fixture',
      'https://mcp.vendor.dev/mcp#fragment',
      'https://mcp.vendor.dev\\@127.0.0.1/mcp',
      'https://mcp.vendor.dev/%2fadmin',
      'https://mcp.vendor.dev/%5cadmin',
      'https://mcp.vendor.dev/%252fadmin',
      'https://mcp.vendor.dev/%2e%2e/admin',
      'https://mcp.vendor.dev/%00',
      'https://127.0.0.1/mcp',
      'https://[::1]/mcp',
      'https://2130706433/mcp',
      'https://singlelabel/mcp',
      'https://mcp.vendor.dev./mcp',
      'https://metadata.google.internal/mcp',
      'https://service.cluster.local/mcp',
      'https://mcp.example/mcp',
      'https://service.arpa/mcp',
      'https://example.com/mcp',
      'https://mcp.example.com/mcp',
      'https://example.net/mcp',
      'https://mcp.example.net/mcp',
      'https://example.org/mcp',
      'https://mcp.example.org/mcp',
      `https://${'a'.repeat(64)}.vendor.dev/mcp`,
      `https://mcp.vendor.dev/${'a'.repeat(2_100)}`,
    ];
    for (const value of invalid) expect(() => validateMcpEndpointUrl(value)).toThrow();
  });

  test('distinguishes ordinary public IP addresses from special-purpose ranges', () => {
    const publicMatrix = [
      { address: '1.1.1.1', purpose: 'public IPv4' },
      { address: '8.8.8.8', purpose: 'public IPv4' },
      { address: '2606:4700:4700::1111', purpose: 'public IPv6' },
      { address: '2001:4860:4860::8888', purpose: 'public IPv6' },
    ];
    for (const entry of publicMatrix) {
      expect({ ...entry, global: isGlobalIpAddress(entry.address) }).toEqual({ ...entry, global: true });
    }

    const specialPurposeMatrix = [
      { address: '0.0.0.0', purpose: 'current network' },
      { address: '10.0.0.1', purpose: 'private use' },
      { address: '100.64.0.1', purpose: 'shared address space' },
      { address: '127.0.0.1', purpose: 'loopback' },
      { address: '169.254.169.254', purpose: 'link local' },
      { address: '172.16.0.1', purpose: 'private use' },
      { address: '192.0.0.9', purpose: 'protocol anycast' },
      { address: '192.0.2.1', purpose: 'documentation TEST-NET-1' },
      { address: '192.31.196.1', purpose: 'AS112-v4' },
      { address: '192.52.193.1', purpose: 'automatic multicast tunneling' },
      { address: '192.88.99.2', purpose: '6a44 relay anycast' },
      { address: '192.168.1.1', purpose: 'private use' },
      { address: '192.175.48.1', purpose: 'direct delegation AS112 service' },
      { address: '198.18.0.1', purpose: 'benchmarking' },
      { address: '198.51.100.1', purpose: 'documentation TEST-NET-2' },
      { address: '203.0.113.1', purpose: 'documentation TEST-NET-3' },
      { address: '224.0.0.1', purpose: 'multicast' },
      { address: '255.255.255.255', purpose: 'limited broadcast' },
      { address: '::', purpose: 'unspecified' },
      { address: '::1', purpose: 'loopback' },
      { address: '::ffff:127.0.0.1', purpose: 'IPv4 mapped' },
      { address: '64:ff9b::127.0.0.1', purpose: 'IPv4 translation' },
      { address: '64:ff9b:1::1', purpose: 'local-use IPv4 translation' },
      { address: '100::1', purpose: 'discard only' },
      { address: '100:0:0:1::1', purpose: 'dummy IPv6' },
      { address: '2001:1::1', purpose: 'PCP anycast' },
      { address: '2001:1::2', purpose: 'TURN anycast' },
      { address: '2001:1::3', purpose: 'DNS-SD anycast' },
      { address: '2001:2::1', purpose: 'benchmarking' },
      { address: '2001:3::1', purpose: 'automatic multicast tunneling' },
      { address: '2001:4:112::1', purpose: 'AS112-v6' },
      { address: '2001:10::1', purpose: 'deprecated ORCHID' },
      { address: '2001:20::1', purpose: 'ORCHIDv2' },
      { address: '2001:30::1', purpose: 'drone remote ID entity tags' },
      { address: '2001:db8::1', purpose: 'documentation' },
      { address: '2002:7f00:1::', purpose: '6to4' },
      { address: '2620:4f:8000::1', purpose: 'direct delegation AS112 service' },
      { address: '3fff::1', purpose: 'documentation' },
      { address: '5f00::1', purpose: 'segment routing SIDs' },
      { address: 'fc00::1', purpose: 'unique local' },
      { address: 'fe80::1', purpose: 'link local' },
      { address: 'ff02::1', purpose: 'multicast' },
    ];
    for (const entry of specialPurposeMatrix) {
      expect({ ...entry, global: isGlobalIpAddress(entry.address) }).toEqual({ ...entry, global: false });
    }
  });

  test('performs one bounded DNS-only observation and rejects special-purpose answers', async () => {
    let resolverCalls = 0;
    const result = await checkMcpEndpoint('https://mcp.vendor.dev/mcp', {
      resolve: true,
      resolver: async hostname => {
        resolverCalls += 1;
        expect(hostname).toBe('mcp.vendor.dev');
        return [
          { address: '2606:4700:4700::1111', family: 6 },
          { address: '1.1.1.1', family: 4 },
          { address: '1.1.1.1', family: 4 },
        ];
      },
    });
    expect(resolverCalls).toBe(1);
    expect(result.networkObservation).toMatchObject({
      kind: 'local_dns_only',
      answerCount: 2,
      observationDeadlineMs: 3_000,
    });
    expect(JSON.stringify(result.networkObservation)).toContain('do not prove Hoplite-side');
    expect(JSON.stringify(result.networkObservation)).toContain('isolated lookup child');
    expect(result.targetHttpRequestSent).toBe(false);

    await expect(checkMcpEndpoint('https://mcp.vendor.dev/mcp', {
      resolve: true,
      resolver: async () => [
        { address: '1.1.1.1', family: 4 },
        { address: '127.0.0.1', family: 4 },
      ],
    })).rejects.toThrow('non-public or special-purpose');
  });

  test('aborts a DNS observation at its deadline and does not retry', async () => {
    let timeoutCalls = 0;
    let abortObserved = false;
    await expect(checkMcpEndpoint('https://mcp.vendor.dev/mcp', {
      resolve: true,
      dnsObservationDeadlineMs: 5,
      resolver: async (_hostname, { signal }) => {
        timeoutCalls += 1;
        return new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => {
            abortObserved = true;
            reject(signal.reason);
          }, { once: true });
        });
      },
    })).rejects.toThrow('DNS resolution exceeded');
    expect(timeoutCalls).toBe(1);
    expect(abortObserved).toBe(true);
  });

  test('rejects an oversized DNS result set without retrying', async () => {
    let countCalls = 0;
    await expect(checkMcpEndpoint('https://mcp.vendor.dev/mcp', {
      resolve: true,
      resolver: async () => {
        countCalls += 1;
        return Array.from({ length: 17 }, (_value, index) => ({
          address: `8.8.8.${index + 1}`,
          family: 4 as const,
        }));
      },
    })).rejects.toThrow('more than 16');
    expect(countCalls).toBe(1);
  });

  test('exposes MCP endpoint policy through a local-only CLI command', async () => {
    const secretPath = 'secret=fixture-cli-path-secret';
    const result = await run(['mcp-endpoint-check', '--url', `https://mcp.vendor.dev/mcp/${secretPath}`]);
    expect(result.ok).toBe(true);
    expect(result.hopliteRequestSent).toBe(false);
    expect(result.targetHttpRequestSent).toBe(false);
    expect(JSON.stringify(result)).not.toContain(secretPath);
    expect(JSON.stringify(result)).not.toContain('pathname');
    await expect(run(['mcp-endpoint-check', 'https://mcp.vendor.dev/mcp'])).rejects.toThrow('--url');
    await expect(run(['mcp-endpoint-check', '--url', 'https://mcp.vendor.dev/mcp', '--unknown'])).rejects.toThrow('does not support');
  });

  test('diffs compatibility snapshots by identity and capability contract', () => {
    const before = compatibilitySnapshot(new Date('2026-08-25T12:00:00.000Z'));
    const unchanged = diffCompatibility(before, compatibilitySnapshot(new Date('2026-08-25T12:05:00.000Z')));
    expect(unchanged.changed).toBe(false);
    const changedBaseline = structuredClone(before);
    changedBaseline.capabilities[0]!.path = '/api/old-projects';
    const changed = diffCompatibility(changedBaseline, compatibilitySnapshot(new Date('2026-08-25T12:05:00.000Z')));
    expect(changed.changed).toBe(true);
    expect(changed.modified).toContain(changedBaseline.capabilities[0]!.id);
    for (const field of ['area', 'action', 'notes'] as const) {
      const metadataBaseline = structuredClone(before);
      metadataBaseline.capabilities[0]![field] = `changed-${field}`;
      const metadataChange = diffCompatibility(
        metadataBaseline,
        compatibilitySnapshot(new Date('2026-08-25T12:05:00.000Z')),
      );
      expect(metadataChange.modified).toContain(metadataBaseline.capabilities[0]!.id);
    }
  });

  test('preserves area filters when diffing compatibility snapshots', () => {
    const before = compatibilitySnapshot(
      new Date('2026-08-25T12:00:00.000Z'),
      'project-environment',
    );
    const statusOutput = compatibilityStatus(before);
    expect(statusOutput.filter).toEqual({ area: 'project-environment' });
    const unchanged = diffCompatibility(statusOutput);
    expect(unchanged.changed).toBe(false);
    expect(unchanged.filter).toEqual({ area: 'project-environment' });
    expect(() => diffCompatibility(
      before,
      compatibilitySnapshot(new Date('2026-08-25T12:05:00.000Z')),
    )).toThrow('area filters do not match');
  });

  test('uses source-tier-specific default caller evidence', () => {
    expect(defaultCallerEvidence('official-openapi')).toContain('OpenAPI');
    expect(defaultCallerEvidence('official-docs')).toContain('documentation');
    expect(defaultCallerEvidence('authenticated-client')).toContain('web client release');
    expect(defaultCallerEvidence('live-mcp')).toContain('Live Hoplite MCP');
  });

  test('parses only short-lived, exact resource policies', () => {
    const now = Date.parse('2026-08-25T12:00:00.000Z');
    const fixture = {
      version: 1,
      owner: { accountId: 'usr_fixture', workspaceId: 'org_fixture' },
      origins: ['https://api.hoplite.sh'],
      resources: [{
        kind: 'project',
        id: 'prj_fixture',
        capabilities: ['project.update'],
        riskCeiling: 'W1',
      }],
      issuedAt: '2026-08-25T11:55:00.000Z',
      expiresAt: '2026-08-25T13:00:00.000Z',
    };
    expect(parseResourcePolicy(fixture, now).resources[0]?.id).toBe('prj_fixture');
    expect(() => parseResourcePolicy({ ...fixture, expiresAt: '2026-08-25T11:59:00.000Z' }, now)).toThrow('expired');
    expect(() => parseResourcePolicy({ ...fixture, extra: true }, now)).toThrow('unsupported fields');
    expect(() => parseResourcePolicy({
      ...fixture,
      resources: [{
        ...fixture.resources[0],
        capabilities: ['project.unknown-write'],
      }],
    }, now)).toThrow('unknown or non-write capability');
    expect(() => parseResourcePolicy({
      ...fixture,
      origins: ['https://api.hoplite.sh/path'],
    }, now)).toThrow('exact HTTPS');
  });

  test('requires owner-only permissions for resource policy files', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hoplite-policy-test-'));
    const path = join(dir, 'policy.json');
    const linkPath = join(dir, 'policy-link.json');
    const now = Date.parse('2026-08-25T12:00:00.000Z');
    try {
      writeFileSync(path, JSON.stringify({
        version: 1,
        owner: { accountId: 'usr_fixture', workspaceId: 'org_fixture' },
        origins: ['https://api.hoplite.sh'],
        resources: [{
          kind: 'project',
          id: 'prj_fixture',
          capabilities: ['project.update'],
          riskCeiling: 'W2',
        }],
        issuedAt: '2026-08-25T11:55:00.000Z',
        expiresAt: '2026-08-25T13:00:00.000Z',
      }), { mode: 0o600 });
      expect(loadResourcePolicy(path, now).resources[0]?.kind).toBe('project');
      chmodSync(path, 0o400);
      expect(loadResourcePolicy(path, now).resources[0]?.id).toBe('prj_fixture');
      symlinkSync(path, linkPath);
      expect(() => loadResourcePolicy(linkPath, now)).toThrow('non-symlink');
      chmodSync(path, 0o644);
      expect(() => loadResourcePolicy(path, now)).toThrow('owner-only');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('rejects a FIFO policy without waiting for a writer', () => {
    if (process.platform === 'win32') return;
    const dir = mkdtempSync(join(tmpdir(), 'hoplite-policy-fifo-test-'));
    const path = join(dir, 'policy.fifo');
    try {
      const created = spawnSync('mkfifo', [path], { encoding: 'utf8' });
      if (created.error && (created.error as NodeJS.ErrnoException).code === 'ENOENT') return;
      expect(created.status).toBe(0);
      const moduleUrl = pathToFileURL(join(import.meta.dir, 'compatibility.ts')).href;
      const script = `
        import { loadResourcePolicy } from ${JSON.stringify(moduleUrl)};
        try {
          loadResourcePolicy(${JSON.stringify(path)}, Date.parse('2026-08-25T12:00:00.000Z'));
          process.exit(2);
        } catch (error) {
          if (!String(error).includes('regular non-symlink file')) process.exit(3);
        }
      `;
      const checked = spawnSync(process.execPath, ['-e', script], {
        encoding: 'utf8',
        timeout: 2_000,
      });
      expect(checked.error).toBeUndefined();
      expect(checked.signal).toBeNull();
      expect(checked.status).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('authorizes only exact owner, origin, resource, capability, and risk grants', () => {
    const now = Date.parse('2026-08-25T12:00:00.000Z');
    const policy = parseResourcePolicy({
      version: 1,
      owner: { accountId: 'usr_fixture', workspaceId: 'org_fixture' },
      origins: ['https://api.hoplite.sh'],
      resources: [{
        kind: 'project',
        id: 'prj_fixture',
        capabilities: ['project.update'],
        riskCeiling: 'W1',
      }],
      issuedAt: '2026-08-25T11:55:00.000Z',
      expiresAt: '2026-08-25T13:00:00.000Z',
    }, now);
    const request = {
      accountId: 'usr_fixture',
      workspaceId: 'org_fixture',
      origin: 'https://api.hoplite.sh',
      kind: 'project' as const,
      resourceId: 'prj_fixture',
      capability: 'project.update',
    };
    expect(validateResourcePolicyGrant(policy, request, now).authorized).toBe(true);
    expect(() => validateResourcePolicyGrant(policy, { ...request, accountId: 'usr_other' }, now)).toThrow('owner');
    expect(() => validateResourcePolicyGrant(policy, { ...request, resourceId: 'prj_other' }, now)).toThrow('resource');
    expect(() => validateResourcePolicyGrant(policy, { ...request, capability: 'project.delete' }, now)).toThrow('capability');
    const callerRiskDowngrade = { ...request, risk: 'W1' } as unknown as typeof request;
    expect(() => validateResourcePolicyGrant(policy, callerRiskDowngrade, now)).toThrow('must not be caller supplied');

    const lowCeiling = parseResourcePolicy({
      version: 1,
      owner: { accountId: 'usr_fixture', workspaceId: 'org_fixture' },
      origins: ['https://api.hoplite.sh'],
      resources: [{
        kind: 'project',
        id: 'prj_fixture',
        capabilities: ['project.delete'],
        riskCeiling: 'W1',
      }],
      issuedAt: '2026-08-25T11:55:00.000Z',
      expiresAt: '2026-08-25T13:00:00.000Z',
    }, now);
    expect(() => validateResourcePolicyGrant(lowCeiling, {
      ...request,
      capability: 'project.delete',
    }, now)).toThrow('risk');
  });
});

import type { Client } from '@modelcontextprotocol/sdk/client/index.js';

import type { CliCommandDefinition, CommandResult } from './command-registry';

type JsonObject = Record<string, unknown>;

type McpApiRequest = {
  method: 'GET';
  path: '/api/mcp/servers' | '/api/mcp/catalog';
  query?: { projectId: string };
};

const PROJECT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const RESPONSE_MAX_BYTES = 512 * 1024;
const MAX_ROWS = 100;
const MAX_CAPABILITIES = 40;
const MAX_TAGS = 20;
const MCP_TIMEOUT_MS = 20_000;
const SAFE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const SECRETISH_KEY_RE = /(?:authorization|bearer|cookie|credential|env(?:ironment)?|headers?|password|private[_-]?key|secret|token|api[_-]?key|client[_-]?secret|session[_-]?key)/i;
const CREDENTIAL_LABEL_SOURCE = String.raw`(?:access[_-]?token|refresh[_-]?token|bearer[_-]?token|authorization|password|api[_-]?key|client[_-]?secret|private[_-]?key|session[_-]?key|secret|token)`;
const CREDENTIAL_ASSIGNMENT_RE = new RegExp(
  String.raw`((?:["']?${CREDENTIAL_LABEL_SOURCE}["']?)\s*[:=]\s*)(?:\[redacted\]|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,}\]]+)`,
  'gi',
);
const AUTHORIZATION_TEXT_RE = /\b(Bearer|Basic)\s+(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[A-Za-z0-9._~+/=-]+)/gi;
const URL_TEXT_RE = /\bhttps?:\/\/[^\s<>"'\])}]+/gi;
const EVIDENCED_OAUTH_TOKENS_PARENT_RE = /^body(?:\[\d+\]|\.(?:servers|items|data)\[\d+\])\.config\.auth$/;
const KNOWN_OMITTED_SECRET_KEYS = new Set([
  'accessToken',
  'access_token',
  'apiKey',
  'api_key',
  'authorization',
  'clientSecret',
  'client_secret',
  'cookie',
  'credentials',
  'credential',
  'env',
  'environment',
  'headers',
  'password',
  'privateKey',
  'private_key',
  'refreshToken',
  'refresh_token',
  'requestHeaders',
  'secrets',
  'token',
]);

const TRANSPORT_ALIASES: Readonly<Record<string, string>> = {
  http: 'http',
  https: 'http',
  sse: 'sse',
  stdio: 'stdio',
  'streamable-http': 'streamable-http',
  streamable_http: 'streamable-http',
  streamablehttp: 'streamable-http',
};

const AUTH_TYPE_ALIASES: Readonly<Record<string, string>> = {
  none: 'none',
  oauth: 'oauth',
  oauth2: 'oauth',
  bearer: 'bearer',
  token: 'bearer',
  header: 'custom-headers',
  headers: 'custom-headers',
  api_key: 'api-key',
  'api-key': 'api-key',
  apikey: 'api-key',
};

const AUTH_STATUS_ALIASES: Readonly<Record<string, string>> = {
  connected: 'connected',
  configured: 'configured',
  authenticated: 'connected',
  authorized: 'connected',
  pending: 'pending',
  required: 'required',
  disconnected: 'not-configured',
  unconfigured: 'not-configured',
  'not-configured': 'not-configured',
  error: 'error',
  failed: 'error',
};

function isRecord(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function strictProjectId(value: string | undefined): string {
  const normalized = value?.trim();
  if (!normalized || !PROJECT_ID_RE.test(normalized)) {
    throw new Error('project-mcp-list requires a project id containing only letters, numbers, underscores, or hyphens (128 characters maximum)');
  }
  return normalized;
}

function assertNoUnsupportedInputs(
  command: string,
  positionals: string[],
  flags: Map<string, string>,
  positionalCount: number,
): void {
  if (positionals.length !== positionalCount) {
    throw new Error(`${command} received an unexpected positional argument`);
  }
  if (flags.size > 0) throw new Error(`${command} does not accept flags`);
}

export function buildProjectMcpReadRequest(
  command: string,
  positionals: string[],
  flags = new Map<string, string>(),
): McpApiRequest {
  if (command === 'project-mcp-list') {
    assertNoUnsupportedInputs(command, positionals, flags, 1);
    return {
      method: 'GET',
      path: '/api/mcp/servers',
      query: { projectId: strictProjectId(positionals[0]) },
    };
  }
  if (command === 'project-mcp-catalog') {
    assertNoUnsupportedInputs(command, positionals, flags, 0);
    return { method: 'GET', path: '/api/mcp/catalog' };
  }
  throw new Error(`Unsupported project MCP read command: ${command}`);
}

export function redactProjectMcpText(input: string): string {
  return input
    .replace(CREDENTIAL_ASSIGNMENT_RE, '$1"[redacted]"')
    .replace(AUTHORIZATION_TEXT_RE, '$1 [redacted]')
    .replace(URL_TEXT_RE, '[url]')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function safeText(value: unknown, label: string, maximum: number, required = false): string | null {
  if (value === undefined || value === null) {
    if (required) throw new Error(`project_mcp_response_schema_mismatch: ${label} is required`);
    return null;
  }
  if (typeof value !== 'string') {
    throw new Error(`project_mcp_response_schema_mismatch: ${label} must be a string`);
  }
  const normalized = redactProjectMcpText(value).slice(0, maximum);
  if (!normalized && required) {
    throw new Error(`project_mcp_response_schema_mismatch: ${label} is empty`);
  }
  return normalized || null;
}

function safeId(value: unknown, label: string): string {
  if (typeof value !== 'string' || !SAFE_ID_RE.test(value)) {
    throw new Error(`project_mcp_response_schema_mismatch: ${label} is invalid`);
  }
  return value;
}

function assertNoUnknownSecretFields(value: unknown, path = 'body', depth = 0): void {
  if (depth > 8) throw new Error('project_mcp_response_schema_mismatch: response nesting exceeds the supported depth');
  if (Array.isArray(value)) {
    for (const [index, item] of value.slice(0, MAX_ROWS + 1).entries()) {
      assertNoUnknownSecretFields(item, `${path}[${index}]`, depth + 1);
    }
    return;
  }
  if (!isRecord(value)) return;
  for (const [key, nested] of Object.entries(value)) {
    if (key === 'tokens' && EVIDENCED_OAUTH_TOKENS_PARENT_RE.test(path)) continue;
    if (KNOWN_OMITTED_SECRET_KEYS.has(key)) continue;
    if (SECRETISH_KEY_RE.test(key)) {
      throw new Error('project_mcp_response_schema_mismatch: unrecognized secret-bearing field');
    }
    assertNoUnknownSecretFields(nested, `${path}.${key}`, depth + 1);
  }
}

function recordAt(value: unknown, key: string): JsonObject | undefined {
  return isRecord(value) && isRecord(value[key]) ? value[key] : undefined;
}

function firstString(...values: unknown[]): string | undefined {
  return values.find(value => typeof value === 'string') as string | undefined;
}

function normalizeTransport(row: JsonObject): string {
  const config = recordAt(row, 'config');
  const raw = firstString(row.transport, row.transportType, row.type, config?.transport, config?.transportType, config?.type);
  if (raw) {
    const normalized = raw.trim().toLowerCase().replace(/\s+/g, '-');
    const mapped = TRANSPORT_ALIASES[normalized];
    if (!mapped) throw new Error('project_mcp_response_schema_mismatch: unsupported MCP transport');
    return mapped;
  }
  if (config && typeof config.command === 'string') return 'stdio';
  if (config && typeof config.url === 'string') return 'http';
  throw new Error('project_mcp_response_schema_mismatch: MCP transport is missing');
}

function normalizeAuthType(row: JsonObject): string {
  const config = recordAt(row, 'config');
  const auth = recordAt(row, 'auth') ?? recordAt(config, 'auth');
  const raw = firstString(row.authType, config?.authType, auth?.type, auth?.kind);
  if (raw) {
    const normalized = raw.trim().toLowerCase().replace(/\s+/g, '-');
    return AUTH_TYPE_ALIASES[normalized] ?? 'other';
  }
  if (config && ('headers' in config || 'requestHeaders' in config)) return 'custom-headers';
  if (auth && ('tokens' in auth || 'grantType' in auth || auth.status === 'pending')) return 'oauth';
  if (config && ('oauth' in config || 'oauthConfig' in config)) return 'oauth';
  return 'none';
}

function normalizeAuthStatus(row: JsonObject, authType: string): string {
  const config = recordAt(row, 'config');
  const auth = recordAt(row, 'auth') ?? recordAt(config, 'auth');
  const raw = firstString(row.authStatus, row.oauthStatus, auth?.status, config?.authStatus);
  if (raw) {
    const normalized = raw.trim().toLowerCase().replace(/\s+/g, '-');
    return AUTH_STATUS_ALIASES[normalized] ?? 'unknown';
  }
  const connected = row.authenticated ?? row.connected ?? auth?.connected;
  if (typeof connected === 'boolean') return connected ? 'connected' : 'not-configured';
  if (authType === 'oauth' && auth) return auth.tokens !== undefined && auth.tokens !== null ? 'connected' : 'pending';
  return authType === 'none' ? 'not-required' : 'unknown';
}

function safeStringArray(value: unknown, label: string, maximum: number): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new Error(`project_mcp_response_schema_mismatch: ${label} must be an array`);
  if (value.length > maximum) throw new Error(`project_mcp_response_schema_mismatch: ${label} exceeds ${maximum} entries`);
  return value.map((entry, index) => safeText(entry, `${label}[${index}]`, 80, true)!);
}

function capabilityNames(row: JsonObject): string[] {
  const value = row.capabilities ?? recordAt(row, 'metadata')?.capabilities;
  if (value === undefined || value === null) return [];
  if (Array.isArray(value)) {
    if (value.length > MAX_CAPABILITIES) {
      throw new Error(`project_mcp_response_schema_mismatch: capabilities exceeds ${MAX_CAPABILITIES} entries`);
    }
    return value.map((entry, index) => {
      if (typeof entry === 'string') return safeText(entry, `capabilities[${index}]`, 80, true)!;
      if (isRecord(entry)) return safeText(entry.name ?? entry.id, `capabilities[${index}].name`, 80, true)!;
      throw new Error(`project_mcp_response_schema_mismatch: capabilities[${index}] is invalid`);
    });
  }
  if (isRecord(value)) {
    const enabled = Object.entries(value).filter(([, state]) => state === true).map(([name]) => name);
    return safeStringArray(enabled, 'capabilities', MAX_CAPABILITIES);
  }
  throw new Error('project_mcp_response_schema_mismatch: capabilities must be an array or boolean map');
}

function booleanField(value: unknown, label: string): boolean | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'boolean') throw new Error(`project_mcp_response_schema_mismatch: ${label} must be boolean`);
  return value;
}

function safeServer(row: unknown, index: number): JsonObject {
  if (!isRecord(row)) throw new Error(`project_mcp_response_schema_mismatch: servers[${index}] must be an object`);
  const config = recordAt(row, 'config');
  const transport = normalizeTransport(row);
  const authType = normalizeAuthType(row);
  return {
    id: safeId(row.id, `servers[${index}].id`),
    name: safeText(row.name, `servers[${index}].name`, 120, true),
    enabled: booleanField(row.enabled, `servers[${index}].enabled`),
    transport,
    auth: {
      type: authType,
      status: normalizeAuthStatus(row, authType),
    },
    endpointConfigured: Boolean(config && typeof config.url === 'string'),
    localCommandConfigured: transport === 'stdio' && Boolean(config && typeof config.command === 'string'),
    capabilities: capabilityNames(row),
    updatedAt: safeText(row.updatedAt, `servers[${index}].updatedAt`, 64),
  };
}

function safeCatalogEntry(row: unknown, index: number): JsonObject {
  if (!isRecord(row)) throw new Error(`project_mcp_response_schema_mismatch: catalog[${index}] must be an object`);
  return {
    domain: safeText(row.domain, `catalog[${index}].domain`, 160, true),
    name: safeText(row.name ?? row.title, `catalog[${index}].name`, 120, true),
    description: safeText(row.description, `catalog[${index}].description`, 300),
    kinds: safeStringArray(row.kinds, `catalog[${index}].kinds`, MAX_TAGS),
  };
}

function rowsFromBody(body: unknown, command: string): unknown[] {
  if (Array.isArray(body)) return body;
  if (!isRecord(body)) throw new Error('project_mcp_response_schema_mismatch: response body must be an object or array');
  const candidates = command === 'project-mcp-list'
    ? [body.servers, body.items, body.data]
    : [body.entries, body.catalog, body.items, body.data];
  const rows = candidates.find(Array.isArray);
  if (!rows) throw new Error(`project_mcp_response_schema_mismatch: ${command === 'project-mcp-list' ? 'servers' : 'catalog'} array is missing`);
  return rows;
}

function optionalNonnegativeInteger(value: unknown, label: string): number | null {
  if (value === undefined || value === null) return null;
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`project_mcp_response_schema_mismatch: ${label} must be a nonnegative safe integer`);
  }
  return value as number;
}

function nextCursorPresence(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value !== 'string' || value.length === 0 || value.length > 512 || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error('project_mcp_response_schema_mismatch: catalog.nextCursor is invalid');
  }
  return true;
}

export function projectMcpReadProjection(command: string, body: unknown): CommandResult {
  assertNoUnknownSecretFields(body);
  const rows = rowsFromBody(body, command);
  if (rows.length > MAX_ROWS) {
    throw new Error(`project_mcp_response_schema_mismatch: response exceeds ${MAX_ROWS} entries`);
  }
  if (command === 'project-mcp-list') {
    return { serverCount: rows.length, servers: rows.map(safeServer) };
  }
  if (command === 'project-mcp-catalog') {
    const envelope = isRecord(body) ? body : {};
    const pageCount = rows.length;
    const totalCount = optionalNonnegativeInteger(envelope.totalCount, 'catalog.totalCount');
    if (totalCount !== null && totalCount < pageCount) {
      throw new Error('project_mcp_response_schema_mismatch: catalog.totalCount is smaller than the current page');
    }
    const nextCursorPresent = nextCursorPresence(envelope.nextCursor);
    const explicitHasMore = booleanField(envelope.hasMore, 'catalog.hasMore');
    return {
      pageCount,
      totalCount,
      hasMore: explicitHasMore === true || nextCursorPresent,
      nextCursorPresent,
      isStale: booleanField(envelope.isStale, 'catalog.isStale') ?? false,
      catalog: rows.map(safeCatalogEntry),
    };
  }
  throw new Error(`Unsupported project MCP read command: ${command}`);
}

function parseJsonText(value: string, label: string): unknown {
  if (new TextEncoder().encode(value).byteLength > RESPONSE_MAX_BYTES) {
    throw new Error(`project_mcp_response_schema_mismatch: ${label} exceeds ${RESPONSE_MAX_BYTES} bytes`);
  }
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw new Error(`project_mcp_response_schema_mismatch: ${label} is not valid JSON`);
  }
}

function parseToolEnvelope(result: unknown): { status: number; ok: boolean; body: unknown } {
  if (!isRecord(result)) throw new Error('project_mcp_response_schema_mismatch: MCP result is invalid');
  const resultKeys = Object.keys(result);
  if (resultKeys.some(key => !['content', 'isError'].includes(key))) {
    throw new Error('project_mcp_response_schema_mismatch: MCP result contains unsupported top-level fields');
  }
  if (result.isError !== undefined && typeof result.isError !== 'boolean') {
    throw new Error('project_mcp_response_schema_mismatch: MCP result isError must be boolean');
  }
  const content = result.content;
  if (!Array.isArray(content)) throw new Error('project_mcp_response_schema_mismatch: MCP result content is missing');
  if (content.length !== 1 || !isRecord(content[0]) || content[0].type !== 'text' || typeof content[0].text !== 'string') {
    throw new Error('project_mcp_response_schema_mismatch: MCP result must contain exactly one JSON text payload and no extra content');
  }
  if (Object.keys(content[0]).some(key => !['type', 'text'].includes(key))) {
    throw new Error('project_mcp_response_schema_mismatch: MCP text payload contains unsupported fields');
  }
  const parsed = parseJsonText(content[0].text, 'MCP payload');
  if (!isRecord(parsed)) throw new Error('project_mcp_response_schema_mismatch: API response envelope must be an object');
  if (Object.keys(parsed).some(key => !['ok', 'status', 'body'].includes(key))) {
    throw new Error('project_mcp_response_schema_mismatch: API response envelope contains unsupported fields');
  }
  if (typeof parsed.ok !== 'boolean' || !Object.hasOwn(parsed, 'body')) {
    throw new Error('project_mcp_response_schema_mismatch: API response envelope is missing required fields');
  }
  const status = parsed.status;
  if (!Number.isInteger(status) || (status as number) < 100 || (status as number) > 599) {
    throw new Error('project_mcp_response_schema_mismatch: API response status is invalid');
  }
  let body = parsed.body;
  if (typeof body === 'string') body = parseJsonText(body, 'API response body');
  return { status: status as number, ok: parsed.ok === true && result.isError !== true, body };
}

function throwForStatus(command: string, status: number): never {
  if (status === 401) {
    throw new Error(`${command}: unsupported_credential (HTTP 401); authentication compatibility for this route remains unverified`);
  }
  if (status === 403) throw new Error(`${command}: role_denied (HTTP 403)`);
  if (status === 404) {
    const code = command === 'project-mcp-list' ? 'project_or_route_not_found' : 'route_not_available';
    throw new Error(`${command}: ${code} (HTTP 404)`);
  }
  if (status === 405) throw new Error(`${command}: route_not_available (HTTP 405)`);
  throw new Error(`${command}: http_error (HTTP ${status})`);
}

export async function executeProjectMcpRead(
  client: Client,
  command: string,
  positionals: string[],
  flags: Map<string, string>,
): Promise<CommandResult> {
  const request = buildProjectMcpReadRequest(command, positionals, flags);
  let raw: unknown;
  try {
    raw = await client.callTool(
      { name: 'hoplite_call_api', arguments: request },
      undefined,
      { timeout: MCP_TIMEOUT_MS, maxTotalTimeout: MCP_TIMEOUT_MS },
    );
  } catch {
    throw new Error(`${command}: transport_error; MCP request failed before a validated response`);
  }
  const response = parseToolEnvelope(raw);
  if (response.status === 200 && !response.ok) {
    throw new Error('project_mcp_response_schema_mismatch: successful HTTP status carried a false result');
  }
  if (!response.ok || response.status !== 200) throwForStatus(command, response.status);
  return {
    checkedAt: new Date().toISOString(),
    authenticationCompatibility: 'unverified',
    method: request.method,
    path: request.path,
    ...(request.query ? { projectId: request.query.projectId } : {}),
    ...projectMcpReadProjection(command, response.body),
  };
}

export const projectMcpCommandDefinitions: readonly CliCommandDefinition[] = [
  {
    name: 'project-mcp-list',
    description: 'List bounded MCP server metadata for one project without exposing configuration or credentials',
    transport: 'mcp',
    run: ({ client, positionals, flags }) => executeProjectMcpRead(client, 'project-mcp-list', positionals, flags),
  },
  {
    name: 'project-mcp-catalog',
    description: 'List bounded MCP catalog metadata without exposing install configuration or credentials',
    transport: 'mcp',
    run: ({ client, positionals, flags }) => executeProjectMcpRead(client, 'project-mcp-catalog', positionals, flags),
  },
];

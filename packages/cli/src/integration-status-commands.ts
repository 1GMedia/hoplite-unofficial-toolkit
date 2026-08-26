import type { Client } from '@modelcontextprotocol/sdk/client/index.js';

import type {
  CliCommandDefinition,
  CommandResult,
  LocalCommandContext,
} from './command-registry';

type JsonObject = Record<string, unknown>;

type ApiEnvelope = {
  ok: boolean;
  status: number;
  body: unknown;
};

type IntegrationSurface =
  | 'source-control-connections'
  | 'source-control-repositories'
  | 'slack'
  | 'linear'
  | 'sentry'
  | 'phone';

const MCP_TIMEOUT_MS = 20_000;
const MAX_MCP_RESPONSE_BYTES = 512 * 1024;
const MAX_ROWS = 250;
const MAX_NESTED_ROWS = 100;
const MAX_ID_LENGTH = 256;
const MAX_NAME_LENGTH = 512;
const MAX_URL_LENGTH = 2_048;
const MAX_TIMESTAMP_LENGTH = 64;
const MAX_STATUS_LENGTH = 64;
const PROJECT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const PHONE_UNAVAILABLE_REASONS = new Set([
  'rate_limited',
  'not_configured',
  'temporarily_unavailable',
  'invalid_phone_number',
  'phone_number_taken',
]);
const SOURCE_CONTROL_PROVIDERS = ['github'] as const;
const SENTRY_INSTALLATION_STATUSES = ['connected', 'needs_reauth'] as const;

class IntegrationSchemaDriftError extends Error {}

function isRecord(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function schemaError(): never {
  throw new IntegrationSchemaDriftError('integration_status_response_schema_mismatch');
}

function exactKeys(value: JsonObject, allowed: readonly string[]): void {
  const keys = Object.keys(value);
  if (
    keys.length !== allowed.length
    || keys.some(key => !allowed.includes(key))
    || allowed.some(key => !Object.hasOwn(value, key))
  ) schemaError();
}

function fixedEnumCounts(
  values: readonly unknown[],
  allowed: readonly string[],
  maximum = MAX_STATUS_LENGTH,
): Record<string, number> {
  const counts = Object.fromEntries(allowed.map(value => [value, 0])) as Record<string, number>;
  for (const value of values) {
    const parsed = requiredString(value, maximum);
    if (!allowed.includes(parsed)) schemaError();
    counts[parsed] = (counts[parsed] ?? 0) + 1;
  }
  return counts;
}

function requiredString(value: unknown, maximum = MAX_NAME_LENGTH): string {
  if (
    typeof value !== 'string'
    || value.trim().length === 0
    || value.length > maximum
    || /[\u0000-\u001f\u007f]/.test(value)
  ) {
    schemaError();
  }
  return value;
}

function nullableString(value: unknown, maximum = MAX_NAME_LENGTH): string | null {
  if (value === null || value === undefined) return null;
  return requiredString(value, maximum);
}

function requiredBoolean(value: unknown): boolean {
  if (typeof value !== 'boolean') schemaError();
  return value;
}

function boundedArray(value: unknown, maximum: number): unknown[] {
  if (!Array.isArray(value) || value.length > maximum) schemaError();
  return value;
}

function validateInvocation(
  command: string,
  positionals: readonly string[],
  flags: ReadonlyMap<string, string>,
  allowedFlags: readonly string[] = [],
): void {
  if (positionals.length > 0) throw new Error(`${command} does not accept positional arguments`);
  for (const flag of flags.keys()) {
    if (!allowedFlags.includes(flag)) throw new Error(`${command} does not support --${flag}`);
  }
}

function optionalProjectQuery(flags: ReadonlyMap<string, string>): JsonObject | undefined {
  const value = flags.get('project')?.trim();
  if (value === undefined) return undefined;
  if (value === 'true' || value === 'false' || !PROJECT_ID_RE.test(value)) {
    throw new Error('A valid --project id is required');
  }
  return { projectId: value };
}

export function parseIntegrationToolApiEnvelope(result: unknown): ApiEnvelope {
  if (
    !isRecord(result)
    || !Object.hasOwn(result, 'content')
    || !Object.hasOwn(result, 'isError')
    || !Array.isArray(result.content)
  ) schemaError();
  exactKeys(result, ['content', 'isError']);
  if (typeof result.isError !== 'boolean' || result.isError || result.content.length !== 1) schemaError();
  const item = result.content[0];
  if (
    !isRecord(item)
    || !Object.hasOwn(item, 'type')
    || !Object.hasOwn(item, 'text')
    || item.type !== 'text'
    || typeof item.text !== 'string'
  ) schemaError();
  exactKeys(item, ['type', 'text']);
  if (Buffer.byteLength(item.text, 'utf8') > MAX_MCP_RESPONSE_BYTES) schemaError();

  let parsed: unknown;
  try {
    parsed = JSON.parse(item.text);
  } catch {
    schemaError();
  }
  if (!isRecord(parsed)) schemaError();
  exactKeys(parsed, ['ok', 'status', 'body']);
  if (
    !Object.hasOwn(parsed, 'ok')
    || !Object.hasOwn(parsed, 'status')
    || typeof parsed.ok !== 'boolean'
    || !Number.isInteger(parsed.status)
    || !Object.hasOwn(parsed, 'body')
  ) {
    schemaError();
  }
  const status = parsed.status as number;
  if (status < 100 || status > 599 || parsed.ok !== (status === 200)) schemaError();
  return { ok: parsed.ok, status, body: parsed.body };
}

async function callReadRoute(
  client: Client,
  path: string,
  query?: JsonObject,
): Promise<ApiEnvelope> {
  const result = await client.callTool(
    {
      name: 'hoplite_call_api',
      arguments: {
        method: 'GET',
        path,
        ...(query ? { query } : {}),
      },
    },
    undefined,
    { timeout: MCP_TIMEOUT_MS, maxTotalTimeout: MCP_TIMEOUT_MS },
  );
  return parseIntegrationToolApiEnvelope(result);
}

function responseValue(body: unknown, key: string): unknown {
  if (!isRecord(body)) schemaError();
  exactKeys(body, ['ok', key]);
  if (body.ok !== true || !Object.hasOwn(body, key)) schemaError();
  return body[key];
}

function exactTimestamp(value: unknown): string {
  const text = requiredString(value, MAX_TIMESTAMP_LENGTH);
  if (!Number.isFinite(Date.parse(text))) schemaError();
  return text;
}

export function parseSourceControlConnections(body: unknown): JsonObject {
  const connections = boundedArray(responseValue(body, 'connections'), MAX_ROWS);
  const providers: unknown[] = [];
  for (const value of connections) {
    if (!isRecord(value)) schemaError();
    exactKeys(value, [
      'accountName',
      'accountType',
      'apiBaseUrl',
      'credentialKind',
      'externalId',
      'host',
      'id',
      'provider',
      'updatedAt',
    ]);
    requiredString(value.id, MAX_ID_LENGTH);
    providers.push(value.provider);
    requiredString(value.host, MAX_NAME_LENGTH);
    requiredString(value.accountName, MAX_NAME_LENGTH);
    nullableString(value.accountType, MAX_STATUS_LENGTH);
    exactTimestamp(value.updatedAt);
    requiredString(value.apiBaseUrl, MAX_URL_LENGTH);
    requiredString(value.credentialKind, MAX_STATUS_LENGTH);
    requiredString(value.externalId, MAX_ID_LENGTH);
  }
  return {
    totalCount: connections.length,
    connectedCount: connections.length,
    providerCounts: fixedEnumCounts(providers, SOURCE_CONTROL_PROVIDERS),
  };
}

export function parseSourceControlRepositories(body: unknown): JsonObject {
  const repositories = boundedArray(responseValue(body, 'repositories'), MAX_ROWS);
  const providers: unknown[] = [];
  let privateCount = 0;
  for (const value of repositories) {
    if (!isRecord(value)) schemaError();
    exactKeys(value, [
      'accountName',
      'apiBaseUrl',
      'cloneUrl',
      'connectionId',
      'defaultBranch',
      'externalId',
      'fullName',
      'host',
      'id',
      'language',
      'private',
      'provider',
    ]);
    requiredString(value.id, MAX_ID_LENGTH);
    requiredString(value.connectionId, MAX_ID_LENGTH);
    providers.push(value.provider);
    requiredString(value.host, MAX_NAME_LENGTH);
    requiredString(value.accountName, MAX_NAME_LENGTH);
    requiredString(value.fullName, MAX_NAME_LENGTH);
    requiredString(value.defaultBranch, MAX_NAME_LENGTH);
    nullableString(value.language, MAX_NAME_LENGTH);
    if (requiredBoolean(value.private)) privateCount += 1;
    requiredString(value.apiBaseUrl, MAX_URL_LENGTH);
    nullableString(value.cloneUrl, MAX_URL_LENGTH);
    requiredString(value.externalId, MAX_ID_LENGTH);
  }
  return {
    totalCount: repositories.length,
    providerCounts: fixedEnumCounts(providers, SOURCE_CONTROL_PROVIDERS),
    visibilityCounts: {
      private: privateCount,
      public: repositories.length - privateCount,
    },
  };
}

function statusObject(body: unknown, key: string): JsonObject {
  const value = responseValue(body, key);
  if (!isRecord(value)) schemaError();
  return value;
}

function validateStringRows(value: unknown): number {
  const rows = boundedArray(value ?? [], MAX_NESTED_ROWS);
  for (const row of rows) requiredString(row, MAX_NAME_LENGTH);
  return rows.length;
}

// The captured API client proves each status envelope and the fields below are
// dereferenced by the captured settings UI. Their imported Zod definitions
// lived in an uncaptured chunk, so these projections intentionally validate and
// emit only the evidenced fields instead of reflecting unknown provider data.
export function parseSlackStatus(body: unknown): JsonObject {
  const value = statusObject(body, 'slack');
  exactKeys(value, ['configured', 'missingConfig', 'requiredScopes', 'installations', 'projectBinding']);
  const installations = boundedArray(value.installations, MAX_NESTED_ROWS);
  for (const row of installations) {
    if (!isRecord(row)) schemaError();
    exactKeys(row, ['teamId', 'teamName', 'scope']);
    requiredString(row.teamId, MAX_ID_LENGTH);
    nullableString(row.teamName, MAX_NAME_LENGTH);
    if (row.scope !== undefined && row.scope !== null) requiredString(row.scope, MAX_NAME_LENGTH);
  }
  const bindingValue = value.projectBinding;
  let enabledCount = 0;
  let disabledCount = 0;
  let bindingPresentCount = 0;
  if (bindingValue !== null && bindingValue !== undefined) {
    if (!isRecord(bindingValue)) schemaError();
    exactKeys(bindingValue, ['teamId', 'channelId', 'channelName', 'enabled']);
    requiredString(bindingValue.teamId, MAX_ID_LENGTH);
    nullableString(bindingValue.channelId, MAX_ID_LENGTH);
    nullableString(bindingValue.channelName, MAX_NAME_LENGTH);
    bindingPresentCount = 1;
    if (requiredBoolean(bindingValue.enabled)) enabledCount = 1;
    else disabledCount = 1;
  }
  const configured = requiredBoolean(value.configured);
  return {
    totalCount: installations.length,
    connectedCount: installations.length,
    configuredCount: configured ? 1 : 0,
    bindingPresentCount,
    enabledCount,
    disabledCount,
    requiredScopeCount: validateStringRows(value.requiredScopes),
    missingConfigCount: validateStringRows(value.missingConfig),
  };
}

export function parseLinearStatus(body: unknown): JsonObject {
  const value = statusObject(body, 'linear');
  exactKeys(value, ['configured', 'installations', 'projectBinding']);
  const installations = boundedArray(value.installations, MAX_NESTED_ROWS);
  for (const row of installations) {
    if (!isRecord(row)) schemaError();
    exactKeys(row, ['workspaceId', 'workspaceName']);
    requiredString(row.workspaceId, MAX_ID_LENGTH);
    nullableString(row.workspaceName, MAX_NAME_LENGTH);
  }
  const bindingValue = value.projectBinding;
  let enabledCount = 0;
  let disabledCount = 0;
  let bindingPresentCount = 0;
  if (bindingValue !== null && bindingValue !== undefined) {
    if (!isRecord(bindingValue)) schemaError();
    exactKeys(bindingValue, [
      'workspaceId', 'teamId', 'teamName', 'linearProjectId', 'linearProjectName', 'enabled',
    ]);
    requiredString(bindingValue.workspaceId, MAX_ID_LENGTH);
    nullableString(bindingValue.teamId, MAX_ID_LENGTH);
    nullableString(bindingValue.teamName, MAX_NAME_LENGTH);
    nullableString(bindingValue.linearProjectId, MAX_ID_LENGTH);
    nullableString(bindingValue.linearProjectName, MAX_NAME_LENGTH);
    bindingPresentCount = 1;
    if (requiredBoolean(bindingValue.enabled)) enabledCount = 1;
    else disabledCount = 1;
  }
  const configured = requiredBoolean(value.configured);
  return {
    totalCount: installations.length,
    connectedCount: installations.length,
    configuredCount: configured ? 1 : 0,
    bindingPresentCount,
    enabledCount,
    disabledCount,
  };
}

function validateTriggerPolicy(value: unknown): void {
  if (value === null || value === undefined) return;
  if (!isRecord(value)) schemaError();
  exactKeys(value, ['newIssues', 'regressions', 'levels']);
  requiredBoolean(value.newIssues);
  requiredBoolean(value.regressions);
  validateStringRows(value.levels);
}

export function parseSentryStatus(body: unknown): JsonObject {
  const value = statusObject(body, 'sentry');
  exactKeys(value, ['configured', 'installations', 'projectBindings']);
  const installations = boundedArray(value.installations, MAX_NESTED_ROWS);
  const installationStatuses: unknown[] = [];
  for (const row of installations) {
    if (!isRecord(row)) schemaError();
    exactKeys(row, ['installationId', 'organizationSlug', 'organizationName', 'status']);
    requiredString(row.installationId, MAX_ID_LENGTH);
    requiredString(row.organizationSlug, MAX_NAME_LENGTH);
    nullableString(row.organizationName, MAX_NAME_LENGTH);
    installationStatuses.push(row.status);
  }
  const projectBindings = boundedArray(value.projectBindings, MAX_NESTED_ROWS);
  let enabledCount = 0;
  for (const row of projectBindings) {
    if (!isRecord(row)) schemaError();
    exactKeys(row, [
      'id', 'installationId', 'sentryProjectId', 'sentryProjectSlug', 'sentryProjectName',
      'enabled', 'triggerPolicy',
    ]);
    requiredString(row.id, MAX_ID_LENGTH);
    requiredString(row.installationId, MAX_ID_LENGTH);
    requiredString(row.sentryProjectId, MAX_ID_LENGTH);
    requiredString(row.sentryProjectSlug, MAX_NAME_LENGTH);
    nullableString(row.sentryProjectName, MAX_NAME_LENGTH);
    if (requiredBoolean(row.enabled)) enabledCount += 1;
    validateTriggerPolicy(row.triggerPolicy);
  }
  const statusCounts = fixedEnumCounts(installationStatuses, SENTRY_INSTALLATION_STATUSES);
  const configured = requiredBoolean(value.configured);
  return {
    totalCount: installations.length,
    connectedCount: statusCounts.connected ?? 0,
    configuredCount: configured ? 1 : 0,
    bindingPresentCount: projectBindings.length,
    enabledCount,
    disabledCount: projectBindings.length - enabledCount,
    statusCounts,
  };
}

export function parsePhoneStatus(body: unknown): JsonObject {
  const value = responseValue(body, 'connection');
  const emptyReasonCounts = Object.fromEntries(
    [...PHONE_UNAVAILABLE_REASONS].map(reason => [reason, 0]),
  );
  if (value === null) {
    return {
      totalCount: 0,
      connectedCount: 0,
      configuredCount: 0,
      pairingPendingCount: 0,
      pairingUnavailableReasonCounts: emptyReasonCounts,
    };
  }
  if (!isRecord(value)) schemaError();
  exactKeys(value, [
    'connected', 'phoneNumber', 'handles', 'pairingRedirectUrl', 'pairingUnavailableReason',
  ]);
  const phoneNumber = nullableString(value.phoneNumber, MAX_NAME_LENGTH);
  const handles = boundedArray(value.handles, MAX_NESTED_ROWS);
  for (const handle of handles) requiredString(handle, MAX_NAME_LENGTH);
  const pairingRedirectUrl = nullableString(value.pairingRedirectUrl, MAX_URL_LENGTH);
  const pairingUnavailableReason = nullableString(value.pairingUnavailableReason, MAX_STATUS_LENGTH);
  if (pairingUnavailableReason !== null && !PHONE_UNAVAILABLE_REASONS.has(pairingUnavailableReason)) {
    schemaError();
  }
  const reasonCounts = { ...emptyReasonCounts } as Record<string, number>;
  if (pairingUnavailableReason !== null) reasonCounts[pairingUnavailableReason] = 1;
  return {
    totalCount: 1,
    connectedCount: requiredBoolean(value.connected) ? 1 : 0,
    configuredCount: phoneNumber !== null || handles.length > 0 ? 1 : 0,
    pairingPendingCount: pairingRedirectUrl !== null ? 1 : 0,
    pairingUnavailableReasonCounts: reasonCounts,
  };
}

export function classifyIntegrationFailure(
  status: number,
  surface: IntegrationSurface,
): CommandResult {
  const outcomes: Record<number, string> = {
    401: 'unsupported_credential',
    402: 'payment_required',
    403: 'permission_denied',
    404: 'route_or_resource_unavailable',
    405: 'method_not_allowed',
    429: 'rate_limited',
    501: 'not_implemented',
  };
  return {
    ok: false,
    status,
    surface,
    outcome: outcomes[status] ?? 'request_failed',
    availability: 'unknown',
    message: 'The integration read was not completed; no provider response body was retained.',
  };
}

function transportFailure(surface: IntegrationSurface): CommandResult {
  return {
    ok: false,
    status: 0,
    surface,
    outcome: 'transport_error',
    availability: 'unknown',
    message: 'The integration read could not be completed through the current MCP transport.',
  };
}

function schemaFailure(surface: IntegrationSurface, status: number): CommandResult {
  return {
    ok: false,
    status,
    surface,
    outcome: 'schema_drift',
    availability: 'unknown',
    message: 'The integration response did not match the bounded compatibility schema.',
  };
}

async function runIntegrationRead(
  client: Client,
  surface: IntegrationSurface,
  path: string,
  parse: (body: unknown) => JsonObject,
  query?: JsonObject,
): Promise<CommandResult> {
  let response: ApiEnvelope;
  try {
    response = await callReadRoute(client, path, query);
  } catch (error) {
    return error instanceof IntegrationSchemaDriftError
      ? schemaFailure(surface, 0)
      : transportFailure(surface);
  }
  if (!response.ok || response.status !== 200) {
    return classifyIntegrationFailure(response.status, surface);
  }
  try {
    const projected = parse(response.body);
    return {
      ok: true,
      status: response.status,
      surface,
      availability: 'confirmed_for_current_credential',
      ...projected,
    };
  } catch {
    return schemaFailure(surface, response.status);
  }
}

function readCommand(
  name: string,
  description: string,
  surface: IntegrationSurface,
  path: string,
  parse: (body: unknown) => JsonObject,
  supportsProject = false,
): CliCommandDefinition {
  return {
    name,
    description,
    transport: 'mcp',
    validate: (context: LocalCommandContext) => {
      validateInvocation(name, context.positionals, context.flags, supportsProject ? ['project'] : []);
      if (supportsProject) optionalProjectQuery(context.flags);
    },
    run: ({ client, positionals, flags }) => {
      validateInvocation(name, positionals, flags, supportsProject ? ['project'] : []);
      const query = supportsProject ? optionalProjectQuery(flags) : undefined;
      return runIntegrationRead(client, surface, path, parse, query);
    },
  };
}

export const integrationStatusCommandDefinitions: readonly CliCommandDefinition[] = [
  readCommand(
    'source-control-connections',
    'Count source-control connections by fixed provider without emitting items or identifiers',
    'source-control-connections',
    '/api/source-control/connections',
    parseSourceControlConnections,
  ),
  readCommand(
    'source-control-repositories',
    'Count source-control repositories by fixed provider and visibility without emitting items',
    'source-control-repositories',
    '/api/source-control/repositories',
    parseSourceControlRepositories,
  ),
  readCommand(
    'slack-status',
    'Count Slack installations and optional binding state; supports --project',
    'slack',
    '/api/slack/status',
    parseSlackStatus,
    true,
  ),
  readCommand(
    'linear-status',
    'Count Linear installations and optional binding state; supports --project',
    'linear',
    '/api/linear/status',
    parseLinearStatus,
    true,
  ),
  readCommand(
    'sentry-status',
    'Count Sentry installations, fixed statuses, and optional bindings; supports --project',
    'sentry',
    '/api/sentry/status',
    parseSentryStatus,
    true,
  ),
  readCommand(
    'phone-status',
    'Count phone connection and pairing state without emitting identifiers or addresses',
    'phone',
    '/api/phone/connection',
    parsePhoneStatus,
  ),
];

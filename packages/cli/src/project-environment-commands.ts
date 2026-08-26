import type { CliCommandDefinition, CommandResult } from './command-registry';

type JsonObject = Record<string, unknown>;

type ToolCaller = {
  callTool: (
    request: { name: string; arguments?: JsonObject },
    schema?: undefined,
    options?: { timeout: number; maxTotalTimeout: number },
  ) => Promise<unknown>;
};

export type ProjectEnvironmentEntry = {
  key: string;
  updatedAt?: string;
};

const API_TOOL_NAME = 'hoplite_call_api';
const REQUEST_TIMEOUT_MS = 20_000;
const MAX_ENVIRONMENT_ENTRIES = 500;
const PROJECT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const ENVIRONMENT_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const SENSITIVE_FIELD_RE = /(?:^|[_-])(?:value|secret|token|password|credential|authorization|api[_-]?key)(?:$|[_-])/i;
const TRANSPORT_ERROR_MESSAGE = 'Project environment request transport failed; no remote error details were retained';

class ProjectEnvironmentSchemaError extends Error {
  constructor(detail: string) {
    super(`Project environment response schema drift: ${detail}`);
    this.name = 'ProjectEnvironmentSchemaError';
  }
}

export function validatedProjectId(value: string | undefined): string {
  const normalized = value?.trim();
  if (!normalized || !PROJECT_ID_RE.test(normalized)) {
    throw new Error('A valid Hoplite project id is required');
  }
  return normalized;
}

export function validatedEnvironmentKey(value: unknown): string {
  if (typeof value !== 'string' || !ENVIRONMENT_KEY_RE.test(value)) {
    throw new ProjectEnvironmentSchemaError('an entry contains an invalid key');
  }
  return value;
}

export function buildProjectEnvironmentListRequest(projectIdValue: string | undefined): {
  method: 'GET';
  path: string;
} {
  const projectId = validatedProjectId(projectIdValue);
  return {
    method: 'GET',
    path: `/api/projects/${encodeURIComponent(projectId)}/env-vars`,
  };
}

function isJsonObject(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function requireExactKeys(value: JsonObject, allowed: readonly string[], label: string): void {
  const allowedKeys = new Set(allowed);
  if (Object.keys(value).some(key => !allowedKeys.has(key))) {
    throw new ProjectEnvironmentSchemaError(`${label} contains an unrecognized field`);
  }
}

function parseUpdatedAt(value: unknown): string {
  if (typeof value !== 'string' || value.length > 64 || !Number.isFinite(Date.parse(value))) {
    throw new ProjectEnvironmentSchemaError('an entry contains an invalid updatedAt timestamp');
  }
  return value;
}

export function parseProjectEnvironmentEntries(value: unknown): ProjectEnvironmentEntry[] {
  if (!Array.isArray(value)) {
    throw new ProjectEnvironmentSchemaError('expected an array of metadata entries');
  }
  if (value.length > MAX_ENVIRONMENT_ENTRIES) {
    throw new ProjectEnvironmentSchemaError(`entry count exceeds ${MAX_ENVIRONMENT_ENTRIES}`);
  }

  const entries = value.map((candidate): ProjectEnvironmentEntry => {
    if (!isJsonObject(candidate)) {
      throw new ProjectEnvironmentSchemaError('an entry is not an object');
    }
    const fields = Object.keys(candidate);
    const sensitiveField = fields.find(field => SENSITIVE_FIELD_RE.test(field));
    if (sensitiveField) {
      throw new ProjectEnvironmentSchemaError('an entry contains a secret-bearing field');
    }
    if (fields.some(field => field !== 'key' && field !== 'updatedAt')) {
      throw new ProjectEnvironmentSchemaError('an entry contains an unrecognized field');
    }
    if (!fields.includes('key')) {
      throw new ProjectEnvironmentSchemaError('an entry is missing its key');
    }

    const key = validatedEnvironmentKey(candidate.key);
    if (candidate.updatedAt === undefined) return { key };
    return { key, updatedAt: parseUpdatedAt(candidate.updatedAt) };
  });

  entries.sort((left, right) => left.key.localeCompare(right.key));
  return entries;
}

function parseToolPayload(result: unknown): JsonObject {
  if (!isJsonObject(result)) {
    throw new ProjectEnvironmentSchemaError('MCP returned an invalid tool envelope');
  }
  requireExactKeys(result, ['content', 'isError'], 'MCP tool envelope');
  if (result.isError === true) {
    throw new Error('Project environment route is unavailable through the current MCP API tool');
  }
  if (result.isError !== undefined && result.isError !== false) {
    throw new ProjectEnvironmentSchemaError('MCP returned an invalid isError flag');
  }
  const content = result.content;
  if (!Array.isArray(content) || content.length !== 1) {
    throw new ProjectEnvironmentSchemaError('MCP returned unexpected content');
  }
  const textBlock = content[0];
  if (!isJsonObject(textBlock)) {
    throw new ProjectEnvironmentSchemaError('MCP returned an invalid content block');
  }
  requireExactKeys(textBlock, ['type', 'text'], 'MCP text block');
  if (textBlock.type !== 'text' || typeof textBlock.text !== 'string') {
    throw new ProjectEnvironmentSchemaError('MCP returned an invalid text payload');
  }
  try {
    const parsed = JSON.parse(textBlock.text) as unknown;
    if (!isJsonObject(parsed)) throw new Error('not an object');
    return parsed;
  } catch {
    throw new ProjectEnvironmentSchemaError('MCP returned invalid JSON');
  }
}

function parseHttpStatus(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 100 || value > 599) {
    throw new ProjectEnvironmentSchemaError('missing or invalid HTTP status');
  }
  return value;
}

function throwForHttpFailure(status: number): never {
  if (status === 401) {
    throw new Error('Project environment credential unsupported (HTTP 401); CLI authentication compatibility remains unverified');
  }
  if (status === 403) {
    throw new Error('Project environment access denied for the current workspace role (HTTP 403)');
  }
  if (status === 404) {
    throw new Error('Project environment project or route was not found (HTTP 404)');
  }
  if (status === 405 || status === 410 || status === 501) {
    throw new Error(`Project environment route is absent or unsupported (HTTP ${status})`);
  }
  throw new Error(`Project environment request failed (HTTP ${status})`);
}

export function parseProjectEnvironmentResponse(response: unknown): {
  status: 200;
  entries: ProjectEnvironmentEntry[];
} {
  if (!isJsonObject(response)) {
    throw new ProjectEnvironmentSchemaError('expected an HTTP response object');
  }
  requireExactKeys(response, ['ok', 'status', 'body'], 'HTTP response');
  const status = parseHttpStatus(response.status);
  if (typeof response.ok !== 'boolean') {
    throw new ProjectEnvironmentSchemaError('missing or invalid HTTP ok flag');
  }
  if (status === 200 && response.ok !== true) {
    throw new ProjectEnvironmentSchemaError('HTTP status and ok flag disagree');
  }
  if (response.ok !== true || status !== 200) throwForHttpFailure(status);
  if (!Object.prototype.hasOwnProperty.call(response, 'body')) {
    throw new ProjectEnvironmentSchemaError('successful HTTP response is missing its body');
  }
  return { status: 200, entries: parseProjectEnvironmentEntries(response.body) };
}

export async function executeProjectEnvironmentList(
  caller: ToolCaller,
  projectIdValue: string | undefined,
  now = new Date(),
): Promise<CommandResult> {
  const projectId = validatedProjectId(projectIdValue);
  const request = buildProjectEnvironmentListRequest(projectId);
  let toolResult: unknown;
  try {
    toolResult = await caller.callTool(
      { name: API_TOOL_NAME, arguments: request },
      undefined,
      { timeout: REQUEST_TIMEOUT_MS, maxTotalTimeout: REQUEST_TIMEOUT_MS },
    );
  } catch {
    throw new Error(TRANSPORT_ERROR_MESSAGE);
  }
  const response = parseToolPayload(toolResult);
  const parsed = parseProjectEnvironmentResponse(response);
  return {
    checkedAt: now.toISOString(),
    projectId,
    variables: parsed.entries,
    capability: {
      id: 'project.environment.list',
      mode: 'read-only',
      localImplementation: 'available',
      remoteAuthentication: 'unverified',
      source: 'authenticated-client-contract',
    },
  };
}

export const projectEnvironmentCommandDefinitions: readonly CliCommandDefinition[] = [
  {
    name: 'project-environment-list',
    description: 'List sorted environment variable names and update timestamps without reading values',
    transport: 'mcp',
    run: ({ client, positionals }) => executeProjectEnvironmentList(client as unknown as ToolCaller, positionals[0]),
  },
];

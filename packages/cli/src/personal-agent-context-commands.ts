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

type PersonalContextSurface = 'agent-memories' | 'personal-skills';

type ParsedMemory = {
  content: string;
  scope: 'personal' | 'organization' | 'project' | 'thread';
};

type ParsedSkill = {
  body: string;
  source: 'custom' | 'imported';
};

const MCP_TIMEOUT_MS = 20_000;
const MAX_ITEMS = 100;
const MAX_MCP_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_MESSAGE_OUTPUT = 500;
const MEMORY_SCOPES = new Set(['personal', 'organization', 'project', 'thread']);
const SKILL_SOURCES = new Set(['custom', 'imported']);
const PERSONAL_COMMAND_FLAGS = new Set<string>();

class SchemaDriftError extends Error {}

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function schemaError(surface: string, detail: string): never {
  throw new SchemaDriftError(`${surface} response schema drift: ${detail}`);
}

function requiredString(value: unknown, field: string, surface: string): string {
  if (typeof value !== 'string') {
    schemaError(surface, `${field} must be a string`);
  }
  return value;
}

function requiredNonEmptyString(value: unknown, field: string, surface: string): string {
  const parsed = requiredString(value, field, surface);
  if (parsed.trim().length === 0) {
    schemaError(surface, `${field} must be a non-empty string`);
  }
  return parsed;
}

function optionalString(value: unknown, field: string, surface: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') schemaError(surface, `${field} must be a string or null`);
  return value;
}

function validateCommandInvocation(
  command: string,
  positionals: readonly string[],
  flags: ReadonlyMap<string, string>,
  supportedFlags: ReadonlySet<string>,
): void {
  if (positionals.length > 0) throw new Error(`${command} does not accept positional arguments`);
  for (const name of flags.keys()) {
    if (!supportedFlags.has(name)) throw new Error(`${command} does not support --${name}`);
  }
}

function validatePersonalCommand(
  context: LocalCommandContext,
  command: string,
): void {
  validateCommandInvocation(command, context.positionals, context.flags, PERSONAL_COMMAND_FLAGS);
}

function parseToolApiEnvelope(result: unknown): ApiEnvelope {
  if (
    !isObject(result)
    || !Object.hasOwn(result, 'content')
    || !Array.isArray(result.content)
  ) {
    schemaError('Hoplite MCP', 'expected content array');
  }
  if (Object.keys(result).some(key => key !== 'content' && key !== 'isError')) {
    schemaError('Hoplite MCP', 'contained unsupported top-level fields');
  }
  if (!Object.hasOwn(result, 'isError')) {
    schemaError('Hoplite MCP', 'expected own boolean isError');
  }
  if (typeof result.isError !== 'boolean') {
    schemaError('Hoplite MCP', 'isError must be boolean');
  }
  if (result.isError === true) schemaError('Hoplite MCP', 'tool returned an error result');
  if (result.content.length !== 1) {
    schemaError('Hoplite MCP', 'expected exactly one JSON text content item');
  }
  const textItem = result.content[0];
  if (
    !isObject(textItem)
    || !Object.hasOwn(textItem, 'type')
    || !Object.hasOwn(textItem, 'text')
    || textItem.type !== 'text'
    || typeof textItem.text !== 'string'
  ) {
    schemaError('Hoplite MCP', 'expected exactly one JSON text content item');
  }
  if (Object.keys(textItem).some(key => key !== 'type' && key !== 'text')) {
    schemaError('Hoplite MCP', 'text content contained unsupported fields');
  }
  if (Buffer.byteLength(textItem.text, 'utf8') > MAX_MCP_RESPONSE_BYTES) {
    schemaError('Hoplite MCP', `JSON text exceeded ${MAX_MCP_RESPONSE_BYTES} bytes`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(textItem.text);
  } catch {
    schemaError('Hoplite MCP', 'text content was not JSON');
  }
  if (!isObject(parsed)) schemaError('Hoplite MCP API', 'expected an object envelope');
  if (Object.keys(parsed).some(key => key !== 'ok' && key !== 'status' && key !== 'body')) {
    schemaError('Hoplite MCP API', 'contained unsupported envelope fields');
  }
  if (
    !Object.hasOwn(parsed, 'ok')
    || !Object.hasOwn(parsed, 'status')
    || !Object.hasOwn(parsed, 'body')
    || typeof parsed.ok !== 'boolean'
    || !Number.isInteger(parsed.status)
  ) {
    schemaError('Hoplite MCP API', 'expected boolean ok, integer status, and body');
  }
  const status = parsed.status as number;
  if (status < 100 || status > 599) schemaError('Hoplite MCP API', 'status was outside the HTTP range');
  if ((status === 200) !== parsed.ok) {
    schemaError('Hoplite MCP API', 'success flag and status were inconsistent');
  }
  return { ok: parsed.ok, status, body: parsed.body };
}

async function callReadRoute(client: Client, path: string): Promise<ApiEnvelope> {
  const result = await client.callTool(
    { name: 'hoplite_call_api', arguments: { method: 'GET', path } },
    undefined,
    { timeout: MCP_TIMEOUT_MS, maxTotalTimeout: MCP_TIMEOUT_MS },
  );
  return parseToolApiEnvelope(result);
}

function responseItems(body: unknown, key: 'memories' | 'skills', surface: string): unknown[] {
  const items = Array.isArray(body)
    ? body
    : isObject(body) && body.ok === true && Array.isArray(body[key])
      ? body[key]
      : null;
  if (items === null) schemaError(surface, `expected an array or { ok: true, ${key}: array }`);
  if (items.length > MAX_ITEMS) schemaError(surface, `returned more than ${MAX_ITEMS} rows`);
  return items;
}

function parseAgentMemoriesResponse(body: unknown): ParsedMemory[] {
  return responseItems(body, 'memories', 'Agent memories').map((value, index) => {
    if (!isObject(value)) schemaError('Agent memories', `memories[${index}] must be an object`);
    const scope = requiredNonEmptyString(value.scope, `memories[${index}].scope`, 'Agent memories');
    if (!MEMORY_SCOPES.has(scope)) {
      schemaError('Agent memories', `memories[${index}].scope contains an unknown value`);
    }
    requiredNonEmptyString(value.id, `memories[${index}].id`, 'Agent memories');
    return {
      content: requiredString(value.content, `memories[${index}].content`, 'Agent memories'),
      scope: scope as ParsedMemory['scope'],
    };
  });
}

function parsePersonalSkillsResponse(body: unknown): ParsedSkill[] {
  return responseItems(body, 'skills', 'Personal skills').map((value, index) => {
    if (!isObject(value)) schemaError('Personal skills', `skills[${index}] must be an object`);
    const source = requiredNonEmptyString(value.source, `skills[${index}].source`, 'Personal skills');
    if (!SKILL_SOURCES.has(source)) {
      schemaError('Personal skills', `skills[${index}].source contains an unknown value`);
    }
    requiredNonEmptyString(value.id, `skills[${index}].id`, 'Personal skills');
    requiredNonEmptyString(value.name, `skills[${index}].name`, 'Personal skills');
    requiredNonEmptyString(value.description, `skills[${index}].description`, 'Personal skills');
    optionalString(value.sourceLabel, `skills[${index}].sourceLabel`, 'Personal skills');
    return {
      body: requiredString(value.body, `skills[${index}].body`, 'Personal skills'),
      source: source as ParsedSkill['source'],
    };
  });
}

export function classifyPersonalContextFailure(
  status: number,
  surface: PersonalContextSurface,
): CommandResult {
  if (status === 401) {
    return {
      ok: false,
      status,
      outcome: 'unsupported_credential',
      availability: 'unknown',
      message: 'The current MCP OAuth credential was not accepted; browser-session availability was not evaluated.',
    };
  }
  if (status === 403) {
    return {
      ok: false,
      status,
      outcome: 'role_denied',
      availability: 'unknown',
      message: 'The current principal is not allowed to read this personal context; broader product availability was not evaluated.',
    };
  }
  if (status === 404) {
    return {
      ok: false,
      status,
      outcome: surface === 'agent-memories'
        ? 'memories_absent_for_current_principal'
        : 'skills_absent_for_current_principal',
      availability: 'unknown',
      message: 'The compatibility surface was absent or unavailable to the current principal; product-wide absence was not inferred.',
    };
  }
  return {
    ok: false,
    status,
    outcome: 'request_failed',
    availability: 'unknown',
    message: 'The personal-context read did not succeed; no availability conclusion was made.',
  };
}

function schemaDriftResult(error: unknown, surface: PersonalContextSurface, status = 200): CommandResult {
  const message = error instanceof Error ? error.message : 'Response did not match the expected schema';
  return {
    ok: false,
    status,
    outcome: 'schema_drift',
    surface,
    availability: 'unknown',
    message: message.slice(0, MAX_MESSAGE_OUTPUT),
  };
}

function transportErrorResult(surface: PersonalContextSurface): CommandResult {
  return {
    ok: false,
    status: 0,
    outcome: 'transport_error',
    surface,
    availability: 'unknown',
    message: 'The personal-context read could not be completed through the current MCP transport; no availability conclusion was made.',
  };
}

async function listAgentMemories(client: Client): Promise<CommandResult> {
  let response: ApiEnvelope;
  try {
    response = await callReadRoute(client, '/api/agent-memories');
  } catch (error) {
    if (error instanceof SchemaDriftError) return schemaDriftResult(error, 'agent-memories', 0);
    return transportErrorResult('agent-memories');
  }
  if (!response.ok || response.status !== 200) {
    return classifyPersonalContextFailure(response.status, 'agent-memories');
  }
  try {
    const memories = parseAgentMemoriesResponse(response.body);
    const scopeCounts = { personal: 0, organization: 0, project: 0, thread: 0 };
    let contentPresentCount = 0;
    for (const memory of memories) {
      scopeCounts[memory.scope] += 1;
      if (memory.content.trim().length > 0) contentPresentCount += 1;
    }
    return {
      ok: true,
      status: response.status,
      availability: 'confirmed_for_current_credential',
      inventoryPolicy: 'aggregate_only',
      privacyPolicy: 'no_ids_text_digests_or_lengths',
      totalCount: memories.length,
      contentPresentCount,
      contentEmptyCount: memories.length - contentPresentCount,
      scopeCounts,
    };
  } catch (error) {
    return schemaDriftResult(error, 'agent-memories', response.status);
  }
}

async function listPersonalSkills(client: Client): Promise<CommandResult> {
  let response: ApiEnvelope;
  try {
    response = await callReadRoute(client, '/api/user/skills');
  } catch (error) {
    if (error instanceof SchemaDriftError) return schemaDriftResult(error, 'personal-skills', 0);
    return transportErrorResult('personal-skills');
  }
  if (!response.ok || response.status !== 200) {
    return classifyPersonalContextFailure(response.status, 'personal-skills');
  }
  try {
    const skills = parsePersonalSkillsResponse(response.body);
    const sourceCounts = { custom: 0, imported: 0 };
    let bodyPresentCount = 0;
    for (const skill of skills) {
      sourceCounts[skill.source] += 1;
      if (skill.body.trim().length > 0) bodyPresentCount += 1;
    }
    return {
      ok: true,
      status: response.status,
      availability: 'confirmed_for_current_credential',
      inventoryPolicy: 'aggregate_only',
      privacyPolicy: 'no_ids_text_digests_or_lengths',
      totalCount: skills.length,
      bodyPresentCount,
      bodyEmptyCount: skills.length - bodyPresentCount,
      sourceCounts,
    };
  } catch (error) {
    return schemaDriftResult(error, 'personal-skills', response.status);
  }
}

export const personalAgentContextCommandDefinitions: readonly CliCommandDefinition[] = [
  {
    name: 'personal-memories-list',
    description: 'List aggregate memory counts; IDs, text, digests, and lengths are never emitted',
    transport: 'mcp',
    validate: context => validatePersonalCommand(context, 'personal-memories-list'),
    run: async ({ client, positionals, flags }) => {
      validatePersonalCommand({ positionals, flags }, 'personal-memories-list');
      return listAgentMemories(client);
    },
  },
  {
    name: 'personal-skills-list',
    description: 'List aggregate skill counts; IDs, text, digests, and lengths are never emitted',
    transport: 'mcp',
    validate: context => validatePersonalCommand(context, 'personal-skills-list'),
    run: async ({ client, positionals, flags }) => {
      validatePersonalCommand({ positionals, flags }, 'personal-skills-list');
      return listPersonalSkills(client);
    },
  },
];

import {
  closeSync,
  constants,
  fstatSync,
  openSync,
  readSync,
  writeFileSync,
} from 'node:fs';
import { resolve } from 'node:path';

import type { Client } from '@modelcontextprotocol/sdk/client/index.js';

import type { CliCommandDefinition, McpCommandContext } from './command-registry';

type JsonObject = Record<string, unknown>;
type ApiCaller = (method: 'GET', path: string) => Promise<JsonObject>;

type AgentSettings = {
  defaultModel: string | null;
  reasoningEffort: string | null;
  agentSpeed: 'standard' | 'fast' | null;
  prReviewAutofixDefault: boolean | null;
  instructions: string | null;
};

type ModelCapabilities = {
  reasoningLevels: string[];
  supportsFast: boolean;
};

type ModelCatalogEntry = {
  id: string;
  capabilities: ModelCapabilities | null;
};

const MAX_INSTRUCTIONS_LENGTH = 100_000;
const MAX_PRINTED_INSTRUCTIONS_LENGTH = 4_000;
const HOPLITE_WEB_RELEASE = '97462d3aff299f96fc632f69b0c941a036c83eb0';
const SETTINGS_BUNDLE_SHA256 = '6f00bec4a82011b011e1ca23fbdc05d4e750c10fcd1d8ea8f839564f491d3f74';
const PROJECT_FIELDS = [
  'defaultModel',
  'reasoningEffort',
  'agentSpeed',
  'prReviewAutofixDefault',
  'instructions',
] as const;

type ProjectField = (typeof PROJECT_FIELDS)[number];

export class HopliteAccessError extends Error {
  readonly status: 401 | 403;

  constructor(status: 401 | 403) {
    super(status === 401
      ? 'Hoplite authentication failed (401). Refresh the OAuth session with `hoplite mcp start`.'
      : 'Hoplite authorization failed (403). The authenticated identity cannot access this project.');
    this.name = 'HopliteAccessError';
    this.status = status;
  }
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function schemaDrift(detail: string): never {
  throw new Error(`Hoplite project-agent contract schema drift: ${detail}`);
}

function statusFrom(value: unknown): number | null {
  if (!isObject(value)) return null;
  for (const candidate of [value.status, value.statusCode]) {
    if (typeof candidate === 'number') return candidate;
  }
  if (isObject(value.error)) return statusFrom(value.error);
  return null;
}

function throwForAccessStatus(value: unknown): void {
  const status = statusFrom(value);
  if (status === 401 || status === 403) throw new HopliteAccessError(status);
}

export function parseProjectAgentToolPayload(result: unknown): JsonObject {
  const envelope = result as {
    isError?: boolean;
    content?: Array<{ type?: string; text?: string }>;
  };
  const text = envelope.content?.find(item => item.type === 'text')?.text;
  if (!text) schemaDrift('MCP returned no JSON text payload');
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    schemaDrift('MCP returned invalid JSON');
  }
  throwForAccessStatus(parsed);
  if (envelope.isError) throw new Error('Hoplite project-agent read failed');
  if (!isObject(parsed)) schemaDrift('API payload must be an object');
  return parsed;
}

function apiCaller(client: Client): ApiCaller {
  return async (method, path) => {
    try {
      const result = await client.callTool(
        { name: 'hoplite_call_api', arguments: { method, path } },
        undefined,
        { timeout: 20_000, maxTotalTimeout: 20_000 },
      );
      return parseProjectAgentToolPayload(result);
    } catch (error) {
      if (error instanceof HopliteAccessError) throw error;
      const message = error instanceof Error ? error.message : String(error);
      if (/\b401\b|unauthorized|token expired/i.test(message)) throw new HopliteAccessError(401);
      if (/\b403\b|forbidden/i.test(message)) throw new HopliteAccessError(403);
      throw error;
    }
  };
}

function validatedProjectId(value: string | undefined): string {
  const id = value?.trim();
  if (!id || id.length > 128 || !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(id)) {
    throw new Error('A valid Hoplite project id is required');
  }
  return id;
}

function unwrapBody(payload: JsonObject): unknown {
  let value: unknown = payload;
  for (let depth = 0; depth < 3 && isObject(value); depth += 1) {
    throwForAccessStatus(value);
    if ('body' in value) {
      value = value.body;
      if (typeof value === 'string') {
        try {
          value = JSON.parse(value);
        } catch {
          schemaDrift('response body is not JSON');
        }
      }
      continue;
    }
    if ('data' in value && isObject(value.data)) {
      value = value.data;
      continue;
    }
    break;
  }
  return value;
}

function nullableString(value: unknown, field: string): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') schemaDrift(`${field} must be a string or null`);
  return value;
}

function parseProject(payload: JsonObject, expectedId: string): { id: string; name: string | null; settings: AgentSettings } {
  const body = unwrapBody(payload);
  if (!isObject(body)) schemaDrift('project response must be an object');
  const project = isObject(body.project) ? body.project : body;
  if (typeof project.id !== 'string') schemaDrift('project.id is required');
  if (project.id !== expectedId) schemaDrift('project.id does not match the requested project');
  const reasoningEffort = nullableString(project.reasoningEffort, 'reasoningEffort');
  const agentSpeed = nullableString(project.agentSpeed, 'agentSpeed');
  if (agentSpeed !== null && agentSpeed !== 'standard' && agentSpeed !== 'fast') {
    schemaDrift('agentSpeed is unsupported');
  }
  if (project.prReviewAutofixDefault !== null
    && project.prReviewAutofixDefault !== undefined
    && typeof project.prReviewAutofixDefault !== 'boolean') {
    schemaDrift('prReviewAutofixDefault must be a boolean or null');
  }
  return {
    id: project.id,
    name: nullableString(project.name, 'name'),
    settings: {
      defaultModel: nullableString(project.defaultModel, 'defaultModel'),
      reasoningEffort,
      agentSpeed,
      prReviewAutofixDefault: project.prReviewAutofixDefault ?? null,
      instructions: nullableString(project.instructions, 'instructions'),
    },
  };
}

function parseCatalog(payload: JsonObject): ModelCatalogEntry[] {
  const body = unwrapBody(payload);
  if (!isObject(body)) schemaDrift('model catalog response must be an object');
  const catalogBody = isObject(body.catalog) ? body.catalog : body;
  const models = Array.isArray(catalogBody.models) ? catalogBody.models : null;
  const runConfig = isObject(catalogBody.runConfig) ? catalogBody.runConfig : null;
  const fallbackIds = runConfig?.modelFallbackIds;
  if (fallbackIds !== undefined
    && (!Array.isArray(fallbackIds) || !fallbackIds.every(id => typeof id === 'string' && id.trim()))) {
    schemaDrift('runConfig.modelFallbackIds must be a non-empty string array');
  }
  if (!models && fallbackIds === undefined) {
    schemaDrift('model catalog requires models[] or runConfig.modelFallbackIds[]');
  }
  const parsed: ModelCatalogEntry[] = (models ?? []).map((candidate, index) => {
    if (!isObject(candidate) || typeof candidate.id !== 'string' || !candidate.id.trim()) {
      return schemaDrift(`models[${index}].id is required`);
    }
    if (candidate.capabilities === undefined || candidate.capabilities === null) {
      return { id: candidate.id, capabilities: null };
    }
    if (!isObject(candidate.capabilities)) return schemaDrift(`models[${index}].capabilities must be an object`);
    const reasoningLevels = candidate.capabilities.reasoningLevels;
    if (!Array.isArray(reasoningLevels) || !reasoningLevels.every(level => typeof level === 'string')) {
      return schemaDrift(`models[${index}].capabilities.reasoningLevels must be a string array`);
    }
    if (typeof candidate.capabilities.supportsFast !== 'boolean') {
      return schemaDrift(`models[${index}].capabilities.supportsFast must be a boolean`);
    }
    return {
      id: candidate.id,
      capabilities: {
        reasoningLevels: [...reasoningLevels],
        supportsFast: candidate.capabilities.supportsFast,
      },
    };
  });
  const byId = new Map(parsed.map(entry => [entry.id, entry]));
  for (const id of (fallbackIds as string[] | undefined) ?? []) {
    if (!byId.has(id)) byId.set(id, { id, capabilities: null });
  }
  return [...byId.values()];
}

function normalizeInheritable(value: string | undefined): string | null | undefined {
  if (value === undefined) return undefined;
  const normalized = value.trim();
  return normalized === '' || normalized.toLowerCase() === 'inherit' ? null : normalized;
}

function strictBoolean(value: string): boolean {
  if (value === 'true' || value === '1' || value === 'yes') return true;
  if (value === 'false' || value === '0' || value === 'no') return false;
  throw new Error('pr-review-autofix must be true or false');
}

function readInstructions(path: string): string | null {
  const absolute = resolve(path);
  const noFollow = constants.O_NOFOLLOW ?? 0;
  const nonBlock = constants.O_NONBLOCK ?? 0;
  let descriptor: number | null = null;
  try {
    descriptor = openSync(absolute, constants.O_RDONLY | noFollow | nonBlock);
    const stat = fstatSync(descriptor);
    if (!stat.isFile()) throw new Error('instructions-file must be a regular non-symlink file');
    if (stat.size > MAX_INSTRUCTIONS_LENGTH) {
      throw new Error(`instructions-file exceeds ${MAX_INSTRUCTIONS_LENGTH} bytes`);
    }
    const buffer = Buffer.alloc(MAX_INSTRUCTIONS_LENGTH + 1);
    let total = 0;
    while (total < buffer.length) {
      const bytesRead = readSync(descriptor, buffer, total, buffer.length - total, null);
      if (bytesRead === 0) break;
      total += bytesRead;
    }
    if (total > MAX_INSTRUCTIONS_LENGTH) {
      throw new Error(`instructions-file exceeds ${MAX_INSTRUCTIONS_LENGTH} bytes`);
    }
    const content = buffer.subarray(0, total).toString('utf8');
    if (content.length > MAX_INSTRUCTIONS_LENGTH) {
      throw new Error(`instructions-file exceeds ${MAX_INSTRUCTIONS_LENGTH} characters`);
    }
    return content.trim() === '' ? null : content;
  } finally {
    if (descriptor !== null) closeSync(descriptor);
  }
}

function requestedChanges(flags: Map<string, string>): Partial<AgentSettings> {
  const changes: Partial<AgentSettings> = {};
  const model = normalizeInheritable(flags.get('model'));
  const reasoning = normalizeInheritable(flags.get('reasoning'));
  const speed = normalizeInheritable(flags.get('speed'));
  if (model !== undefined) changes.defaultModel = model;
  if (reasoning !== undefined) changes.reasoningEffort = reasoning;
  if (speed !== undefined) {
    if (speed !== null && speed !== 'standard' && speed !== 'fast') {
      throw new Error('speed must be standard, fast, or inherit');
    }
    changes.agentSpeed = speed;
  }
  const autofix = flags.get('pr-review-autofix');
  if (autofix !== undefined) {
    const normalized = normalizeInheritable(autofix);
    changes.prReviewAutofixDefault = normalized === null ? null : strictBoolean(normalized!);
  }
  const instructionsFile = flags.get('instructions-file');
  const instructions = flags.get('instructions');
  if (instructionsFile !== undefined && instructions !== undefined) {
    throw new Error('Use only one of --instructions-file or --instructions inherit');
  }
  if (instructionsFile !== undefined) changes.instructions = readInstructions(instructionsFile);
  if (instructions !== undefined) {
    if (normalizeInheritable(instructions) !== null) {
      throw new Error('Inline instruction text is forbidden; use --instructions-file or --instructions inherit');
    }
    changes.instructions = null;
  }
  if (Object.keys(changes).length === 0) {
    throw new Error('At least one project agent setting flag is required');
  }
  return changes;
}

function validateAgainstCatalog(
  before: AgentSettings,
  requested: Partial<AgentSettings>,
  catalog: ModelCatalogEntry[],
): void {
  const modelChanged = 'defaultModel' in requested && requested.defaultModel !== before.defaultModel;
  const reasoningChanged = 'reasoningEffort' in requested
    && requested.reasoningEffort !== before.reasoningEffort;
  const speedChanged = 'agentSpeed' in requested && requested.agentSpeed !== before.agentSpeed;
  if (!modelChanged && !reasoningChanged && !speedChanged) return;
  const effectiveModel = 'defaultModel' in requested ? requested.defaultModel ?? null : before.defaultModel;
  const effectiveReasoning = 'reasoningEffort' in requested
    ? requested.reasoningEffort ?? null
    : before.reasoningEffort;
  const effectiveSpeed = 'agentSpeed' in requested ? requested.agentSpeed ?? null : before.agentSpeed;
  if (effectiveModel === null) {
    if (effectiveReasoning !== null || effectiveSpeed === 'fast') {
      throw new Error('A concrete model is required to validate reasoning or fast speed');
    }
    return;
  }
  const capabilitiesRequired = (modelChanged
    && (effectiveReasoning !== null || effectiveSpeed === 'fast'))
    || (reasoningChanged && effectiveReasoning !== null)
    || (speedChanged && effectiveSpeed === 'fast');
  if (!modelChanged && !capabilitiesRequired) return;
  const model = catalog.find(candidate => candidate.id === effectiveModel);
  if (!model) throw new Error(`Model ${effectiveModel} is not in the live Hoplite model catalog`);
  if (!capabilitiesRequired) return;
  if (!model.capabilities) {
    throw new Error(`Model ${effectiveModel} is listed by Hoplite but its capabilities are not evidenced`);
  }
  if (effectiveReasoning !== null && !model.capabilities.reasoningLevels.includes(effectiveReasoning)) {
    throw new Error(`Model ${effectiveModel} does not support reasoning effort ${effectiveReasoning}`);
  }
  if (effectiveSpeed === 'fast' && !model.capabilities.supportsFast) {
    throw new Error(`Model ${effectiveModel} does not support fast speed`);
  }
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (isObject(value)) {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

async function sha256(value: unknown): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(stableJson(value)));
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

function clientOperationId(value: string | undefined): string {
  const normalized = value?.trim() || `project-agents-${crypto.randomUUID()}`;
  if (normalized.length > 64 || /\s/.test(normalized)) {
    throw new Error('client-operation-id must be 64 characters or fewer and contain no whitespace');
  }
  return normalized;
}

function writeOwnerOnlyPlan(path: string, plan: JsonObject): string {
  const absolute = resolve(path);
  writeFileSync(absolute, `${JSON.stringify(plan, null, 2)}\n`, {
    encoding: 'utf8',
    flag: 'wx',
    mode: 0o600,
  });
  return absolute;
}

function instructionSummary(instructions: string | null): JsonObject {
  return {
    instructionsConfigured: instructions !== null && instructions.length > 0,
    instructionsLength: instructions?.length ?? 0,
  };
}

export async function projectAgentsGet(
  callApi: ApiCaller,
  projectId: string,
  flags: Map<string, string>,
): Promise<JsonObject> {
  const [projectPayload, catalogPayload] = await Promise.all([
    callApi('GET', `/api/projects/${encodeURIComponent(projectId)}`),
    callApi('GET', '/api/model-providers'),
  ]);
  const project = parseProject(projectPayload, projectId);
  const catalog = parseCatalog(catalogPayload);
  const model = project.settings.defaultModel === null
    ? null
    : catalog.find(candidate => candidate.id === project.settings.defaultModel) ?? null;
  const includeInstructions = flags.get('include-instructions');
  const include = includeInstructions === 'true' || includeInstructions === '1' || includeInstructions === 'yes';
  if (includeInstructions !== undefined && !include && !['false', '0', 'no'].includes(includeInstructions)) {
    throw new Error('include-instructions must be a boolean');
  }
  const output: JsonObject = {
    projectId: project.id,
    projectName: project.name,
    defaultModel: project.settings.defaultModel,
    reasoningEffort: project.settings.reasoningEffort,
    agentSpeed: project.settings.agentSpeed,
    prReviewAutofixDefault: project.settings.prReviewAutofixDefault,
    ...instructionSummary(project.settings.instructions),
    modelCatalogMatch: model !== null,
    modelCapabilitiesEvidenced: model?.capabilities !== null && model?.capabilities !== undefined,
    modelCapabilities: model?.capabilities ?? null,
  };
  if (include) {
    const instructions = project.settings.instructions ?? '';
    output.instructions = instructions.slice(0, MAX_PRINTED_INSTRUCTIONS_LENGTH);
    output.instructionsTruncated = instructions.length > MAX_PRINTED_INSTRUCTIONS_LENGTH;
    output.instructionsLimit = MAX_PRINTED_INSTRUCTIONS_LENGTH;
  }
  return output;
}

export async function projectAgentsPlanSet(
  callApi: ApiCaller,
  projectId: string,
  flags: Map<string, string>,
): Promise<JsonObject> {
  const [projectPayload, catalogPayload] = await Promise.all([
    callApi('GET', `/api/projects/${encodeURIComponent(projectId)}`),
    callApi('GET', '/api/model-providers'),
  ]);
  const project = parseProject(projectPayload, projectId);
  const catalog = parseCatalog(catalogPayload);
  const requested = requestedChanges(flags);
  validateAgainstCatalog(project.settings, requested, catalog);
  const changes: Partial<AgentSettings> = {};
  for (const field of PROJECT_FIELDS) {
    if (field in requested && requested[field] !== project.settings[field]) {
      Object.assign(changes, { [field]: requested[field] });
    }
  }
  const changedFields = PROJECT_FIELDS.filter(field => field in changes);
  const beforeStateDigest = await sha256(project.settings);
  const plan: JsonObject = {
    version: 1,
    kind: 'hoplite.project-agent-defaults.plan',
    target: {
      projectId,
      method: 'PATCH',
      path: `/api/projects/${encodeURIComponent(projectId)}`,
    },
    changes,
    changedFields,
    clientOperationId: clientOperationId(flags.get('client-operation-id')),
    contractIdentity: {
      source: 'authenticated-client',
      hopliteWebRelease: HOPLITE_WEB_RELEASE,
      settingsBundleSha256: SETTINGS_BUNDLE_SHA256,
      writeAuthentication: 'unverified',
      applySupported: false,
    },
    clientIdentity: {
      name: 'hoplite-unofficial-toolkit',
      version: '0.1.0',
      command: 'project-agents-plan-set',
    },
    beforeStateDigest,
  };
  const containsInstructionText = typeof changes.instructions === 'string';
  const outputPath = flags.get('out');
  if (containsInstructionText && !outputPath) {
    throw new Error('--out <plan.json> is required when setting instructions');
  }
  if (outputPath) {
    const path = writeOwnerOnlyPlan(outputPath, plan);
    return {
      planned: true,
      remoteStateChanged: false,
      applySupported: false,
      projectId,
      changedFields,
      beforeStateDigest,
      clientOperationId: plan.clientOperationId,
      planPath: path,
      planFileMode: '0600',
      instructionsIncludedInPlanFile: containsInstructionText,
      ...instructionSummary('instructions' in changes ? changes.instructions ?? null : project.settings.instructions),
    };
  }
  return {
    planned: true,
    remoteStateChanged: false,
    applySupported: false,
    plan,
  };
}

const GET_FLAGS = new Set(['include-instructions']);
const PLAN_FLAGS = new Set([
  'model',
  'reasoning',
  'speed',
  'pr-review-autofix',
  'instructions-file',
  'instructions',
  'out',
  'client-operation-id',
]);

export function validateProjectAgentCommandArgs(
  command: 'project-agents-get' | 'project-agents-plan-set',
  positionals: string[],
  flags: Map<string, string>,
): string {
  if (positionals.length !== 1) {
    throw new Error(`${command} requires exactly one <project-id> positional`);
  }
  const allowed = command === 'project-agents-get' ? GET_FLAGS : PLAN_FLAGS;
  for (const flag of flags.keys()) {
    if (!allowed.has(flag)) throw new Error(`Unknown flag for ${command}: --${flag}`);
  }
  return validatedProjectId(positionals[0]);
}

async function runGet({ client, positionals, flags }: McpCommandContext): Promise<JsonObject> {
  const projectId = validateProjectAgentCommandArgs('project-agents-get', positionals, flags);
  return projectAgentsGet(apiCaller(client), projectId, flags);
}

async function runPlanSet({ client, positionals, flags }: McpCommandContext): Promise<JsonObject> {
  const projectId = validateProjectAgentCommandArgs('project-agents-plan-set', positionals, flags);
  return projectAgentsPlanSet(apiCaller(client), projectId, flags);
}

export const projectAgentDefaultCommandDefinitions: readonly CliCommandDefinition[] = [
  {
    name: 'project-agents-get',
    description: 'Read a safe projection of project agent defaults; use bounded --include-instructions explicitly',
    transport: 'mcp',
    validate: ({ positionals, flags }) => {
      validateProjectAgentCommandArgs('project-agents-get', positionals, flags);
    },
    run: runGet,
  },
  {
    name: 'project-agents-plan-set',
    description: 'Validate proposed project agent defaults and create a local no-apply plan; instructions require --instructions-file',
    transport: 'mcp',
    validate: ({ positionals, flags }) => {
      validateProjectAgentCommandArgs('project-agents-plan-set', positionals, flags);
    },
    run: runPlanSet,
  },
];

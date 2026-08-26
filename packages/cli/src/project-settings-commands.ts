import type { Client } from '@modelcontextprotocol/sdk/client/index.js';

import type { CliCommandDefinition, CommandResult } from './command-registry';
import { redactAndBound, safeBoundedString } from './output-safety';

type JsonObject = Record<string, unknown>;

type ProjectScriptName = 'setup' | 'run' | 'archive';

type ParsedProject = {
  id: string;
  name: string;
  description: string | null;
  defaultBranch: string | null;
  previewPort: number;
  setupScript: string | null;
  runScript: string | null;
  archiveScript: string | null;
  instructions: string | null;
  defaultModel: string | null;
  reasoningEffort: string | null;
  agentSpeed: string | null;
  prReviewAutofixDefault: boolean | null;
  framework: string | null;
  prebuildsEnabled: boolean | null;
  sandboxConfigured: boolean;
  createdAt: string | null;
  updatedAt: string | null;
};

type RepositoryScript = {
  enabled: boolean;
  command: string | null;
};

export type ParsedRepositorySettings = {
  path: string;
  scripts: Record<ProjectScriptName, RepositoryScript> | null;
  previewPort: number | null;
  invalid: boolean;
};

type ApiEnvelope = {
  ok: boolean;
  status: number;
  body: unknown;
};

const PROJECT_REASONING_EFFORTS = new Set(['off', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
const PROJECT_AGENT_SPEEDS = new Set(['standard', 'fast']);
const MAX_COMMAND_OUTPUT = 2_000;
const MAX_INSTRUCTIONS_OUTPUT = 8_000;
const MAX_PATH_OUTPUT = 1_024;
const MAX_ID_OUTPUT = 512;
const MAX_NAME_OUTPUT = 512;
const MAX_BRANCH_OUTPUT = 512;
const MAX_MODEL_OUTPUT = 1_024;
const MAX_FRAMEWORK_OUTPUT = 512;
const MAX_DATE_OUTPUT = 64;
const MAX_MESSAGE_OUTPUT = 500;
const MAX_FEATURE_STRING_OUTPUT = MAX_INSTRUCTIONS_OUTPUT;
const MCP_TIMEOUT_MS = 20_000;

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function schemaError(surface: string, detail: string): never {
  throw new Error(`${surface} response schema drift: ${detail}`);
}

function requiredString(value: unknown, field: string, surface: string): string {
  if (typeof value !== 'string' || value.length === 0) schemaError(surface, `${field} must be a non-empty string`);
  return value;
}

function nullableString(value: unknown, field: string, surface: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') schemaError(surface, `${field} must be a string or null`);
  return value;
}

function nullableBoolean(value: unknown, field: string, surface: string): boolean | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'boolean') schemaError(surface, `${field} must be a boolean or null`);
  return value;
}

function nullableDateString(value: unknown, field: string, surface: string): string | null {
  const parsed = nullableString(value, field, surface);
  if (parsed !== null && !Number.isFinite(Date.parse(parsed))) schemaError(surface, `${field} must be an ISO date-time or null`);
  return parsed;
}

function optionalEnum(
  value: unknown,
  field: string,
  allowed: ReadonlySet<string>,
  surface: string,
): string | null {
  const parsed = nullableString(value, field, surface);
  if (parsed !== null && !allowed.has(parsed)) schemaError(surface, `${field} contains an unknown value`);
  return parsed;
}

function parseProjectResponse(body: unknown): ParsedProject {
  if (!isObject(body) || body.ok !== true || !isObject(body.project)) {
    schemaError('Project', 'expected { ok: true, project: object }');
  }
  const project = body.project;
  if (!Number.isInteger(project.previewPort) || (project.previewPort as number) < 3000 || (project.previewPort as number) > 9999) {
    schemaError('Project', 'previewPort must be an integer from 3000 through 9999');
  }
  if (project.sandboxSpec !== undefined && project.sandboxSpec !== null && !isObject(project.sandboxSpec)) {
    schemaError('Project', 'sandboxSpec must be an object or null');
  }

  return {
    id: requiredString(project.id, 'id', 'Project'),
    name: requiredString(project.name, 'name', 'Project'),
    description: nullableString(project.description, 'description', 'Project'),
    defaultBranch: nullableString(project.defaultBranch, 'defaultBranch', 'Project'),
    previewPort: project.previewPort as number,
    setupScript: nullableString(project.setupScript, 'setupScript', 'Project'),
    runScript: nullableString(project.runScript, 'runScript', 'Project'),
    archiveScript: nullableString(project.archiveScript, 'archiveScript', 'Project'),
    instructions: nullableString(project.instructions, 'instructions', 'Project'),
    defaultModel: nullableString(project.defaultModel, 'defaultModel', 'Project'),
    reasoningEffort: optionalEnum(project.reasoningEffort, 'reasoningEffort', PROJECT_REASONING_EFFORTS, 'Project'),
    agentSpeed: optionalEnum(project.agentSpeed, 'agentSpeed', PROJECT_AGENT_SPEEDS, 'Project'),
    prReviewAutofixDefault: nullableBoolean(project.prReviewAutofixDefault, 'prReviewAutofixDefault', 'Project'),
    framework: nullableString(project.framework, 'framework', 'Project'),
    prebuildsEnabled: nullableBoolean(project.prebuildsEnabled, 'prebuildsEnabled', 'Project'),
    sandboxConfigured: project.sandboxSpec !== undefined && project.sandboxSpec !== null,
    createdAt: nullableDateString(project.createdAt, 'createdAt', 'Project'),
    updatedAt: nullableDateString(project.updatedAt, 'updatedAt', 'Project'),
  };
}

function parseRepositoryScript(value: unknown, field: ProjectScriptName): RepositoryScript {
  if (!isObject(value) || typeof value.enabled !== 'boolean') {
    schemaError('Repository settings', `scripts.${field} must contain enabled and command`);
  }
  return {
    enabled: value.enabled,
    command: nullableString(value.command, `scripts.${field}.command`, 'Repository settings'),
  };
}

export function parseRepositorySettingsResponse(body: unknown): ParsedRepositorySettings {
  let raw: unknown = body;
  // The authenticated client observes the normal `{ ok, repoSettings }`
  // envelope. Accept the bare compatibility contract too because MCP API
  // bridges have returned the unwrapped body in earlier deployments.
  if (isObject(body) && body.ok === true && body.repoSettings !== undefined) raw = body.repoSettings;
  if (!isObject(raw)) schemaError('Repository settings', 'expected a repository settings object');
  if (typeof raw.invalid !== 'boolean') schemaError('Repository settings', 'invalid must be a boolean');
  if (raw.previewPort !== null && (!Number.isInteger(raw.previewPort) || (raw.previewPort as number) < 1 || (raw.previewPort as number) > 65_535)) {
    schemaError('Repository settings', 'previewPort must be an integer or null');
  }
  if (raw.scripts !== null && !isObject(raw.scripts)) {
    schemaError('Repository settings', 'scripts must be an object or null');
  }

  return {
    path: requiredString(raw.path, 'path', 'Repository settings'),
    scripts: raw.scripts === null
      ? null
      : {
          setup: parseRepositoryScript(raw.scripts.setup, 'setup'),
          run: parseRepositoryScript(raw.scripts.run, 'run'),
          archive: parseRepositoryScript(raw.scripts.archive, 'archive'),
        },
    previewPort: raw.previewPort as number | null,
    invalid: raw.invalid,
  };
}

function boundedValue(value: string, maximum: number): JsonObject {
  return redactAndBound(value, maximum);
}

function flagEnabled(flags: Map<string, string>, name: string): boolean {
  const value = flags.get(name);
  if (value === undefined) return false;
  if (value === 'true' || value === '1' || value === 'yes') return true;
  if (value === 'false' || value === '0' || value === 'no') return false;
  throw new Error(`--${name} expects a boolean`);
}

export function sanitizeFeatureResult(value: unknown, depth = 0): unknown {
  if (depth > 12) return '[truncated]';
  if (typeof value === 'string') return safeBoundedString(value, MAX_FEATURE_STRING_OUTPUT);
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.slice(0, 100).map(item => sanitizeFeatureResult(item, depth + 1));
  const result: JsonObject = {};
  for (const [key, nested] of Object.entries(value).slice(0, 100)) {
    result[key] = sanitizeFeatureResult(nested, depth + 1);
  }
  return result;
}

function projectIdFrom(positionals: string[]): string {
  const projectId = positionals[0]?.trim();
  if (!projectId || projectId.length > 512 || /[\u0000-\u001f\u007f]/.test(projectId)) {
    throw new Error('A valid Hoplite project id is required');
  }
  return projectId;
}

function projectCommand(project: ParsedProject, name: ProjectScriptName): string | null {
  if (name === 'setup') return project.setupScript;
  if (name === 'run') return project.runScript;
  return project.archiveScript;
}

function projectProjection(
  project: ParsedProject,
  options: { includeInstructions: boolean; showCommands: boolean },
): JsonObject {
  const commands = Object.fromEntries((['setup', 'run', 'archive'] as const).map(name => {
    const command = projectCommand(project, name);
    return [name, {
      configured: command !== null,
      ...(options.showCommands && command !== null ? { command: boundedValue(command, MAX_COMMAND_OUTPUT) } : {}),
    }];
  }));

  return {
    id: safeBoundedString(project.id, MAX_ID_OUTPUT),
    name: safeBoundedString(project.name, MAX_NAME_OUTPUT),
    descriptionConfigured: project.description !== null,
    defaultBranch: project.defaultBranch === null ? null : safeBoundedString(project.defaultBranch, MAX_BRANCH_OUTPUT),
    previewPort: project.previewPort,
    commands,
    instructions: {
      configured: project.instructions !== null,
      ...(options.includeInstructions && project.instructions !== null
        ? { content: boundedValue(project.instructions, MAX_INSTRUCTIONS_OUTPUT) }
        : {}),
    },
    agents: {
      defaultModel: project.defaultModel === null ? null : safeBoundedString(project.defaultModel, MAX_MODEL_OUTPUT),
      reasoningEffort: project.reasoningEffort === null ? null : safeBoundedString(project.reasoningEffort, 32),
      speed: project.agentSpeed === null ? null : safeBoundedString(project.agentSpeed, 32),
      prReviewAutofixDefault: project.prReviewAutofixDefault,
    },
    framework: project.framework === null ? null : safeBoundedString(project.framework, MAX_FRAMEWORK_OUTPUT),
    prebuildsEnabled: project.prebuildsEnabled,
    sandboxConfigured: project.sandboxConfigured,
    createdAt: project.createdAt === null ? null : safeBoundedString(project.createdAt, MAX_DATE_OUTPUT),
    updatedAt: project.updatedAt === null ? null : safeBoundedString(project.updatedAt, MAX_DATE_OUTPUT),
  };
}

function parseToolApiEnvelope(result: unknown): ApiEnvelope {
  if (!isObject(result) || !Array.isArray(result.content)) {
    schemaError('Hoplite MCP', 'expected content array');
  }
  const textItem = result.content.find(item => isObject(item) && item.type === 'text' && typeof item.text === 'string');
  if (!isObject(textItem) || typeof textItem.text !== 'string') {
    schemaError('Hoplite MCP', 'expected JSON text content');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(textItem.text);
  } catch {
    schemaError('Hoplite MCP', 'text content was not JSON');
  }
  if (!isObject(parsed) || typeof parsed.ok !== 'boolean' || !Number.isInteger(parsed.status)) {
    schemaError('Hoplite MCP API', 'expected boolean ok and integer status');
  }
  return { ok: parsed.ok, status: parsed.status as number, body: parsed.body };
}

async function callReadRoute(client: Client, path: string): Promise<ApiEnvelope> {
  const result = await client.callTool(
    { name: 'hoplite_call_api', arguments: { method: 'GET', path } },
    undefined,
    { timeout: MCP_TIMEOUT_MS, maxTotalTimeout: MCP_TIMEOUT_MS },
  );
  return parseToolApiEnvelope(result);
}

type ReadSurface = 'project' | 'repository-settings';

export function classifyReadFailure(status: number, surface: ReadSurface): CommandResult {
  if (status === 401) {
    return {
      ok: false,
      status,
      outcome: 'unsupported_credential',
      availability: 'unknown',
      message: 'The current MCP OAuth credential was not accepted for this route; browser-session availability was not evaluated.',
    };
  }
  if (status === 403) {
    return {
      ok: false,
      status,
      outcome: 'role_denied',
      availability: 'unknown',
      message: 'The current principal is not allowed to read this surface; broader product availability was not evaluated.',
    };
  }
  if (status === 404) {
    return {
      ok: false,
      status,
      outcome: surface === 'project' ? 'project_absent' : 'repository_settings_absent',
      availability: 'unknown',
      message: surface === 'project'
        ? 'The project was not found or is not visible to the current principal.'
        : 'Repository settings were absent or this compatibility route is unavailable to the current principal.',
    };
  }
  return {
    ok: false,
    status,
    outcome: 'request_failed',
    availability: 'unknown',
    message: 'The settings read did not succeed; no availability conclusion was made.',
  };
}

function schemaDriftResult(error: unknown, surface: ReadSurface, status = 200): CommandResult {
  const message = error instanceof Error ? error.message : 'Response did not match the expected schema';
  return {
    ok: false,
    status,
    outcome: 'schema_drift',
    surface,
    availability: 'unknown',
    message: safeBoundedString(message, MAX_MESSAGE_OUTPUT),
  };
}

export function resolveProjectCommands(
  project: ParsedProject,
  repository: ParsedRepositorySettings | null,
  showCommands: boolean,
): { commands: Record<ProjectScriptName, JsonObject>; warnings: string[] } {
  const warnings: string[] = [];
  const ignoredRepository = repository?.invalid === true;
  if (ignoredRepository) warnings.push('Repository settings are marked invalid and were ignored.');

  const resolveOne = (name: ProjectScriptName): JsonObject => {
    const projectValue = projectCommand(project, name);
    if (projectValue !== null) {
      return {
        state: 'enabled',
        source: 'project',
        ...(showCommands ? { command: boundedValue(projectValue, MAX_COMMAND_OUTPUT) } : {}),
      };
    }

    const repoValue = ignoredRepository ? null : repository?.scripts?.[name] ?? null;
    if (repoValue === null) return { state: 'unset', source: 'none' };
    if (!repoValue.enabled) return { state: 'disabled', source: 'repository' };
    if (repoValue.command === null) {
      warnings.push(`Repository ${name} is enabled without a command and was ignored.`);
      return { state: 'unset', source: 'none' };
    }
    return {
      state: 'enabled',
      source: 'repository',
      ...(showCommands ? { command: boundedValue(repoValue.command, MAX_COMMAND_OUTPUT) } : {}),
    };
  };
  const commands: Record<ProjectScriptName, JsonObject> = {
    setup: resolveOne('setup'),
    run: resolveOne('run'),
    archive: resolveOne('archive'),
  };

  return {
    commands,
    warnings: warnings.map(warning => safeBoundedString(warning, MAX_MESSAGE_OUTPUT)),
  };
}

async function getProjectSettings(
  client: Client,
  positionals: string[],
  flags: Map<string, string>,
): Promise<CommandResult> {
  const projectId = projectIdFrom(positionals);
  const response = await callReadRoute(client, `/api/projects/${encodeURIComponent(projectId)}`);
  if (!response.ok || response.status !== 200) return classifyReadFailure(response.status, 'project');
  try {
    const project = parseProjectResponse(response.body);
    return {
      ok: true,
      status: response.status,
      availability: 'confirmed_for_current_credential',
      project: projectProjection(project, {
        includeInstructions: flagEnabled(flags, 'include-instructions'),
        showCommands: flagEnabled(flags, 'show-commands'),
      }),
    };
  } catch (error) {
    return schemaDriftResult(error, 'project', response.status);
  }
}

async function resolveProjectSettings(
  client: Client,
  positionals: string[],
  flags: Map<string, string>,
): Promise<CommandResult> {
  const projectId = projectIdFrom(positionals);
  const showCommands = flagEnabled(flags, 'show-commands');
  const includeInstructions = flagEnabled(flags, 'include-instructions');
  const encodedProjectId = encodeURIComponent(projectId);
  const projectResponse = await callReadRoute(client, `/api/projects/${encodedProjectId}`);
  if (!projectResponse.ok || projectResponse.status !== 200) {
    return classifyReadFailure(projectResponse.status, 'project');
  }

  let project: ParsedProject;
  try {
    project = parseProjectResponse(projectResponse.body);
  } catch (error) {
    return schemaDriftResult(error, 'project', projectResponse.status);
  }

  const repoResponse = await callReadRoute(client, `/api/projects/${encodedProjectId}/repo-settings`);
  if (!repoResponse.ok || repoResponse.status !== 200) {
    const failure = classifyReadFailure(repoResponse.status, 'repository-settings');
    if (repoResponse.status !== 404) return failure;
    const resolved = resolveProjectCommands(project, null, showCommands);
    return {
      ok: true,
      status: 200,
      availability: 'partial',
      project: projectProjection(project, { includeInstructions, showCommands: false }),
      repository: failure,
      effective: { commands: resolved.commands },
      warnings: [failure.message, ...resolved.warnings],
    };
  }

  let repository: ParsedRepositorySettings;
  try {
    repository = parseRepositorySettingsResponse(repoResponse.body);
  } catch (error) {
    return schemaDriftResult(error, 'repository-settings', repoResponse.status);
  }
  const resolved = resolveProjectCommands(project, repository, showCommands);
  return {
    ok: true,
    status: 200,
    availability: 'confirmed_for_current_credential',
    project: projectProjection(project, { includeInstructions, showCommands: false }),
    repository: {
      status: 'available',
      path: boundedValue(repository.path, MAX_PATH_OUTPUT),
      invalid: repository.invalid,
      previewPort: repository.previewPort,
      scriptsConfigured: repository.scripts !== null,
    },
    effective: { commands: resolved.commands },
    warnings: resolved.warnings,
  };
}

export const projectSettingsCommandDefinitions: readonly CliCommandDefinition[] = [
  {
    name: 'project-settings-get',
    description: 'Read a safe project-settings projection; use --show-commands or --include-instructions for bounded sensitive fields',
    transport: 'mcp',
    run: async ({ client, positionals, flags }) => sanitizeFeatureResult(
      await getProjectSettings(client, positionals, flags),
    ) as CommandResult,
  },
  {
    name: 'project-settings-resolve',
    description: 'Resolve project command overrides against compatible repository settings; supports bounded --show-commands',
    transport: 'mcp',
    run: async ({ client, positionals, flags }) => sanitizeFeatureResult(
      await resolveProjectSettings(client, positionals, flags),
    ) as CommandResult,
  },
];

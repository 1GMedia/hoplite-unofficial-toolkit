import { createHash } from 'node:crypto';

import type { Client } from '@modelcontextprotocol/sdk/client/index.js';

import type { CliCommandDefinition, CommandResult } from './command-registry';
import {
  loadResourcePolicy,
  validateResourcePolicyGrant,
} from './compatibility';
import { redactAndBound, safeBoundedString } from './output-safety';
import {
  parseRepositorySettingsResponse,
  sanitizeFeatureResult,
  type ParsedRepositorySettings,
} from './project-settings-commands';

type JsonObject = Record<string, unknown>;

type ProjectBinding = {
  projectId: string;
  projectPreviewPort: number;
  repositories: Array<{
    fullName: string;
    branch: string | null;
  }>;
};

type AvailableRepository = {
  id: string;
  fullName: string;
  defaultBranch: string;
  private: boolean;
};

type ApiEnvelope = {
  ok: boolean;
  status: number;
  body: unknown;
};

const MCP_TIMEOUT_MS = 20_000;
const MAX_ID_LENGTH = 512;
const MAX_NAME_LENGTH = 512;
const MAX_BRANCH_LENGTH = 512;
const MAX_PATH_LENGTH = 1_024;
const MAX_MESSAGE_LENGTH = 800;
const DIGEST_RE = /^[a-f0-9]{64}$/;

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

function optionalString(value: unknown, field: string, surface: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || value.length === 0) schemaError(surface, `${field} must be a non-empty string or null`);
  return value;
}

function parseProjectBindingResponse(body: unknown, expectedProjectId: string): ProjectBinding {
  if (!isObject(body) || body.ok !== true || !isObject(body.project)) {
    schemaError('Project repository', 'expected { ok: true, project: object }');
  }
  const project = body.project;
  const projectId = requiredString(project.id, 'project.id', 'Project repository');
  if (projectId !== expectedProjectId) schemaError('Project repository', 'project.id did not match the requested project');
  if (!Number.isInteger(project.previewPort) || (project.previewPort as number) < 3000 || (project.previewPort as number) > 9999) {
    schemaError('Project repository', 'project.previewPort must be an integer from 3000 through 9999');
  }
  if (project.repos !== undefined && !Array.isArray(project.repos)) {
    schemaError('Project repository', 'project.repos must be an array when present');
  }
  const repositories = (project.repos ?? []).map((raw, index) => {
    if (!isObject(raw)) schemaError('Project repository', `project.repos[${index}] must be an object`);
    return {
      fullName: requiredString(raw.repoFullName, `project.repos[${index}].repoFullName`, 'Project repository'),
      branch: optionalString(raw.branch, `project.repos[${index}].branch`, 'Project repository'),
    };
  });
  return {
    projectId,
    projectPreviewPort: project.previewPort as number,
    repositories,
  };
}

function parseAvailableRepositoriesResponse(body: unknown): AvailableRepository[] {
  if (!isObject(body) || body.ok !== true || !Array.isArray(body.repositories)) {
    schemaError('Repository catalog', 'expected { ok: true, repositories: array }');
  }
  return body.repositories.map((raw, index) => {
    if (!isObject(raw)) schemaError('Repository catalog', `repositories[${index}] must be an object`);
    if (typeof raw.private !== 'boolean') schemaError('Repository catalog', `repositories[${index}].private must be a boolean`);
    return {
      id: requiredString(raw.id, `repositories[${index}].id`, 'Repository catalog'),
      fullName: requiredString(raw.fullName, `repositories[${index}].fullName`, 'Repository catalog'),
      defaultBranch: requiredString(raw.defaultBranch, `repositories[${index}].defaultBranch`, 'Repository catalog'),
      private: raw.private,
    };
  });
}

function parseToolEnvelope(result: unknown): ApiEnvelope {
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
  return parseToolEnvelope(result);
}

function readFailure(status: number, surface: string): CommandResult {
  const outcome = {
    401: 'unsupported_credential',
    402: 'subscription_required',
    403: 'role_denied',
    404: 'absent_or_unavailable',
    501: 'deployment_unavailable',
  }[status] ?? 'request_failed';
  return {
    ok: false,
    status,
    outcome,
    surface,
    availability: 'unknown',
    message: safeBoundedString(
      'The read did not succeed for the current credential and principal; no broader product availability conclusion was made.',
      MAX_MESSAGE_LENGTH,
    ),
  };
}

function schemaDrift(error: unknown, surface: string): CommandResult {
  const message = error instanceof Error ? error.message : 'Response did not match the expected schema';
  return {
    ok: false,
    status: 200,
    outcome: 'schema_drift',
    surface,
    availability: 'unknown',
    message: safeBoundedString(message, MAX_MESSAGE_LENGTH),
  };
}

function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function bindingState(binding: ProjectBinding): JsonObject {
  return {
    projectId: binding.projectId,
    repositories: binding.repositories.map(repository => ({
      fullName: repository.fullName,
      branch: repository.branch,
    })),
  };
}

function bindingProjection(binding: ProjectBinding): JsonObject {
  const selected = binding.repositories[0] ?? null;
  return {
    projectId: safeBoundedString(binding.projectId, MAX_ID_LENGTH),
    stateDigest: digest(bindingState(binding)),
    bound: selected !== null,
    bindingCount: binding.repositories.length,
    selected: selected === null
      ? null
      : {
          fullName: safeBoundedString(selected.fullName, MAX_NAME_LENGTH),
          branch: selected.branch === null ? null : safeBoundedString(selected.branch, MAX_BRANCH_LENGTH),
        },
    warnings: binding.repositories.length > 1
      ? ['The public project response contained multiple repository bindings; only the first matches current web-client behavior.']
      : [],
  };
}

function repoSettingsProjection(settings: ParsedRepositorySettings): JsonObject {
  return {
    path: redactAndBound(settings.path, MAX_PATH_LENGTH),
    invalid: settings.invalid,
    previewPort: settings.previewPort,
    scripts: settings.scripts === null
      ? null
      : Object.fromEntries((['setup', 'run', 'archive'] as const).map(name => [name, {
          enabled: settings.scripts![name].enabled,
          commandConfigured: settings.scripts![name].command !== null,
        }])),
  };
}

function projectId(positionals: string[]): string {
  return exactValue(positionals[0], 'project id', MAX_ID_LENGTH);
}

function exactValue(value: string | undefined, label: string, maximum = MAX_ID_LENGTH): string {
  const normalized = value?.trim();
  if (!normalized || normalized.length > maximum || /[\u0000-\u001f\u007f]/.test(normalized)) {
    throw new Error(`A valid ${label} is required`);
  }
  return normalized;
}

function requiredFlag(flags: Map<string, string>, name: string, maximum = MAX_ID_LENGTH): string {
  return exactValue(flags.get(name), `--${name}`, maximum);
}

function exactOperationId(flags: Map<string, string>): string {
  const value = requiredFlag(flags, 'client-operation-id', 128);
  if (/\s/.test(value)) throw new Error('--client-operation-id must not contain whitespace');
  return value;
}

function exactDigest(flags: Map<string, string>): string {
  const value = flags.get('before-digest')?.trim().toLowerCase();
  if (!value || !DIGEST_RE.test(value)) throw new Error('--before-digest must be a lowercase SHA-256 digest');
  return value;
}

function booleanFlag(flags: Map<string, string>, name: string): boolean {
  const value = flags.get(name);
  if (value === undefined) return false;
  if (value === 'true' || value === '1' || value === 'yes') return true;
  if (value === 'false' || value === '0' || value === 'no') return false;
  throw new Error(`--${name} expects a boolean`);
}

function policyGrant(
  flags: Map<string, string>,
  targetProjectId: string,
  capability: 'project.repository.bind' | 'project.repository.unbind',
): JsonObject {
  const path = requiredFlag(flags, 'policy', 4_096);
  const accountId = requiredFlag(flags, 'account-id');
  const workspaceId = requiredFlag(flags, 'workspace-id');
  const origin = requiredFlag(flags, 'origin', 2_048);
  const policy = loadResourcePolicy(path);
  const grant = validateResourcePolicyGrant(policy, {
    accountId,
    workspaceId,
    origin,
    kind: 'project',
    resourceId: targetProjectId,
    capability,
  });
  return {
    authorizedForLocalPlanning: grant.authorized === true,
    capability,
    risk: grant.risk,
    expiresAt: policy.expiresAt,
  };
}

async function repositoryGet(client: Client, positionals: string[]): Promise<CommandResult> {
  const targetProjectId = projectId(positionals);
  const response = await callReadRoute(client, `/api/projects/${encodeURIComponent(targetProjectId)}`);
  if (!response.ok || response.status !== 200) return readFailure(response.status, 'project-repository');
  try {
    const binding = parseProjectBindingResponse(response.body, targetProjectId);
    return {
      ok: true,
      status: 200,
      availability: 'confirmed_for_current_credential',
      binding: bindingProjection(binding),
    };
  } catch (error) {
    return schemaDrift(error, 'project-repository');
  }
}

async function repositoryResolve(client: Client, positionals: string[]): Promise<CommandResult> {
  const targetProjectId = projectId(positionals);
  const encodedProjectId = encodeURIComponent(targetProjectId);
  const projectResponse = await callReadRoute(client, `/api/projects/${encodedProjectId}`);
  if (!projectResponse.ok || projectResponse.status !== 200) return readFailure(projectResponse.status, 'project-repository');
  let binding: ProjectBinding;
  try {
    binding = parseProjectBindingResponse(projectResponse.body, targetProjectId);
  } catch (error) {
    return schemaDrift(error, 'project-repository');
  }

  const catalogResponse = await callReadRoute(client, '/api/source-control/github/repositories');
  if (!catalogResponse.ok || catalogResponse.status !== 200) return readFailure(catalogResponse.status, 'repository-catalog');
  let catalog: AvailableRepository[];
  try {
    catalog = parseAvailableRepositoriesResponse(catalogResponse.body);
  } catch (error) {
    return schemaDrift(error, 'repository-catalog');
  }

  const selected = binding.repositories[0] ?? null;
  const matches = selected === null ? [] : catalog.filter(repository => repository.fullName === selected.fullName);
  const repository = matches.length === 1 ? matches[0]! : null;
  let settings: ParsedRepositorySettings | null = null;
  let settingsStatus: JsonObject = { availability: selected === null ? 'not_applicable' : 'unknown' };
  if (selected !== null) {
    const settingsResponse = await callReadRoute(client, `/api/projects/${encodedProjectId}/repo-settings`);
    if (settingsResponse.ok && settingsResponse.status === 200) {
      try {
        settings = parseRepositorySettingsResponse(settingsResponse.body);
        settingsStatus = { availability: 'confirmed_for_current_credential', settings: repoSettingsProjection(settings) };
      } catch (error) {
        settingsStatus = schemaDrift(error, 'repository-settings');
      }
    } else {
      settingsStatus = readFailure(settingsResponse.status, 'repository-settings');
    }
  }

  const warnings = [...(binding.repositories.length > 1
    ? ['Multiple project repository bindings were returned; current web-client behavior selects only the first.']
    : [])];
  if (selected !== null && matches.length === 0) warnings.push('The saved repository was not present in the current official GitHub repository catalog.');
  if (matches.length > 1) warnings.push('The saved repository name matched multiple catalog entries, so no repository ID was resolved.');

  return {
    ok: true,
    status: 200,
    availability: settingsStatus.availability === 'confirmed_for_current_credential'
      || settingsStatus.availability === 'not_applicable'
      ? 'confirmed_for_current_credential'
      : 'partial',
    binding: bindingProjection(binding),
    repository: repository === null
      ? { resolved: false }
      : {
          resolved: true,
          id: safeBoundedString(repository.id, MAX_ID_LENGTH),
          fullName: safeBoundedString(repository.fullName, MAX_NAME_LENGTH),
          private: repository.private,
          defaultBranch: safeBoundedString(repository.defaultBranch, MAX_BRANCH_LENGTH),
        },
    effectiveBaseBranch: selected?.branch !== null && selected?.branch !== undefined
      ? { value: safeBoundedString(selected.branch, MAX_BRANCH_LENGTH), source: 'project-binding' }
      : repository === null
        ? { value: null, source: 'unresolved' }
        : { value: safeBoundedString(repository.defaultBranch, MAX_BRANCH_LENGTH), source: 'repository-default' },
    projectPreviewPort: binding.projectPreviewPort,
    repositorySettings: settingsStatus,
    warnings,
    previewPrecedence: 'not_resolved',
  };
}

function bindPlan(positionals: string[], flags: Map<string, string>): CommandResult {
  const targetProjectId = projectId(positionals);
  const grant = policyGrant(flags, targetProjectId, 'project.repository.bind');
  const beforeDigest = exactDigest(flags);
  const repositoryId = requiredFlag(flags, 'repository-id');
  const repositoryFullName = requiredFlag(flags, 'repository-full-name', MAX_NAME_LENGTH);
  const defaultBranch = requiredFlag(flags, 'default-branch', MAX_BRANCH_LENGTH);
  const inheritDefault = booleanFlag(flags, 'inherit-default');
  const explicitBaseBranch = flags.get('base-branch');
  if (inheritDefault === Boolean(explicitBaseBranch)) {
    throw new Error('Choose exactly one of --base-branch or --inherit-default');
  }
  const baseBranch = inheritDefault ? null : exactValue(explicitBaseBranch, '--base-branch', MAX_BRANCH_LENGTH);
  const sourceControlConnectionId = flags.has('source-control-connection-id')
    ? requiredFlag(flags, 'source-control-connection-id')
    : null;
  const clientOperationId = exactOperationId(flags);
  const intent = {
    projectId: targetProjectId,
    repositoryId,
    repositoryFullName,
    sourceControlConnectionId,
    baseBranch,
    defaultBranch,
    beforeDigest,
    clientOperationId,
  };
  return {
    ok: true,
    kind: 'local_plan',
    capability: 'project.repository.bind',
    risk: 'W2',
    policy: grant,
    intent,
    planDigest: digest(intent),
    remoteApply: 'blocked',
    observedContract: {
      method: 'PATCH',
      path: '/api/projects/:projectId',
      intendedFields: ['repositoryId', 'sourceControlConnectionId', 'baseBranch', 'defaultBranch'],
      additionalObservedFields: ['name', 'setupScript', 'runScript', 'archiveScript', 'clientOperationId'],
    },
    preconditions: [
      'Re-read project-repository-get and require an exact stateDigest match.',
      'Resolve repository ID/full name/default branch against the current repository catalog.',
      'Verify the requested base branch through the existing branches command.',
    ],
    blockedReasons: [
      'PATCH authentication has not been verified for the OAuth MCP credential.',
      'The web client preserves project name and script overrides in the same PATCH; a safe executable body requires a fresh strict before-state read.',
      'Post-write readback and ambiguous-result idempotency have not been proven.',
    ],
  };
}

function unbindPlan(positionals: string[], flags: Map<string, string>): CommandResult {
  const targetProjectId = projectId(positionals);
  const grant = policyGrant(flags, targetProjectId, 'project.repository.unbind');
  const intent = {
    projectId: targetProjectId,
    beforeDigest: exactDigest(flags),
    clientOperationId: exactOperationId(flags),
  };
  return {
    ok: true,
    kind: 'local_plan',
    capability: 'project.repository.unbind',
    risk: 'W2',
    policy: grant,
    intent,
    planDigest: digest(intent),
    remoteApply: 'blocked',
    evidenceBoundary: {
      sourceTier: 'local-inference',
      remoteContract: 'not_observed',
      scope: 'local_policy_bound_plan_only',
    },
    preconditions: [
      'Re-read project-repository-get and require an exact stateDigest match.',
      'Confirm the project repository is currently bound before any future apply.',
    ],
    blockedReasons: [
      'No repository-unbind interaction or exact null/empty payload was observed in the authenticated client.',
      'No remote route, method, or payload is evidenced for repository unbind.',
      'Write authentication, post-write readback, and ambiguous-result idempotency remain unverified.',
    ],
  };
}

function applyBlocked(): CommandResult {
  return {
    ok: false,
    outcome: 'blocked',
    remoteStateChanged: false,
    message: 'Repository binding apply is intentionally unavailable because the authenticated write, complete preservation payload, readback, and ambiguous-result contract are not proven.',
    recovery: 'Use the generated local plan for review, then complete the binding in Hoplite settings until the compatibility contract is verified.',
  };
}

function safeResult(result: CommandResult | Promise<CommandResult>): Promise<CommandResult> {
  return Promise.resolve(result).then(value => sanitizeFeatureResult(value) as CommandResult);
}

export const projectRepositoryCommandDefinitions: readonly CliCommandDefinition[] = [
  {
    name: 'project-repository-get',
    description: 'Read a bounded project repository binding and state digest through the public project contract',
    transport: 'mcp',
    run: ({ client, positionals }) => safeResult(repositoryGet(client, positionals)),
  },
  {
    name: 'project-repository-resolve',
    description: 'Resolve a saved binding against the official GitHub catalog and compatible repo settings',
    transport: 'mcp',
    run: ({ client, positionals }) => safeResult(repositoryResolve(client, positionals)),
  },
  {
    name: 'project-repository-plan-bind',
    description: 'Create a policy-bound local W2 repository-binding plan; never changes Hoplite state',
    transport: 'local',
    run: ({ positionals, flags }) => safeResult(bindPlan(positionals, flags)),
  },
  {
    name: 'project-repository-plan-unbind',
    description: 'Create a policy-bound local W2 unbind review plan; exact remote unbind remains unproven',
    transport: 'local',
    run: ({ positionals, flags }) => safeResult(unbindPlan(positionals, flags)),
  },
  {
    name: 'project-repository-apply',
    description: 'Report why remote repository binding apply remains blocked; never performs network I/O',
    transport: 'local',
    run: () => safeResult(applyBlocked()),
  },
];

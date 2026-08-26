import type { CliCommandDefinition, CommandResult, LocalCommandContext } from './command-registry';
import { COMPATIBILITY_REGISTRY, type CompatibilityCapability } from './compatibility';

const AREA = 'workspace-members';

function validateLocalInvocation(context: LocalCommandContext): void {
  if (context.positionals.length > 0) {
    throw new Error('workspace-members-status does not accept positional arguments');
  }
  const firstFlag = context.flags.keys().next().value;
  if (firstFlag !== undefined) throw new Error(`Unsupported flag: --${firstFlag}`);
}

function projectedCapability(entry: CompatibilityCapability): Record<string, unknown> {
  return {
    id: entry.id,
    action: entry.action,
    contractKind: entry.path.startsWith('better-auth:')
      ? 'better_auth_browser_method'
      : 'authenticated_client_route',
    method: entry.method,
    path: entry.path,
    authStatus: entry.authStatus,
    risk: entry.risk,
    status: entry.status,
    cliAvailability: 'unavailable',
  };
}

export function workspaceMembersStatus(context: LocalCommandContext): CommandResult {
  validateLocalInvocation(context);
  const capabilities = COMPATIBILITY_REGISTRY.filter(entry => entry.area === AREA);
  const reads = capabilities.filter(entry => entry.risk === 'R0').map(projectedCapability);
  const mutations = capabilities.filter(entry => entry.risk !== 'R0').map(projectedCapability);
  return {
    area: AREA,
    mode: 'local_evidence_only',
    networkRequests: 0,
    oauthApiReadsAvailable: false,
    workspaceApiKeyReadsAvailable: false,
    browserSessionOnly: true,
    reads,
    mutations,
    boundary: 'No exact members, invitations, or domain auto-join read contract is proven compatible with Hoplite OAuth or workspace API keys. Browser-session calls and all membership mutations remain unavailable to this CLI.',
  };
}

export const workspaceMembersCommandDefinitions: readonly CliCommandDefinition[] = [
  {
    name: 'workspace-members-status',
    description: 'Show the local evidence boundary for workspace members, invitations, and domain auto-join',
    transport: 'local',
    run: workspaceMembersStatus,
  },
];

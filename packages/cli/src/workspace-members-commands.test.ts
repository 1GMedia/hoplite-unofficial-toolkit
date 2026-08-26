import { describe, expect, test } from 'bun:test';

import { run } from './index';
import { COMPATIBILITY_REGISTRY } from './compatibility';
import {
  workspaceMembersCommandDefinitions,
  workspaceMembersStatus,
} from './workspace-members-commands';

describe('workspace members capability status', () => {
  test('reports only local browser-boundary evidence without personal member data', () => {
    const result = workspaceMembersStatus({ positionals: [], flags: new Map() });
    expect(result).toMatchObject({
      area: 'workspace-members',
      mode: 'local_evidence_only',
      networkRequests: 0,
      oauthApiReadsAvailable: false,
      workspaceApiKeyReadsAvailable: false,
      browserSessionOnly: true,
    });
    const reads = result.reads as Array<Record<string, unknown>>;
    expect(reads.map(entry => entry.id)).toEqual([
      'workspace.members.list',
      'workspace.invitations.list',
      'workspace.domain-auto-join.get',
    ]);
    expect(reads.every(entry => (
      entry.authStatus === 'browser-session-only'
      && entry.status === 'blocked'
      && entry.cliAvailability === 'unavailable'
      && entry.risk === 'R0'
    ))).toBe(true);
    expect(reads).toContainEqual(expect.objectContaining({
      id: 'workspace.members.list',
      contractKind: 'better_auth_browser_method',
      method: 'BROWSER',
      path: 'better-auth:organization.listMembers',
    }));
    expect(reads).toContainEqual(expect.objectContaining({
      id: 'workspace.invitations.list',
      contractKind: 'authenticated_client_route',
      method: 'GET',
      path: '/api/orgs/invitations',
    }));
    expect(reads).toContainEqual(expect.objectContaining({
      id: 'workspace.domain-auto-join.get',
      contractKind: 'authenticated_client_route',
      method: 'GET',
      path: '/api/orgs/domain-auto-join',
    }));
    expect(JSON.stringify(result)).not.toMatch(/email|displayName|memberId|invitationId|organizationId/i);
  });

  test('keeps every membership mutation blocked at W2 or W3', () => {
    const result = workspaceMembersStatus({ positionals: [], flags: new Map() });
    const mutations = result.mutations as Array<Record<string, unknown>>;
    expect(mutations.map(entry => entry.id)).toEqual([
      'workspace.members.invite',
      'workspace.members.role.update',
      'workspace.members.remove',
      'workspace.invitations.cancel',
      'workspace.domain-auto-join.set',
    ]);
    expect(mutations.every(entry => (
      (entry.risk === 'W2' || entry.risk === 'W3')
      && entry.status === 'blocked'
      && entry.cliAvailability === 'unavailable'
    ))).toBe(true);
    expect(workspaceMembersCommandDefinitions.some(command => /invite|role|remove|cancel|domain-auto-join-set/.test(command.name))).toBe(false);
  });

  test('is local, appears in help, and does not read OAuth state', async () => {
    expect(workspaceMembersCommandDefinitions).toHaveLength(1);
    expect(workspaceMembersCommandDefinitions[0]).toMatchObject({
      name: 'workspace-members-status',
      transport: 'local',
    });
    const previousPath = process.env.HOPLITE_OAUTH_PATH;
    process.env.HOPLITE_OAUTH_PATH = '/definitely/missing/workspace-members-oauth.json';
    try {
      const result = await run(['workspace-members-status']);
      expect(result.mode).toBe('local_evidence_only');
      const help = await run(['help']);
      expect((help.commands as Record<string, string>)['workspace-members-status']).toContain('local evidence boundary');
    } finally {
      if (previousPath === undefined) delete process.env.HOPLITE_OAUTH_PATH;
      else process.env.HOPLITE_OAUTH_PATH = previousPath;
    }
  });

  test('rejects all arguments and flags locally', async () => {
    expect(() => workspaceMembersStatus({ positionals: ['unexpected'], flags: new Map() }))
      .toThrow('does not accept positional arguments');
    expect(() => workspaceMembersStatus({ positionals: [], flags: new Map([['live', 'true']]) }))
      .toThrow('Unsupported flag: --live');
    await expect(run(['workspace-members-status', '--live'])).rejects.toThrow('Unsupported flag: --live');
  });

  test('registry records no implemented workspace member operation', () => {
    const capabilities = COMPATIBILITY_REGISTRY.filter(entry => entry.area === 'workspace-members');
    expect(capabilities).toHaveLength(8);
    expect(capabilities.every(entry => (
      entry.authStatus === 'browser-session-only' && entry.status === 'blocked'
    ))).toBe(true);
    expect(capabilities.some(entry => entry.status === 'implemented')).toBe(false);
  });
});

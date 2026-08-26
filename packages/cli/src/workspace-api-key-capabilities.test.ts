import { describe, expect, test } from 'bun:test';

import { compatibilitySnapshot } from './compatibility';
import { run } from './index';
import { workspaceApiKeyCapabilities } from './workspace-api-key-capabilities';

describe('workspace-api-key-capabilities', () => {
  test('returns only fixed capability, authentication, sink, status, and risk enums', () => {
    expect(workspaceApiKeyCapabilities()).toEqual({
      capabilities: [
        {
          capability: 'workspace-api-key-create',
          authentication: 'owner-admin-proof-required',
          secretSinkRequirement: 'keychain-or-owner-only-0600-file',
          implementationStatus: 'blocked-missing-contract-authorization-isolation-and-sink',
          risk: 'W3',
        },
        {
          capability: 'workspace-api-key-list',
          authentication: 'unverified',
          secretSinkRequirement: 'not-applicable',
          implementationStatus: 'unregistered-blocked',
          risk: 'R0',
        },
        {
          capability: 'workspace-api-key-revoke',
          authentication: 'unverified',
          secretSinkRequirement: 'not-applicable',
          implementationStatus: 'unregistered-blocked',
          risk: 'W3',
        },
      ],
    });
  });

  test('rejects every positional and flag before transport dispatch', async () => {
    await expect(run(['workspace-api-key-capabilities', 'anything'])).rejects.toThrow(
      'accepts no positionals or flags',
    );
    await expect(run(['workspace-api-key-capabilities', '--anything'])).rejects.toThrow(
      'accepts no positionals or flags',
    );
  });

  test('registers the report as an implemented local R0 capability', () => {
    const registered = compatibilitySnapshot().capabilities.find(
      capability => capability.id === 'workspace.api-keys.capabilities',
    );
    expect(registered).toMatchObject({
      method: 'LOCAL',
      risk: 'R0',
      status: 'implemented',
    });
  });

  test('does not expose credential or tenant-derived state', async () => {
    const previousApiKey = process.env.HOPLITE_API_KEY;
    const previousApiBaseUrl = process.env.HOPLITE_API_BASE_URL;
    const previousCredentialsPath = process.env.HOPLITE_CREDENTIALS_PATH;
    const previousOAuthPath = process.env.HOPLITE_OAUTH_PATH;
    try {
      process.env.HOPLITE_API_KEY = 'fixture_api_key_that_must_not_be_read';
      process.env.HOPLITE_API_BASE_URL = 'http://127.0.0.1:1';
      process.env.HOPLITE_CREDENTIALS_PATH = '/path/that/must/not/be/read';
      process.env.HOPLITE_OAUTH_PATH = '/definitely/missing/workspace-api-key-oauth.json';
      const output = await run(['workspace-api-key-capabilities']);
      const serialized = JSON.stringify(output);
      expect(serialized).not.toContain('fixture_api_key_that_must_not_be_read');
      expect(serialized).not.toContain('/path/that/must/not/be/read');
      expect(serialized).not.toContain('/definitely/missing/workspace-api-key-oauth.json');
      expect(serialized).not.toMatch(/workspaceId|keyPresent|prefix|digest|hash|length/i);
    } finally {
      if (previousApiKey === undefined) delete process.env.HOPLITE_API_KEY;
      else process.env.HOPLITE_API_KEY = previousApiKey;
      if (previousApiBaseUrl === undefined) delete process.env.HOPLITE_API_BASE_URL;
      else process.env.HOPLITE_API_BASE_URL = previousApiBaseUrl;
      if (previousCredentialsPath === undefined) delete process.env.HOPLITE_CREDENTIALS_PATH;
      else process.env.HOPLITE_CREDENTIALS_PATH = previousCredentialsPath;
      if (previousOAuthPath === undefined) delete process.env.HOPLITE_OAUTH_PATH;
      else process.env.HOPLITE_OAUTH_PATH = previousOAuthPath;
    }
  });
});

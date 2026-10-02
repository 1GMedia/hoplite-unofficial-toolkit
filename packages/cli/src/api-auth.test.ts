import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configuredApiBaseUrl, hopliteConfigPath, loadApiCredential } from './api-auth';

function withEnv(values: Record<string, string | undefined>, work: () => void): void {
  const previous = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]));
  try {
    for (const [key, value] of Object.entries(values)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    work();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

describe('explicit API authentication', () => {
  test('uses XDG config paths and official endpoint alias with legacy precedence', () => {
    withEnv({ XDG_CONFIG_HOME: '/fixture/config', HOPLITE_API_BASE_URL: undefined, HOPLITE_BASE_URL: 'https://fixture.invalid' }, () => {
      expect(hopliteConfigPath('mcp-oauth.json')).toBe('/fixture/config/hoplite/mcp-oauth.json');
      expect(configuredApiBaseUrl()).toBe('https://fixture.invalid');
      process.env.HOPLITE_API_BASE_URL = 'https://legacy-fixture.invalid';
      expect(configuredApiBaseUrl()).toBe('https://legacy-fixture.invalid');
    });
  });

  test('never reads official credential storage implicitly', () => {
    withEnv({ HOPLITE_API_KEY: undefined, HOPLITE_CREDENTIALS_PATH: undefined, HOPLITE_BASE_URL: undefined, HOPLITE_API_BASE_URL: undefined }, () => {
      expect(() => loadApiCredential()).toThrow('HOPLITE_API_KEY');
      process.env.HOPLITE_API_KEY = 'fixture_key_123456789';
      expect(loadApiCredential().source).toBe('HOPLITE_API_KEY environment variable');
    });
  });

  test('fails closed for ambiguous workspaces and selects only the matching legacy entry', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hoplite-fixture-auth-'));
    const path = join(dir, 'credentials.json');
    try {
      writeFileSync(path, JSON.stringify({ credentials: [
        { apiKey: 'fixture_key_a_123456789', baseUrl: 'https://fixture.invalid', orgId: 'fixture-a' },
        { apiKey: 'fixture_key_b_123456789', baseUrl: 'https://fixture.invalid', orgId: 'fixture-b' },
      ] }), { mode: 0o600 });
      withEnv({ HOPLITE_API_KEY: undefined, HOPLITE_CREDENTIALS_PATH: path, HOPLITE_ORG_ID: undefined, HOPLITE_API_BASE_URL: 'https://fixture.invalid' }, () => {
        expect(() => loadApiCredential()).toThrow('exactly one');
        process.env.HOPLITE_ORG_ID = 'fixture-b';
        expect(loadApiCredential().key).toBe('fixture_key_b_123456789');
        process.env.HOPLITE_ORG_ID = 'fixture-missing';
        expect(() => loadApiCredential()).toThrow('exactly one');
      });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test('rejects unsafe endpoint values', () => {
    for (const baseUrl of ['http://fixture.invalid', 'https://fixture.invalid/path', 'https://user:password@fixture.invalid', 'https://fixture.invalid?key=fixture']) {
      withEnv({ HOPLITE_API_BASE_URL: baseUrl }, () => expect(() => configuredApiBaseUrl()).toThrow());
    }
  });
});

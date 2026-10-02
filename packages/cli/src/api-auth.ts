import { existsSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const DEFAULT_API_BASE_URL = 'https://api.hoplite.sh';

export type ApiCredential = {
  key: string;
  baseUrl: string;
  source: string;
  orgId?: string;
};

export function hopliteConfigPath(file: string): string {
  return join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'hoplite', file);
}

export function configuredApiBaseUrl(): string {
  const value = process.env.HOPLITE_API_BASE_URL?.trim()
    || process.env.HOPLITE_BASE_URL?.trim() || DEFAULT_API_BASE_URL;
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password
    || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('Hoplite API base URL must be an HTTPS origin without credentials');
  }
  return url.origin;
}

export function loadApiCredential(): ApiCredential {
  const baseUrl = configuredApiBaseUrl();
  const orgId = process.env.HOPLITE_ORG_ID?.trim() || undefined;
  const key = process.env.HOPLITE_API_KEY?.trim();
  if (key) return { key, baseUrl, orgId, source: 'HOPLITE_API_KEY environment variable' };

  // Official credential storage is not a public API; legacy file access is opt-in.
  const path = process.env.HOPLITE_CREDENTIALS_PATH;
  if (!path) {
    throw new Error('Set HOPLITE_API_KEY for API transport; official CLI/Keychain credentials are not read automatically');
  }
  if (!existsSync(path)) throw new Error('Explicit Hoplite credentials file is missing');
  const stat = statSync(path);
  if (!stat.isFile() || (stat.mode & 0o077) !== 0) {
    throw new Error('Hoplite credentials must be a regular file with permissions 600 or stricter');
  }
  let parsed: unknown;
  try { parsed = JSON.parse(readFileSync(path, 'utf8')); }
  catch { throw new Error('Hoplite credentials file is not valid JSON'); }
  const entries = (parsed as { credentials?: unknown[] } | null)?.credentials;
  if (!Array.isArray(entries)) throw new Error('Hoplite credentials file has no credential entries');
  const matches = entries.filter((entry): entry is { apiKey: string; baseUrl: string; orgId?: string } => {
    if (!entry || typeof entry !== 'object') return false;
    const item = entry as Record<string, unknown>;
    if (typeof item.apiKey !== 'string' || !item.apiKey.trim() || typeof item.baseUrl !== 'string') return false;
    try {
      const url = new URL(item.baseUrl);
      return url.origin === baseUrl && url.pathname === '/' && !url.username && !url.password
        && !url.search && !url.hash && (!orgId || item.orgId === orgId)
        && (item.orgId === undefined || typeof item.orgId === 'string');
    } catch { return false; }
  });
  if (matches.length !== 1) {
    throw new Error('Credentials file must contain exactly one API key matching the endpoint and workspace; set HOPLITE_ORG_ID or HOPLITE_API_KEY');
  }
  const selected = matches[0]!;
  return { key: selected.apiKey.trim(), baseUrl, orgId: orgId || selected.orgId, source: 'Explicit legacy credentials file' };
}

import { readFile, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import {
  buildApiContract, contractDifferences, MAX_SPEC_BYTES, PUBLIC_SPEC_URL,
} from '../packages/cli/src/api-contract.ts';

const PINNED_CONTRACT = fileURLToPath(new URL('../docs/api-contract.json', import.meta.url));
const HELP = `Check the pinned toolkit subset of Hoplite's public OpenAPI contract (read-only).

Usage:
  bun scripts/check-api-contract.ts --file /path/to/openapi.json
  bun scripts/check-api-contract.ts --live

--live performs one unauthenticated GET to ${PUBLIC_SPEC_URL}.
No redirects, retries, writes, automatic snapshot updates, or PRs.
The snapshot is docs/api-contract.json; review drift before changing it.
To intentionally regenerate after review:
  bun -e 'import { buildApiContract } from "./packages/cli/src/api-contract.ts"; console.log(JSON.stringify(buildApiContract(await Bun.file(process.argv[1]).json()), null, 2))' /path/to/openapi.json > docs/api-contract.json
`;

async function localJson(path: string): Promise<unknown> {
  if ((await stat(path)).size > MAX_SPEC_BYTES) throw new Error('JSON file exceeds the 8 MiB bound');
  const data = await readFile(path);
  if (data.byteLength > MAX_SPEC_BYTES) throw new Error('JSON file exceeds the 8 MiB bound');
  return JSON.parse(data.toString('utf8'));
}

async function liveJson(): Promise<unknown> {
  const response = await fetch(PUBLIC_SPEC_URL, {
    method: 'GET',
    headers: { Accept: 'application/json' },
    credentials: 'omit',
    redirect: 'error',
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new Error(`Public spec download failed (HTTP ${response.status})`);
  if (!response.body) throw new Error('Public spec response has no body');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_SPEC_BYTES) throw new Error('Public spec exceeds the 8 MiB bound');
      chunks.push(value);
    }
  } finally {
    await reader.cancel();
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

async function main(args: string[]): Promise<void> {
  if (args.length === 1 && args[0] === '--help') {
    console.log(HELP);
    return;
  }
  const live = args.length === 1 && args[0] === '--live';
  const file = args.length === 2 && args[0] === '--file' ? args[1] : undefined;
  if (!live && !file) throw new Error(`Choose exactly --file <path> or --live.\n${HELP}`);
  const expected = await localJson(PINNED_CONTRACT);
  const actual = buildApiContract(live ? await liveJson() : await localJson(file!));
  const differences = contractDifferences(expected, actual);
  if (differences.length) {
    console.error(`Public API contract drift at these JSON-pointer paths (up to 20):\n${differences.join('\n')}`);
    throw new Error('Review the changed operations against toolkit callers; update docs/api-contract.json only intentionally after compatibility review. No files were changed.');
  }
  console.log(`Public API contract matches the pinned ${Object.keys(actual.operations as object).length} operations.`);
}

if (import.meta.main) {
  main(process.argv.slice(2)).catch(error => {
    // Never echo downloaded bodies or arbitrary local-file contents on parse failures.
    console.error(error instanceof SyntaxError ? 'Invalid JSON in spec or snapshot' : String(error.message).slice(0, 4_000));
    process.exitCode = 1;
  });
}

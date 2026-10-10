# Generated operation types and metadata

Step 4 adds offline code generation; it does not add executable operation families.
The hosted MCP wrapper remains the safety layer, not a generated API client.

## Generate and verify

```bash
bun run operations:generate
bun run operations:check
bun run test
bun run typecheck
bun run build
```

Generation reads the committed [Direct and Platform inputs](../specs/README.md)
and writes three files in `packages/cli/src/generated/`:

- `direct.ts`: Direct paths, components, request/response operations.
- `platform.ts`: Platform types only. This does not enable Platform calls;
  organization gating and `403 platform_api_not_enabled` still apply.
- `operations.ts`: literal operation metadata and typed operation-ID helpers.

`operations:check` regenerates in memory and fails on missing or stale output
without writing files. CI runs it before tests. Generation uses pinned
`openapi-typescript@7.13.0`; missing upstream declaration dependencies are
explicit dev dependencies rather than bypassed with `skipLibCheck`. All tests
use local synthetic fixtures and never call Hoplite.

Example type-only use:

```ts
import type { DirectOperation } from '../packages/cli/src/generated/operations';

type StopRequest = DirectOperation<'stopRun'>['requestBody']['content']['application/json'];
```

Types model upstream schemas, not toolkit authorization or runtime validation.
The toolkit may require a field (such as an explicit operation ID) even when
upstream types make it optional.

## Metadata semantics

Each operation records its ID, method, path template, tags, read/write access,
explicit required permissions, and advertised idempotency header support.

- Only GET/HEAD classify as reads. All other HTTP methods classify as writes.
- Permissions come exclusively from `x-required-permission` and
  `x-required-permissions`, deduplicated and sorted. `null` means not stated,
  not permissionless. No permission is guessed from tags, descriptions, or verbs.
- Idempotency metadata comes from the `Idempotency-Key` header parameter,
  including local refs and path parameters overridden by operation parameters.
  Its `required` boolean records the schema flag; the preserved description
  can state conditional requirements for service credentials. `null` means
  not advertised, not proof that retrying is safe. Body IDs alone do not imply
  idempotency guarantees.
- Tags and permissions are descriptive data, never an authorization allowlist.

The source hash in each generated type file is SHA-256 of the parsed input
serialized as JSON. Output is deterministic for the same committed input,
generator, and lockfile. External references, duplicate/missing operation IDs,
and malformed metadata fail generation.

## Consumers and intentional limits

The pinned-contract checker selects its existing 20 reviewed operation IDs and
derives their method/path pairs from generated Direct metadata. Selection remains
explicit: a new upstream operation must not silently expand the toolkit's contract
or write surface. Generation never rewrites the pinned response/parameter
schemas; the separate strict contract checker still detects drift. The
PR-status contract update from merged PR #22 is inherited from `main` and
matches the committed Direct spec.

The MCP gate matches generated Direct methods/path templates and uses their
read/write classification and a small reviewed write-ID policy. Unknown hosted
GET/HEAD compatibility reads and the existing explicitly documented title action
retain their prior behavior. A new generated write is not automatically callable.
Exact mutation allowlists, confirmation, explicit IDs, exact-run stop checks,
no automatic retries, and bounded/redacted output remain mandatory.

This is not a generated client, runtime JSON Schema validator, permission grant,
or expansion of supported commands. Other command payload builders and direct
REST dispatch remain hand-written. Platform output is types/metadata only.

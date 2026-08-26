# Personal agent context

This feature exposes two compatibility reads while treating durable memories
and skill instructions as potentially sensitive content.

## Evidence boundary

The browser-delivered authenticated client release
`97462d3aff299f96fc632f69b0c941a036c83eb0`, API-client SHA-256
`aff5ae4af836cfc655cf5d6b1b9a7f31afe58ae2b088363638b9dfa9444c0743`,
contains these exact read callers:

- `GET /api/agent-memories`, returning memory records with `id`, `content`,
  and scope;
- `GET /api/user/skills`, returning personal skill records with `id`, `name`,
  `description`, `body`, `source`, and optional `sourceLabel`.

These are authenticated-client contracts, not public OpenAPI support. The
recorded public documentation and OpenAPI do not describe either route. The
client evidence proves a browser caller existed in that release; it does not
prove OAuth/MCP compatibility, retention policy, tenant isolation, or future
stability.

## Commands

```bash
bun run hoplite -- personal-memories-list
bun run hoplite -- personal-skills-list
```

Memory output contains only total rows, aggregate content-present/empty counts,
and counts for each fixed scope enum. Skill output contains only total rows,
aggregate body-present/empty counts, and counts for each fixed source enum.
There is no per-item array.

There is no `--include-content`, `--include-body`, or other override that emits
freeform personal context. Raw identifiers, freeform fields, deterministic
digests, and per-item lengths are never emitted. The commands accept no output
flags. The client evidence did not show query-based pagination, so the CLI does
not send an invented query. Responses larger than 2 MiB are rejected before
JSON parsing, and responses with more than 100 rows fail closed before any row
is counted.

Each command performs one GET with no automatic retry. A successful parse is
`confirmed_for_current_credential`. Failures remain explicit:

- `401` — `unsupported_credential`;
- `403` — `role_denied`;
- `404` — absent or unavailable to the current principal, not proof of
  product-wide absence;
- an MCP transport failure — a constant `transport_error` result that never
  includes provider exception text; and
- a successful response with an unexpected shape — `schema_drift`.

## Writes remain unavailable

The same client release contains POST/PATCH/DELETE callers for both resource
families. The UI suggests memory content/scope and skill
name/description/body payloads, but that is insufficient for a safe CLI write.
The following remain unverified:

- OAuth/MCP write authorization;
- exact server-enforced input bounds and normalization;
- workspace role and organization-memory authorization;
- idempotency and ambiguous-result reconciliation;
- post-write readback and conflict behavior; and
- retention and deletion guarantees.

Therefore this feature registers no create, update, delete, plan, or apply
command. The generic `api` command remains GET/HEAD-only and cannot be used to
bypass this boundary.

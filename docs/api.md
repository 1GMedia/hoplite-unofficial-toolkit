# Public API support in this toolkit

Reviewed 2026-10-05 against the [API reference](https://hoplite.sh/docs/api) and
[direct OpenAPI specification](https://hoplite.sh/docs/openapi.json).
All **20 tracked operations** still match `api-contract.json`; this review did
not require refreshing the pin or changing runtime behavior.

## Choose the API family

| Surface | Purpose | Toolkit support |
| --- | --- | --- |
| Direct API, `https://api.hoplite.sh/api/...` | Organization-scoped repositories, projects, threads, managed workspaces and delivery | Selected operations below |
| Platform API, `/api/platform/v1/...` | Customer-built apps/editors using source bundles, app threads, draft application, builds and previews | Not implemented |
| Events, webhooks, operation receipts | Monitoring and reconciliation for integrations | Documented upstream; no dedicated toolkit commands yet |

The API index includes both direct and Platform endpoints. Do not mix their
IDs, request shapes, event cursors, or authentication assumptions. For a custom
editor, start at the [Platform guide](https://hoplite.sh/docs/platform) and its
[separate specification](https://hoplite.sh/docs/platform-openapi.json), not our
direct-API pin. The [documentation home](https://hoplite.sh/docs) also links the
software-factory guides for building integrations.

## Authentication and command coverage

Inject `HOPLITE_API_KEY` from a local secret manager or CI secret store. Direct
API calls use Bearer authentication; upstream also documents `X-Api-Key`.
Permissions are operation-specific; service-account restrictions still apply.
Do not copy browser cookies or extract official CLI Keychain credentials.

`HOPLITE_API_BASE_URL` takes precedence over official `HOPLITE_BASE_URL`; only an
HTTPS origin is accepted. `HOPLITE_ORG_ID` is sent when explicitly configured,
not a way to override a key's authorized workspace. The optional
`HOPLITE_CREDENTIALS_PATH` legacy adapter requires exactly one matching endpoint
and workspace entry. It is not a promise of compatibility with future official
credential-file formats.

```bash
bun run hoplite-toolkit -- api-auth
bun run hoplite-toolkit -- projects --transport api
bun run hoplite-toolkit -- threads --transport api --limit 20
bun run hoplite-toolkit -- thread-active-run fixturethread --transport api
bun run hoplite-toolkit -- thread-run-state fixturethread --transport api --run-id fixture-run
bun run hoplite-toolkit -- thread-runs fixturethread --transport api --limit 10
```

IDs above are synthetic placeholders; substitute exact IDs from authorized
read results. `api-auth` checks only local configuration, not remote key validity.

| Command group | `--transport api` | Default MCP |
| --- | --- | --- |
| `projects`, `project`, `threads` | Yes | Yes |
| `repositories`, `branches`, `repo-inspect` | Yes | Yes |
| `messages`, `thread-runs`, `thread-run-state`, `thread-active-run` | Yes | Yes |
| `thread-usage`, `thread-pr-status`, `thread-pr-comments` | Yes | Yes |
| `create-thread`, `message`, `thread-stop`, `thread-retry`, `thread-compact` | Guarded writes | Guarded writes |
| `status`, `inspect`, `models`, `tools` | Not implemented | Yes |
| `thread-capability`, `thread-preview-checklist`, `thread-auto-title` | Not implemented | Undocumented compatibility routes; title is a guarded write |

The generic `api` command is always direct REST, GET/HEAD-only, and restricted
to an allowlisted thread path. It is not a general API browser or a workaround
for unsupported mutation families. API-mode errors never silently fall back to
MCP. The full upstream catalog is **not** the toolkit's command inventory.

## Writes, receipts, and monitoring

Existing-thread mutations require an exact allowlist entry and `--confirm`.
Creation requires `project:<project-id>`, confirmation, and an explicit
`--client-operation-id`. Stop additionally requires the exact run ID. A project
entry does not authorize actions on existing threads. An explicit stable
operation ID is required for every write; do not retry an ambiguous result with a new ID.

API transport sends `Idempotency-Key`, matching `clientOperationId` or
`clientMessageId` in the request body. Upstream requires this header for
service-credential writes even where the generic schema marks it optional.
This client never automatically retries. A timeout or lost response may follow
a successful write; preserve the operation ID and reconcile through authorized
read evidence rather than assuming failure means nothing happened.

Responses have a bounded, redacted envelope with HTTP status and server-provided
operation/request IDs when available. HTTP failures exit nonzero. A receipt
records dispatch, not completion: an accepted/202 result still requires reading
the run or resource. For a current run, read `thread-active-run`, then pass its
exact ID to `thread-run-state --run-id`. Without that flag, upstream selects the
latest terminal run, not necessarily currently executing work.

For future integrations, the direct API documents operation-receipt reads and
SSE events. SSE resume uses the **SSE id / JSON cursor**, while deduplication uses
the **JSON event id**. Live drafts are replaceable snapshots without durable
replay guarantees. These are design requirements for a future monitoring client,
not claims that this toolkit currently streams, resumes, or resolves approvals.

## Scope and verification

The public API additionally documents service accounts, approvals, environment
management, recovery, checkpoints, attachments, previews, PR writes, automations,
MCP configuration, billing, and webhooks. Adding those requires dedicated policy
and offline fixtures; availability in the docs is not authorization to expose
them. Production publishing remains separately authorized.

See [compatibility](compatibility.md) for reviewed paths and
[upstream maintenance](upstream-maintenance.md) for drift checks. The current
review compares public documentation and schemas with source; it is not live
authenticated conformance testing or proof of every deployment's capabilities.

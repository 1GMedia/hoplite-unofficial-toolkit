# API and compatibility routes

Reviewed against Hoplite's public [API reference](https://hoplite.sh/docs/api)
and [OpenAPI specification](https://hoplite.sh/docs/openapi.json) on 2026-10-05.
Publication is contract evidence, not proof of access for every credential.
All 20 tracked operations still match the existing pin. See the
[API support matrix](api.md) for transport-specific command coverage,
[MCP guide](mcp-server.md) for upstream prose/schema differences, and
[ACP guide](acp.md) for the separate session protocol we do not implement.

## Documented operations

- Project list and get; guarded thread creation (not project creation).
- Thread list, get, and bounded message reads.
- Repository list, branch list, and repository inspection.
- Model-provider discovery (MCP command).
- Run history, authoritative run state, and active-run identity.
- Thread usage; pull-request status and comments.
- Guarded message append, exact-run stop, retry, and context compaction.

Dedicated commands can use the default MCP connection or opt into direct API
transport where documented in the README. `status`, `inspect`, `models`, and
MCP tool discovery currently remain MCP-only.

| Action | Method and path | Supported payload | Side effect |
| --- | --- | --- | --- |
| Create thread | `POST /api/threads` | `projectId`, `prompt`, `clientOperationId`, optional `model`/`title` | Creates a thread and queues work |
| Message | `POST /api/threads/{id}/messages` | `content`, `clientMessageId` | Appends a user message and queues work |
| Stop | `POST /api/threads/{id}/stop` | `runId`, `clientOperationId` | Stops the explicitly identified run |
| Retry | `POST /api/threads/{id}/retry` | `clientOperationId` | Requests a retry |
| Compact | `POST /api/threads/{id}/compact` | `clientOperationId` | Requests context compaction |

The direct transport sends a matching `Idempotency-Key` header. Existing-thread
actions require the exact thread allowlist entry and `--confirm`. Creation
requires an exact `project:<project-id>` entry, `--confirm`, and an explicit
operation ID. No automatic mutation retries occur; HTTP acceptance is not proof
of completion. Local API-key checks do not establish authentication remotely.

## Undocumented compatibility surface (MCP only)

- `GET /api/threads/:id/execution-capability`.
- `GET /api/threads/:id/preview-checklist`.
- `POST /api/threads/:id/title` with `clientOperationId`: regenerates a title;
  requires an exact thread allowlist and confirmation.

Caller evidence and reconstruction history remain in
[reverse-engineering.md](reverse-engineering.md). These routes are not in the
tracked public OpenAPI subset and may drift without warning. Fail closed if
their contracts no longer match; do not infer support from similar public routes.

## Intentionally not implemented

Some previously excluded surfaces are now public APIs: approvals, workspace
recovery, diffs/checkpoints, attachments, previews, PR mutations, environment
variables, service accounts, billing, and automations. Documentation alone does
not authorize adding them without their own policy, payload validation, secret
handling, and fixture tests. Terminal/log access also remains outside the
toolkit. Generic `api` writes are disabled so they cannot bypass those designs.

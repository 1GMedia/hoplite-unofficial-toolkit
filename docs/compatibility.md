# Compatibility routes

The toolkit separates reviewed API operations from compatibility operations
reconstructed from Hoplite's public web client. Compatibility routes can drift
and should remain fail-closed when their contracts no longer match.

## Reviewed operations

- Project list, create, and get.
- Thread list, create, get, and message reads.
- Repository list, branch list, and repository inspection.
- Model-provider discovery and service health.

The reviewed source is Hoplite's published OpenAPI document:
`https://hoplite.sh/docs/openapi.json`.

## Evidence registry

`settings-capabilities` and `compatibility-status` expose a sanitized, bounded
registry. The current entries come from official OpenAPI and authenticated
client evidence. The model reserves official-documentation and live-MCP tiers
for entries verified from those sources. Each capability records:

- source tier (`official-openapi`, `official-docs`, `authenticated-client`, or
  `live-mcp`);
- exact method and path template;
- observed authentication status;
- risk (`R0` read, `W1` routine write, `W2` sensitive/external write, or `W3`
  financial/destructive/credential write);
- implementation status and last verification date;
- payload evidence, caller evidence, and observed or expected side effects; and
- the OpenAPI SHA-256 and authenticated-client release/hash used for the
  assessment.

`discovered` means a caller contract was evidenced. It does not mean the route
is stable, supported by the toolkit's credentials, or authorized for writes.
`blocked` marks actions that require a stronger secret sink, browser handoff,
or destructive-action challenge. `compatibility-diff --baseline <file>` reports
only identity changes and added, removed, or modified capability IDs. If a
status snapshot was created with `--area`, the filter is stored and reused by
the diff. Programmatic comparisons with mismatched filters fail closed.

## Compatibility reads

- Thread execution capability.
- Usage metadata.
- Pull-request status and comments.
- Preview checklist.
- Project sandbox overrides and prebuild enablement through the public project
  response.
- Up to five projected project prebuild records through
  `GET /api/projects/:projectId/prebuilds`.

The prebuild projection keeps only the evidenced ID, status, repository,
commit, trigger, timestamps, active-state marker, and failure-detail presence.
It never returns the failure message or unknown fields. A successful call marks
availability only for the current credential and principal; registry auth
compatibility remains `unverified` until that route is deliberately verified.
The sandbox state digest binds both `sandboxSpec` field presence and normalized
override status, preserving the distinction between an omitted field and an
explicit `null` inheritance override.

## Blocked prebuild rebake

The authenticated client evidences
`POST /api/projects/:projectId/prebuilds/rebake` with no request body and a
response containing `dispatched` plus optional `eligible` integers. The action
can consume compute and the client contract has no idempotency key. Therefore:

- `project-prebuilds-plan-rebake` validates an exact owner-only, at-most-24-hour
  `project.prebuilds.rebake` W2 grant and binds a local plan to prior prebuild
  and sandbox state digests. It writes a new `0600` plan file whose digest also
  binds owner, workspace, origin, project, capability, action risk, resource
  risk ceiling, policy issue/expiry times, and the observed no-body POST
  contract;
- the plan performs no network I/O and reports remote apply as blocked; and
- `project-prebuilds-apply` accepts only an owner-only plan file, recomputes its
  digest and exact-grant digest, revalidates the still-current policy identity,
  requires supplied digests from fresh reads to match before returning a
  non-retryable blocked receipt with no remote request or state change.

The apply receipt distinguishes supplied digest equality from live-state proof;
the local command does not contact Hoplite and cannot independently attest that
the caller actually performed the fresh reads.

The POST must remain unavailable until OAuth compatibility, owner capability,
compute impact, idempotency or ambiguous-result reconciliation, and post-write
readback are verified in an isolated project.

## Guarded compatibility actions

- Append a message: `POST /api/threads/:id/messages`.
- Stop an exact run: `POST /api/threads/:id/stop`.
- Retry: `POST /api/threads/:id/retry`.
- Compact context: `POST /api/threads/:id/compact`.
- Regenerate a title: `POST /api/threads/:id/title`.

Every action requires an exact locally configured thread allowlist and
`--confirm`. Stop also requires a run ID. The CLI does not automatically retry
mutations.

## Generic API containment

The generic `api` command is permanently `GET`/`HEAD`-only. It rejects request
bodies, fragments, control characters, empty path segments, literal or encoded
backslashes/separators, and literal, percent-encoded, or repeatedly encoded dot
segments. The validated canonical path is the same representation used to
construct the fetch URL. Thread and settings writes cannot be re-enabled with
an allowlist or `--confirm`; they require dedicated commands.

## Settings resource policy

The local `resource-policy-check` command validates the policy prerequisite for
project/workspace writes. The prebuild rebake planner consumes an exact W2
project grant for local planning only; it does not authorize or execute the
remote POST. No executable settings write is included in this release.
The policy file must be opened without following symlinks, be a regular file
owned by the current user, use owner-only mode `0400` or `0600`, be 32 KB or
smaller, and be valid for at most 24 hours. Its strict JSON
schema is:

```json
{
  "version": 1,
  "owner": {
    "accountId": "usr_example",
    "workspaceId": "org_example"
  },
  "origins": ["https://api.hoplite.sh"],
  "resources": [
    {
      "kind": "project",
      "id": "prj_example",
      "capabilities": ["project.update"],
      "riskCeiling": "W1"
    }
  ],
  "issuedAt": "2026-08-25T12:00:00.000Z",
  "expiresAt": "2026-08-25T13:00:00.000Z"
}
```

Unknown fields, non-exact origins, duplicate capabilities, unregistered or
read-only capability IDs, invalid resource types, future issuance, expiry, and
overlong lifetimes fail closed. Later dedicated commands must additionally
match the authenticated owner/workspace, target resource, requested capability,
origin, and risk ceiling at execution time. The requested action's risk is
always derived from the compatibility registry; callers cannot supply or
downgrade it.

## Intentionally excluded

Archive/update, deletion, checkpoint restoration, PR mutations, terminal and
log access, attachments, billing writes, credentials, and workspace recovery
are not wrapped because their payloads, sensitivity, or side effects need
stronger evidence and dedicated safety design. Their discovered contracts may
appear in the registry without becoming executable.

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

### Project automations

The authenticated client release recorded in the registry evidences these
read-only contracts:

- `GET /api/projects/:projectId/automations` returns exact
  `{ ok, automations }` data. `project-automations-list` bounds the response to
  100 rows; `project-automation-get` filters one ID locally from that same
  one-call response instead of inventing a detail endpoint.
- `GET /api/projects/:projectId/automations/status` returns exact
  `{ ok, statuses, totals }` data.
- `GET /api/projects/:projectId/automations/:automationId/executions?limit=N`
  returns exact `{ ok, executions }` data with `N` bounded from 1 to 100.

All three remote reads are single-attempt and schema-strict. Output includes
operational IDs, enabled/trigger state, schedule type, timestamps, counts, and
execution receipts. It omits prompts, titles, spend values, webhook token
prefixes, dedupe keys, payload summaries, external destinations, and private
error strings. HTTP 401/402/403/404/501 outcomes remain distinct from HTTP 200
schema drift.

The official [Automations documentation](https://hoplite.sh/docs/automations)
confirms that automations are project-bound prompts triggered by schedules or
webhooks and that each trigger starts a new thread/run. The internal read routes
remain authenticated-client compatibility contracts and are absent from the
reviewed public OpenAPI.

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

## Future settings resource policy

The local `resource-policy-check` command validates the policy prerequisite for
future project/workspace writes. This release does not implement those writes.
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

Project automation create/update/enable/disable/run-now/delete operations are
also metadata-only and blocked. Run-now can create a billable thread without an
evidenced idempotency key, and webhook create/rotation can return a bearer
credential. Webhook credential reads and rotations require a dedicated
non-stdout secret sink before they can be considered for implementation.

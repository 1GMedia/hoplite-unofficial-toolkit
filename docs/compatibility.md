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
registry. The current entries come from official OpenAPI, authenticated-client,
and explicitly labeled local-inference evidence. The model reserves
official-documentation and live-MCP tiers for entries verified from those
sources. Each capability records:

- source tier (`official-openapi`, `official-docs`, `authenticated-client`,
  `live-mcp`, or `local-inference`); `local-inference` never represents an
  observed remote route, method, payload, or caller;
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
future project/workspace writes. Repository bind/unbind plan commands consume
the same policy locally, but this release still does not execute those writes.
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

## Project repository compatibility

`project-repository-get` uses the public project contract and emits a binding
state digest. `project-repository-resolve` matches the saved repository full
name to the public GitHub repository catalog, then reads the authenticated-client
`repo-settings` compatibility contract when a binding exists.

Local `project-repository-plan-bind` and `project-repository-plan-unbind`
commands require exact `project.repository.bind` or
`project.repository.unbind` W2 policy grants. The unbind registry entry is a
`LOCAL`/`local-inference` capability used only for owner-policy validation; no
remote route, method, or payload is evidenced. The observed bind PATCH is not
executed because its OAuth write authorization, strict before-state preservation,
readback, and ambiguous-result behavior remain unverified. The exact unbind
payload was not observed at all. `project-repository-apply` is consequently a
local blocked-status command with no network transport. See
[`project-repository-binding.md`](project-repository-binding.md).

## Intentionally excluded

Archive/update, deletion, checkpoint restoration, PR mutations, terminal and
log access, attachments, billing writes, credentials, and workspace recovery
are not wrapped because their payloads, sensitivity, or side effects need
stronger evidence and dedicated safety design. Their discovered contracts may
appear in the registry without becoming executable.

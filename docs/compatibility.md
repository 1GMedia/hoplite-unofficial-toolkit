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

## MCP endpoint policy

The authenticated client evidences `POST /api/mcp/auth-analysis` and
`POST /api/mcp/probe`, each with a `{url}` body. Both can cause Hoplite to
contact a caller-selected external origin, so both are W2 external-contact
operations. Their OAuth/API-key compatibility and Hoplite-side DNS, redirect,
and rebinding controls are not verified; the registry therefore marks them
blocked.

`mcp-endpoint-check --url <https-url>` is a separate local-only command. It
enforces a 2,048-byte HTTPS URL policy and rejects userinfo, query strings,
fragments, control characters, backslashes, encoded separators, double
encoding, IP literals, dotless or trailing-dot names, invalid DNS labels,
`.arpa`, the reserved example domains and their subdomains, and other internal
or special-use suffixes. Its result omits the raw canonical URL and pathname so
secret-bearing path content is never echoed. It sends no request to Hoplite or
the target.

`--resolve` explicitly opts into one local OS-resolver observation. At most 16
combined IPv4/IPv6 answers are accepted and every answer must be ordinary public
unicast. The policy conservatively rejects all relevant entries in the
[IANA IPv4 special-purpose registry](https://www.iana.org/assignments/iana-ipv4-special-registry/)
and [IANA IPv6 special-purpose registry](https://www.iana.org/assignments/iana-ipv6-special-registry/),
including protocol/service anycasts that IANA marks globally reachable, plus
multicast. Examples include the AS112, AMT, PCP/TURN, ORCHID, 6to4, and IPv4/IPv6
documentation ranges such as `3fff::/20`. The default lookup runs in an isolated
child process. At the three-second observation deadline, the CLI kills and
detaches that child so the lookup cannot keep the CLI alive. This bounds the
CLI's observation, not all underlying OS resolver work, and there are no
retries. The result cannot prove which address Hoplite will resolve, whether
redirects are revalidated, or whether the remote service prevents DNS rebinding.
A successful check is therefore not permission or proof that the blocked POST
routes are safe to call.

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

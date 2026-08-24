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

## Intentionally excluded

Archive/update, deletion, checkpoint restoration, PR mutations, terminal and
log access, attachments, billing, credentials, and workspace recovery are not
wrapped because their payloads, sensitivity, or side effects need stronger
evidence and dedicated safety design.

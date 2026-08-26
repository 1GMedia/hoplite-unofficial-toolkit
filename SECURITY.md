# Security

Do not report credentials, OAuth tokens, private prompts, repository contents,
or reusable Hoplite session material in a public issue.

Before reporting a vulnerability, redact tenant-specific identifiers and use a
private GitHub security advisory or contact the repository owner privately.

The CLI intentionally defaults to read-only behavior. Mutation commands require
both a locally configured thread allowlist and an explicit `--confirm` flag.
The generic `api` command is permanently limited to canonicalized `GET`/`HEAD`
requests; caller-supplied API writes are not supported. Future project and
workspace settings writes must use dedicated commands and an owner-only,
short-lived resource policy in addition to command-specific confirmation and
verification controls.

Project MCP config checks and add/update/remove plans are local-only. Their
inputs and artifacts must be owner-only regular files; stdout is limited to
fixed enums, counts, digests, expiry, and receipts. The first config version
rejects stdio, raw headers/secrets, OAuth, URL credentials, internal endpoints,
and secret-looking URL paths. Plan creation never contacts Hoplite or the
configured server and never sends POST, PATCH, or DELETE.

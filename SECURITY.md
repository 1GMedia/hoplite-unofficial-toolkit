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

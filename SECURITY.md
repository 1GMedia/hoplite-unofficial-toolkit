# Security

Do not report credentials, OAuth tokens, private prompts, repository contents,
or reusable Hoplite session material in a public issue.

Before reporting a vulnerability, redact tenant-specific identifiers and use a
private GitHub security advisory or contact the repository owner privately.

The CLI intentionally defaults to read-only behavior. Mutation commands require
both a locally configured thread allowlist and an explicit `--confirm` flag.

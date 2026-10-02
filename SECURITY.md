# Security

Do not report credentials, OAuth tokens, private prompts, repository contents,
or reusable Hoplite session material in a public issue.

Before reporting a vulnerability, redact tenant-specific identifiers and use a
private GitHub security advisory or contact the repository owner privately.

The CLI intentionally defaults to read-only behavior. Mutation commands require
both a locally configured exact-target allowlist and an explicit `--confirm`
flag. Creation requires a `project:<id>` allowlist entry and explicit operation
ID; stopping requires the exact run ID. Generic API writes are disabled.
The internal API transport does not enforce policy on its own; use dedicated
CLI commands. It bounds responses, refuses redirects, and never retries writes.
Official CLI credential stores are not automatically read by API transport.

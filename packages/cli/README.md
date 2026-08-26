# CLI package

Source for the toolkit's Bun/TypeScript command-line interface. Use the root
scripts for installation, testing, and builds.

The generic `api` command is read-only (`GET`/`HEAD`) and canonicalizes the
request path before fetch. Settings compatibility evidence and the future-write
resource policy live in `src/compatibility.ts` and are exposed through:

```bash
bun run hoplite -- settings-capabilities
bun run hoplite -- compatibility-status
bun run hoplite -- compatibility-diff --baseline <snapshot.json>
bun run hoplite -- resource-policy-check --file <policy.json>
```

These local commands do not authenticate or change Hoplite state.

Feature command modules export typed definitions and are composed by
`src/command-registry.ts`. New project/workspace feature lanes should add an
isolated command module and register its definition group in the composition
root; they do not need to extend the legacy command switch.

Workspace compatibility reads are isolated in
`src/workspace-settings-commands.ts`:

```bash
bun run hoplite -- workspace-defaults-get
bun run hoplite -- workspace-sandbox-default-get
bun run hoplite -- workspace-model-keys-status
bun run hoplite -- workspace-model-connections-list
```

They use exact GET routes through `hoplite_call_api`, a 20-second total timeout,
and no retries. MCP results must contain one exact text block, tool errors are
rejected, and raw text is capped at 2 MiB before JSON parsing. Each command
accepts no positionals or flags. HTTP 401, 402, 403, 404, and 501 are projected
as distinct availability outcomes; an HTTP 200 body that fails the exact
response schema is reported as `schema_drift`. Sandbox specs accept only a null
or `docker-compose` runtime profile.

Provider-key output is presence-only. Model-connection arrays and strings are
bounded and redacted, and `lastError` content is replaced by a boolean
`hasLastError`. Organization identity and every workspace/model-connection
write remain compatibility-registry records only, not executable commands.

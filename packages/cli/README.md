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

Authenticated compatibility reads for integration status are exposed through
the feature module in `src/integration-status-commands.ts`:

```bash
bun run hoplite -- source-control-connections
bun run hoplite -- source-control-repositories
bun run hoplite -- slack-status [--project <project-id>]
bun run hoplite -- linear-status [--project <project-id>]
bun run hoplite -- sentry-status [--project <project-id>]
bun run hoplite -- phone-status
```

The commands accept no unlisted flags or positional arguments, validate them
before OAuth, make exactly one MCP API read without retrying, and enforce
byte/row/string ceilings. Output is aggregate-only: no remote item arrays,
identifiers, names, hosts, accounts, or arbitrary status strings. Provider error
bodies are never returned.

Feature command modules export typed definitions and are composed by
`src/command-registry.ts`. New project/workspace feature lanes should add an
isolated command module and register its definition group in the composition
root; they do not need to extend the legacy command switch.

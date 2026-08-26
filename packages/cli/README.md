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
bun run hoplite -- mcp-endpoint-check --url https://mcp.vendor.dev/mcp
```

These local commands do not authenticate or change Hoplite state.

`mcp-endpoint-check` performs URL-policy checks only by default and never echoes
the raw URL or pathname. Reserved example domains, `.arpa`, and other internal
or special-use suffixes are rejected. Its optional `--resolve` flag performs one
local A/AAAA observation through an isolated OS-resolver child, requires every
answer to be ordinary public unicast, and still sends no HTTP request. IANA
special-purpose ranges are rejected even when designated globally reachable.
At three seconds the CLI kills and detaches the child; this bounds CLI
observation, not all underlying OS resolver work. Local DNS results are not
evidence of Hoplite-side redirect, resolution, or DNS-rebinding controls; remote
auth-analysis and probe remain blocked.

Feature command modules export typed definitions and are composed by
`src/command-registry.ts`. New project/workspace feature lanes should add an
isolated command module and register its definition group in the composition
root; they do not need to extend the legacy command switch.

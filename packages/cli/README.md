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
bun run hoplite -- project-mcp-config-check --file <config.json>
bun run hoplite -- project-mcp-plan-add <project-id> --config-file <config.json> \
  --policy <policy.json> --account-id <id> --workspace-id <id> \
  --origin https://api.hoplite.sh --client-operation-id <id> --out <plan.json>
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

Project MCP config checking and add/update/remove planning are local feature
commands in `src/project-mcp-plans.ts`. They accept only owner-only regular
files, HTTPS HTTP/SSE endpoints, no auth or bearer environment references, and
bounded tool scopes. Update/remove require an owner-only digest-valid current
before-state file. Output is aggregate/digest-only; arbitrary identities,
server names, endpoints, environment names, and tool names stay in the local
files. Plan creation is exclusive mode `0600`; there is no remote apply path.

Feature command modules export typed definitions and are composed by
`src/command-registry.ts`. New project/workspace feature lanes should add an
isolated command module and register its definition group in the composition
root; they do not need to extend the legacy command switch.

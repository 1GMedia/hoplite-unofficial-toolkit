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

`src/project-sandbox-commands.ts` adds two GET-only projections plus two local
rebake review commands:

```bash
bun run hoplite -- project-sandbox-get <project-id>
bun run hoplite -- project-prebuilds-status <project-id>
bun run hoplite -- project-prebuilds-plan-rebake <project-id> \
  --policy <policy.json> --account-id <id> --workspace-id <id> \
  --origin https://api.hoplite.sh --prebuild-digest <sha256> \
  --sandbox-digest <sha256> --output <rebake-plan.json>
bun run hoplite -- project-prebuilds-apply <project-id> \
  --plan <rebake-plan.json> --policy <policy.json> \
  --account-id <id> --workspace-id <id> --origin https://api.hoplite.sh \
  --prebuild-digest <fresh-sha256> --sandbox-digest <fresh-sha256>
```

The status command caps projected records at five and omits failure text and
unknown fields. The plan command validates the exact W2 project grant locally.
It writes a new owner-only plan whose digest binds the exact policy grant,
including its resource risk ceiling, project, state digests, and observed
contract. The apply command securely reloads and recomputes that plan,
revalidates policy freshness and supplied state digests, then returns a blocked
local receipt. It never opens an MCP connection or sends the evidenced
compute-consuming POST.

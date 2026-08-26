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

## Project agent defaults

Read the current defaults with a bounded scalar projection. Instructions are
represented by configured/length metadata unless their contents are explicitly
requested; even then output is capped at 4,000 characters.

```bash
bun run hoplite -- project-agents-get <project-id>
bun run hoplite -- project-agents-get <project-id> --include-instructions
```

Validate a proposed configuration against the live model catalog and generate
a local plan:

```bash
bun run hoplite -- project-agents-plan-set <project-id> \
  --model gpt-5.6-sol \
  --reasoning high \
  --speed fast \
  --pr-review-autofix true \
  --client-operation-id <stable-id>
```

Use `inherit` (or an empty flag value) to normalize model, reasoning, speed, or
PR-autofix to `null`. Instruction text is accepted only from an explicit
regular file and requires an owner-only output plan:

```bash
bun run hoplite -- project-agents-plan-set <project-id> \
  --instructions-file ./AGENTS.md \
  --out ./project-agent-defaults.plan.json \
  --client-operation-id <stable-id>
```

The plan is created with mode `0600` and is never overwritten. Its normal CLI
receipt reports instruction length/configuration only. There is intentionally
no apply command: the PATCH authentication and concurrency/ETag contract is
not verified, so these commands do not change remote Hoplite state.

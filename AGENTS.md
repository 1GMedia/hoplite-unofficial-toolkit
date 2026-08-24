# Contributor instructions

This repository is public. Never commit Hoplite credentials, OAuth state,
private task content, tenant-specific thread IDs, browser cookies, or repository
secrets.

Keep these invariants:

- Read-only behavior is the default.
- Mutations require `HOPLITE_MUTATION_ALLOWLIST` and `--confirm`.
- Creation requires an explicit idempotency key.
- Stop requires an exact run ID.
- Do not automatically retry ambiguous mutations.
- Bound and redact API/timeline output.
- Do not add an undocumented route without recording its method, payload,
  caller evidence, side effects, and compatibility status.
- Tests must use obvious fixtures and must never contact live Hoplite services.

Before committing, run:

```bash
bun run test
bun run typecheck
bun run build
python3 "${CODEX_HOME:-$HOME/.codex}/skills/.system/skill-creator/scripts/quick_validate.py" skills/hoplite-cli
```

The final command is available in Codex development environments. Other
contributors may validate the `SKILL.md` frontmatter manually.

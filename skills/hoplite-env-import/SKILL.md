---
name: hoplite-env-import
description: Import environment variables from a JSON object, local file, or explicitly supplied 1Password shared item into a specific Hoplite project, then verify exact values and saved persistence without exposing credentials.
---

# Hoplite ENV import

Use this workflow when the user asks to add or update environment variables in
Hoplite. It is part of the unofficial Hoplite toolkit and can be installed on
its own; it does not depend on the toolkit CLI or a checkout-specific path.

## Resolve the target and source

- Identify the exact workspace and repository-qualified project, such as
  `team/example-app`. The repository owner matters when project names repeat.
  Confirm that identity in the destination Environment view before pasting.
- Inspect existing variable names without revealing values. An empty environment
  can take the complete import. For an existing environment, preserve keys absent
  from the source and identify collisions. Apply replacements only within the
  user's requested scope; ask about a conflicting value when intent is unclear.
- Read only the source the user supplied. For a 1Password shared link, use that
  shared item rather than searching unrelated vaults or saving a new vault copy.
  Complete any required email verification with the user's existing session.
  Missing, expired, or inaccessible source items are blockers, not empty imports.
- Keep values in working memory when possible. Do not put them in chat, tool
  output, command arguments, shell history, repository files, screenshots, or
  PRs. Suppress secret-bearing UI observations and emit only counts and names.
  Clear temporary value buffers after verification.

## Validate and import

Accept a JSON object whose keys are environment variable names and whose values
are strings. Reject duplicate keys, invalid names, nulls, numbers, booleans,
arrays, and nested objects rather than silently changing their meaning. Preserve
spelling, case, empty strings, URLs, and JSON embedded inside string values.
Do not “correct” names that look misspelled during an import.

The local helper performs validation and comparison with redacted output:

```bash
python3 <skill-directory>/scripts/env_json.py validate --input /private/source.json
python3 <skill-directory>/scripts/env_json.py verify \
  --input /private/source.json --actual /private/readback.json
```

`--input -` reads stdin; no values are accepted as command arguments. Existing
files must stay outside the repository and be restricted to the current user.
The helper is optional when source and destination values already live in a
computer-use runtime; apply the same strict checks there.

Prefer a verified, dedicated environment API only if the installed toolkit
actually supports it. Preserve its mutation allowlist and confirmation gates.
A local mutation plan is not an import. Do not invent a route or use a thread
allowlist to authorize project environment writes.

For the UI workflow, read
[references/ui-import.md](references/ui-import.md). The observed Hoplite UI
accepts a complete `.env` pasted into the **Key** field and stages the imported
rows before a separate **Save**. Recheck current controls; the UI may change.

When every value has no apostrophe or line break, single-quoted `.env` values
preserve dollar signs, hashes, backslashes, and embedded double-quoted JSON:

```text
EXAMPLE_SETTING='fixture value'
EXAMPLE_MAP='{"example":"fixture"}'
```

For values outside that safe subset, use the individual Key/Value fields with
the exact strings. Do not guess an escaping scheme. A helper can create a
private `.env` file when a file is necessary:

```bash
python3 <skill-directory>/scripts/env_json.py dotenv \
  --input /private/source.json --output /private/new-import.env
```

It creates a new owner-only file, refuses to replace an existing file or symlink,
and never prints its contents. Remove task-created secret files after use;
preserve source files supplied by the user.

## Verification and completion

1. Before saving, compare each staged value to its source string in memory.
   Variable names and masked bullets alone do not prove value fidelity. Scroll
   through the full list; native accessibility may expose only visible rows.
2. Save once and wait for the pending state to resolve. A clipboard timeout or
   delayed response is ambiguous: inspect the rows and pending state before
   retrying, so the import is not applied twice.
3. Reopen the project's Environment view. Confirm every imported name persisted,
   no unsaved state remains, and any keys outside the requested scope remain.
   Exact saved readback is preferable when the supported surface exposes it;
   otherwise report the staged-value comparison and persisted-name check as
   separate evidence.
4. Report the workspace/project, imported count, and verification outcome. Saved
   variables do not prove that credentials work, services connect, or an existing
   sandbox has refreshed its environment. Runtime checks require their own scope.

## Device-wide installation

Copy this folder to `${CODEX_HOME:-$HOME/.codex}/skills/hoplite-env-import` after
checking whether a local copy already exists. Preserve local customizations
before updating one. A standalone copy stays usable when a feature worktree is
later removed. Restart Codex or start a new chat to refresh skill discovery.

Validate the skill and its offline helper with:

```bash
python3 <skill-creator-directory>/scripts/quick_validate.py <skill-directory>
python3 -m unittest discover -s <skill-directory>/tests -p 'test_*.py' -v
```

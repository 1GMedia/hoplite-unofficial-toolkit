# Project repository binding

This feature separates evidenced reads, local change planning, and remote
mutation. A local plan is not permission to mutate Hoplite.

## Read contracts

- `GET /api/projects/:projectId` is present in the recorded public OpenAPI. Its
  project response exposes `repos[].repoFullName` and an optional saved branch,
  but it does not expose the current Hoplite repository ID.
- `GET /api/source-control/github/repositories` is present in the public
  OpenAPI. `project-repository-resolve` matches the saved full name to this
  catalog to recover the current Hoplite repository ID and default branch.
- `GET /api/projects/:projectId/repo-settings` was observed in the authenticated
  web client. Its OAuth/MCP credential support remains unverified, so failures
  are reported for the current credential without claiming product absence.

The resolver shows project and repository preview ports separately and does not
invent effective preview-port precedence. Repository lifecycle commands are
never printed by this surface; only enabled/configured state is returned.

## Observed bind contract

The authenticated client sends `PATCH /api/projects/:projectId`. When the
repository selection changes, the patch contains `repositoryId` and, for the
multi-provider source-control path, `sourceControlConnectionId`. A repository
or branch change also sends `baseBranch` and the selected repository's
`defaultBranch`. The same patch preserves the current project `name`,
`setupScript`, `runScript`, and `archiveScript`; its operation wrapper appends
`clientOperationId`.

This is enough to construct a bounded intent plan, but not an executable write:

- OAuth/MCP authorization for PATCH is not verified;
- a safe patch must re-read and strictly preserve current name/script values;
- post-write readback and ambiguous-result reconciliation are not proven; and
- no unbind interaction or exact null/empty unbind payload was observed.

The unbind capability is therefore registered as `local-inference` with a
`LOCAL` planning path solely so the owner-only W2 resource policy can be
validated. It does not claim an authenticated-client route, method, or payload.

Therefore `project-repository-apply` is a local blocked-status command and
never opens a network client.

## Local plans

Both plan commands require an owner-owned `0400` or `0600` resource policy with
a lifetime of 24 hours or less, an exact project/capability grant, a W2 ceiling,
the digest from `project-repository-get`, and a stable client operation ID.

```bash
bun run hoplite -- project-repository-get <project-id>

bun run hoplite -- project-repository-plan-bind <project-id> \
  --policy <policy.json> \
  --account-id <account-id> \
  --workspace-id <workspace-id> \
  --origin <exact-policy-origin> \
  --before-digest <state-digest> \
  --repository-id <repository-id> \
  --repository-full-name <owner/repository> \
  --default-branch <branch> \
  --base-branch <branch> \
  --client-operation-id <stable-id>
```

Use `--inherit-default` instead of `--base-branch` to plan a null project branch
override. The plan validates local policy and emits a deterministic digest, but
its `remoteApply` status remains `blocked`.

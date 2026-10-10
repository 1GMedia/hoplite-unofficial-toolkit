---
name: hoplite-factory
description: Plan and supervise explicitly authorized, budgeted Hoplite Factory jobs with draft PR delivery, stable retry identities, operation-receipt reconciliation, and clear billing boundaries.
metadata:
  upstream-source: https://hoplite.sh/docs/factory-example.mjs
  upstream-sha256: "bcb6575785e4a5652c844a7010fcdaba861eddc85ead5a4516366f6c5538c2f0"
  upstream-runner: scripts/factory-example.mjs
---

# Hoplite Factory

Use for a bounded coding job on a verified Hoplite project, not open-ended
unattended work. Read-only planning is the default; a request to inspect or
install this skill does not authorize a run, spend, approval, or PR mutation.

## Upstream runner and execution boundary

The bundled [Factory runner](scripts/factory-example.mjs) is an unmodified copy
of <https://hoplite.sh/docs/factory-example.mjs>, retrieved 2026-10-10. Its source
URL and byte-for-byte SHA-256 are recorded in the frontmatter. Verify that hash
before use. Updating it requires reviewing the upstream change and updating the
pin, not patching the vendored file. The repository's drift watcher tracks the
same source; drift detection does not authorize executing an updated runner.

The example requires Node 24 and performs real writes. It does **not** enforce
`HOPLITE_MUTATION_ALLOWLIST` or `--confirm`, retries some failed writes, and prints
raw events, diffs, and errors. Do not execute its CLI entry point as a guarded
toolkit command. This skill adds guidance and the upstream artifact, not a new
runtime adapter or new toolkit API commands.

Only use `runFactory` through a separately reviewed caller that enforces the
admission gates below, disables automatic retries of ambiguous mutations via
its injected `fetch`, and bounds/redacts responses, `onEvent`, results, and
errors. If that caller is unavailable, stop with a read-only plan. Do not fall
back to running the example directly, raw MCP, or the official CLI to bypass a
failed guard. Keep the upstream artifact unchanged.

## Admit a budgeted job

Before dispatching any write:

1. Resolve the exact workspace, existing project, and repository read-only.
   Verify identity and authorized model availability; do not guess IDs. Prefer
   an existing project over the runner's optional project-creation flow.
2. Require explicit authorization for the task and a **positive spend cap**.
   `HOPLITE_SPEND_LIMIT_MICROS` must be a positive safe integer in USD
   microdollars (`1000000` = $1 lifetime thread budget). Missing, zero, negative,
   fractional, or non-finite values block admission. Never increase the cap
   automatically to unblock a run.
3. Require the caller's `--confirm` and a preconfigured
   `HOPLITE_MUTATION_ALLOWLIST` entry `project:<exact-project-id>` for creation.
   Every existing-thread mutation additionally requires its exact thread ID;
   project permission does not authorize thread writes. Do not expand the
   allowlist yourself. Unsupported project/webhook/attachment/approval/PR
   operations remain blocked unless a reviewed caller has an explicit gate.
4. Persist one explicit `HOPLITE_FACTORY_ID` (at most 48 characters) as the
   factory/job ID, the approved inputs, and budget in a private durable job
   record **before** dispatch. Reuse the same ID and identical inputs on an
   authorized retry. The runner derives `Idempotency-Key` values such as
   `<factory-id>:thread` and `<factory-id>:pr`; creation must never lack a key.
5. Keep `HOPLITE_MERGE` and `HOPLITE_APPROVE_TOOLS` unset or `false` unless the
   user explicitly opts in to each behavior. Inspect inherited settings before
   launch. A generic instruction to finish a task is not merge or blanket tool
   approval permission. Draft PRs are the default. `HOPLITE_MERGE=true` creates a
   ready PR and attempts a squash merge; **marking a PR ready can trigger
   Hoplite's auto-merge**, even without a separate merge command.
6. Inject `HOPLITE_API_KEY` only from an environment variable populated by a
   secret manager or CI secret store. Never print keys, put them in arguments,
   prompts, receipts, files in this repository, or logs, or scrape official CLI
   or Keychain credentials. Keep shell tracing off. Use least-privilege,
   project-scoped credentials and the hosted `https://api.hoplite.sh` origin.

The runner also reads `HOPLITE_PROJECT_ID`, `HOPLITE_PROMPT`, optional
`HOPLITE_MODEL`, and `HOPLITE_API_URL`. Keep prompts and job records private.
Leave `HOPLITE_REPOSITORY_ID`, `HOPLITE_ATTACHMENT_PATH`, and webhook settings
unset for a simple existing-project job; those optional flows need separate
scope, gates, and secure storage for any one-time secrets.

## Reconcile before retrying

Save resource IDs, exact run ID, per-step idempotency keys, request IDs, and
`x-operation-id`/operation IDs in the private job record. Do not store raw
secret-bearing API bodies. HTTP acceptance is not proof of completed work.

For timeouts, transport failures, `operation_outcome_pending`, or
`operation_outcome_unknown`, stop write dispatch. Do **not** automatically retry
an ambiguous mutation, mint a new factory/job ID, or create another thread.
Read `GET /api/operations/{id}` using the returned operation ID and inspect the
referenced resource/run read-only. A pending receipt remains pending; honor
`Retry-After` when checking again. If no operation ID was returned, inspect
known resource IDs and request evidence; unresolved identity is a blocker, not
permission to resend. Only resume after reconciliation and explicit retry
authorization, with the same factory/job ID, operation key, and inputs.

Persist resource IDs independently: upstream guarantees settled receipt
retention for at least seven days, not forever. An expired/missing receipt does
not prove that a write never happened. Replayed receipts omit one-time secrets;
recover them from approved secure storage instead of logging or recreating them.

A client timeout does not cancel the cloud run. Stop requires a fresh, exact
run ID, the exact thread allowlist entry, and `--confirm`; never stop whichever
run happens to be active. Do not auto-approve a waiting tool request or retry a
failed run just because budget remains.

## Billing

Runs started as a **signed-in user** through official CLI login / OAuth bill
that user's connected **Codex, Claude, or Grok subscriptions where available**.
Runs started with a **service-account key (`hop_svc_`) bill workspace credits**;
service accounts do not inherit the creator's personal subscriptions.

Prefer user-started runs for cost when those subscriptions cover the chosen
model; prefer service accounts for unattended automation with explicit spend
caps. Do not silently switch identities or promise zero cost when a subscription
is unavailable. The bundled API-key runner does not log in through the official
CLI or OAuth, so it must not be described as automatically using user billing.

## Completion evidence

Report only a bounded, redacted summary: job/project/thread/run IDs as
appropriate for the recipient, approved cap, verified run outcome, reconciliation
status, and draft PR URL. Verify tests and PR head/state separately; a created
PR does not prove successful QA or deployment. Do not mark it ready or merge
without explicit authorization. Keep prompts, diffs, event payloads, credentials,
and private receipts out of public reports.

Sources: [Factory guide](https://hoplite.sh/docs/factory),
[retries and receipts](https://hoplite.sh/docs/factory/retries),
[service-account authentication](https://hoplite.sh/docs/api/authentication).

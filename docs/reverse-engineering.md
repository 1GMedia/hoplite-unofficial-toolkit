# Reverse-engineering record

Assessment date: 2026-08-24.

## Scope

The reconstruction used only public Hoplite documentation, the published
OpenAPI document, public npm metadata/packages, browser-delivered JavaScript,
and ordinary authenticated behavior already authorized by the account owner.
It did not bypass authentication, extract third-party credentials, enumerate
other tenants, fuzz endpoints, or perform unapproved mutations.

## Key artifacts

- OpenAPI SHA-256:
  `e60b93d7502e90c01c10ce537acd02d76944e44117431b6dbf5b96897c7a3c92`.
- Public API client SHA-256:
  `cc67a349fc5bf2dd7ebaac09d4918aba845dee6a0278052015567d0886710f25`.
- Public thread UI SHA-256:
  `7977715198d2abc62f97a337e4bce6660b15bd8310c92b874a52185d0b0e382e`.
- Published platform package tarball SHA-256:
  `b94631aa6c323e32e7c2f0fbeca32dfb4ef14b5fea602825a513da577f49f536`.

The reviewed OpenAPI exposed 12 operations during the assessment. The public
web client contained a larger internal route surface, including the guarded
thread actions documented in `compatibility.md`.

The authenticated client release also evidenced project automation list,
status, execution-history, mutation, run-now, and webhook-credential routes.
Its schemas distinguish `schedule` and `webhook` triggers, cron/interval
schedules, and execution states `accepted`, `thread_created`, and `failed`.
Official documentation independently confirms the trigger semantics, but the
project-scoped management/read routes are not part of the reviewed OpenAPI.
Only the bounded list/detail projection, aggregate status, and execution-receipt
reads are implemented; every remote automation write and credential-returning
route remains blocked.

## Reconstruction boundary

Only routes with an evidenced method, path, request body, and caller were
promoted into dedicated commands. Sensitive or destructive surfaces remain
excluded. Output is recursively bounded and redacted, and mutations require a
local allowlist plus explicit confirmation.

Static client evidence proves that a web build called a route; it does not
guarantee future compatibility or authorization through every credential type.
An accepted write is a delivery receipt, not proof that remote work completed.

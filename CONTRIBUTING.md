# Contributing

## Merge flow

- Work on a branch; open a pull request against `main`.
- CI (the **`ci`** job: lint, typecheck, build, test) must pass — it is a
  **strict** required status check, so your branch must also be up to date with
  `main` before merging.
- No reviews are required (this is a solo-operator repo and GitHub forbids
  self-approval), so a green PR is mergeable on its own — **no admin bypass
  needed**.

## CI contract

The CI job name and `main`'s branch-protection `required_status_checks.contexts`
are **one contract**: the protected context is exactly the CI job name (`ci`).
If you rename or split the CI job, update branch protection in the same change,
sourcing the context name from the check-runs API rather than retyping it. See
[`DECISIONS.md`](./DECISIONS.md) ADR-0002.

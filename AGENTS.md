# AGENTS.md

These instructions apply to every task performed in this repository.

## Git Workflow Rules

These rules are mandatory. Do not treat them as preferences.

1. Before creating a new feature branch, switch to `main`.
2. Fetch `origin/main` and update local `main` so it matches the latest remote base before branching.
3. Create the new feature branch from that updated `main`.
4. Do not create a feature branch from another local branch unless the user explicitly approves a stacked branch.
5. If a task appears to depend on work that is not yet on `main`, stop and ask before branching from a non-`main` base.
6. Do not hide branch-base exceptions. State them clearly before taking the action.

## GitHub Sync Rules

1. After creating a commit on a branch that is intended to stay in sync with GitHub, push it to `origin`.
2. Prefer keeping local `main` synchronized with `origin/main` to avoid local-only drift.
3. If local history intentionally diverges, surface that clearly before rebasing, force-pushing, cherry-picking, or stacking more work on top.

## Decision Rule

If there is any conflict between speed and the workflow above, follow the workflow above.

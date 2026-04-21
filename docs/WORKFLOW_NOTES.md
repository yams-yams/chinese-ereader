# Workflow Notes

This file is for small repo-specific workflow rules that are useful to keep explicit without expanding the larger product or architecture docs.

## Git

- Before creating a new feature branch, first switch to `main`, pull/fetch the latest `origin/main`, and update local `main` so the feature branch starts from the current remote base.
- After creating a commit on a branch that is intended to stay in sync with GitHub, always push it to `origin`.
- Prefer keeping `main` synchronized with `origin/main` to avoid local-only drift.
- If local history intentionally diverges, surface that clearly before rebasing, force-pushing, or cherry-picking.

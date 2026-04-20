# Issue 16 Implementation Plan

This document scopes the work for GitHub issue `#16`: add chapter discovery and chapter data APIs for the shared shell.

It is grounded in:

- `docs/PROJECT_PLAN.md`
- `docs/CONTRACTS_AND_API_PLAN.md`
- `docs/CHAPTER_ARTIFACT_LAYOUT.md`

It also reflects the current implementation state in:

- `scripts/build_chapter_artifacts.py`
- `scripts/serve_reader.py`
- `reader/app.js`

## Goal

Expose the minimum backend API surface needed for the shared shell to:

- discover available chapters
- boot `Read` from a persisted chapter-first `read-model.json`
- boot `Refine` from a persisted chapter-first `refine-model.json`

The API should make the frontend stop depending on:

- a hard-coded manifest path
- direct manifest boot for the new shell
- per-page annotation loading for the new `Read` and `Refine` flows

## Current Repo State

The repo already has most of the data contracts required for `#16`.

What already exists:

- `scripts/build_chapter_artifacts.py` rewrites the chapter manifest and materializes:
  - `data/processed/annotations/<series>/<chapter>/read-model.json`
  - `data/processed/annotations/<series>/<chapter>/refine-model.json`
- `read-model.json` and `refine-model.json` already match the chapter-first direction in the refactor docs.
- `scripts/serve_reader.py` already rebuilds chapter artifacts after sentence-status and patch mutations.
- `chapter-001` already has generated `read-model.json` and `refine-model.json`.

What is still missing for `#16`:

- `GET /api/chapters`
- `GET /api/chapters/:series/:chapter/read`
- `GET /api/chapters/:series/:chapter/refine`
- a chapter index builder/loader in the backend
- frontend boot logic that consumes the new API instead of the hard-coded manifest path

## Implementation Approach

## 1. Add backend loaders for app-facing chapter data

Add small file-backed helpers in `scripts/serve_reader.py` for:

- listing manifest files under `data/processed/chapters/<series>/*.json`
- loading a manifest safely from `data/processed/chapters/<series>/<chapter>.json`
- loading `read-model.json` and `refine-model.json` from `data/processed/annotations/<series>/<chapter>/`

These helpers should:

- validate that requested files stay under the expected processed-data roots
- return JSON payloads rather than raw file paths leaking from callers
- centralize shared error handling for missing chapters or missing derived models

## 2. Implement the chapter discovery endpoint

Add `GET /api/chapters` in `scripts/serve_reader.py`.

Response shape should follow `docs/CONTRACTS_AND_API_PLAN.md`:

```json
{
  "chapters": [
    {
      "series": "renjian-bailijin",
      "chapter": "chapter-001",
      "title": "renjian-bailijin / chapter-001",
      "hasReadModel": true,
      "hasRefineData": true
    }
  ]
}
```

Recommended behavior:

- discover chapters from the processed manifest directory, not from `data/translated/`
- use manifest `title` when present and fall back to `<series> / <chapter>`
- set `hasReadModel` based on `read-model.json`
- set `hasRefineData` based on `refine-model.json`
- sort deterministically by `series`, then `chapter`

## 3. Implement chapter read/refine endpoints

Add:

- `GET /api/chapters/<series>/<chapter>/read`
- `GET /api/chapters/<series>/<chapter>/refine`

Behavior:

- load the persisted model JSON from disk
- return it unchanged as the app-facing contract
- return `404` if the chapter or derived model file does not exist

Important boundary:

- the UI should not need a follow-up manifest request once it calls these endpoints
- this issue should not recompose read/refine state on every request if the persisted models already exist

## 4. Keep mutation endpoints aligned with the new API surface

The current mutation endpoints can remain in place during this issue:

- `POST /api/delete-sentence`
- `POST /api/restore-sentence`
- `POST /api/process-patch`

But the implementation should be tightened so the new load endpoints remain the source of truth after mutation.

Specific checks:

- sentence status changes still rebuild `read-model.json` and `refine-model.json`
- patch processing still rebuilds derived chapter artifacts
- mutation responses can stay lightweight because the frontend can refresh from `/read` or `/refine`

This keeps `#16` focused on read/load APIs and avoids pulling mutation renaming into the same branch unless it is trivial.

## 5. Start the shared-shell frontend boot path

The docs make clear that the old page-based reader is temporary, while the shared shell is the target architecture.

For this issue, the frontend slice should be the minimum needed to consume the new APIs:

- replace the hard-coded manifest boot assumption in `reader/app.js`
- load chapter choices from `GET /api/chapters`
- load either `GET /api/chapters/<series>/<chapter>/read` or `/refine` as the main chapter input

Recommended scope for this branch:

- add a small app bootstrap layer for chapter discovery and mode-aware load
- keep the existing page-centric reader functioning until the full Read/Refine UI split lands

Recommended non-goal for this branch:

- do not fully rewrite the current reader UI into the final shared shell if that becomes too large

That means this issue can land in one of two valid forms:

1. Backend-complete plus a thin frontend bootstrap proving the API works.
2. Backend-complete plus the first shared-shell loader if the UI split is already underway on top of this branch.

## 6. Add API verification coverage

Because the backend is file-backed and contract-driven, lightweight coverage is enough.

Recommended checks:

- `GET /api/chapters` returns chapter `chapter-001`
- `GET /api/chapters/renjian-bailijin/chapter-001/read` returns the saved read model
- `GET /api/chapters/renjian-bailijin/chapter-001/refine` returns the saved refine model
- missing chapter returns `404`
- missing read/refine model returns `404`

Verification can be done with either:

- small Python tests against helper functions or the HTTP handler
- a script-based smoke test using the local server

## Suggested Work Order

1. Add backend path/JSON helpers in `scripts/serve_reader.py`.
2. Add `do_GET()` routing for chapter discovery and chapter data endpoints.
3. Verify the endpoints against `chapter-001`.
4. Add a minimal frontend bootstrap that fetches chapters and one chapter model through the API.
5. Keep legacy boot working until the shared-shell refactor replaces it.

## Branch Notes

Feature branch created for this issue:

- `codex/issue-16-chapter-api`

This branch should assume the derived-model artifact work from issue `#14` is present and should build cleanly on top of the sentence-status/rebuild behavior that issue `#15` established.

## Risks And Tradeoffs

## Coupling to current reader

`reader/app.js` is still organized around:

- manifest pages
- raw annotation maps
- runtime enrichment composition

Trying to fully migrate the UI in this issue could turn a medium backend issue into a large frontend rewrite.

Recommended response:

- land the backend API first
- keep frontend adoption incremental

## Discovery source of truth

There are three plausible chapter sources:

- manifest files
- annotation directories
- derived model files

The docs point to manifest discovery as the right backend index source.

Recommended response:

- use `data/processed/chapters` as the canonical chapter index
- treat read/refine model existence as capability flags on top of manifest discovery

## Missing derived models

Some future chapters may have:

- a manifest without enrichment
- a refine model without a read model

Recommended response:

- keep `GET /api/chapters` tolerant of partial readiness
- expose readiness via `hasReadModel` and `hasRefineData`
- let the specific read/refine endpoints return `404` when their artifact is absent

## Definition Of Done

Issue `#16` is complete when:

- the backend exposes `GET /api/chapters`
- the backend exposes `GET /api/chapters/:series/:chapter/read`
- the backend exposes `GET /api/chapters/:series/:chapter/refine`
- endpoint responses match the contracts in `docs/CONTRACTS_AND_API_PLAN.md`
- chapter `chapter-001` can be loaded end-to-end from persisted app-facing models
- the frontend no longer needs a separate manifest fetch once it requests `Read` or `Refine`

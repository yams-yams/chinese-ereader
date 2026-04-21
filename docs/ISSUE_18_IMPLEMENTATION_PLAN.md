# Issue 18 Implementation Plan

This document scopes the work for GitHub issue `#18`: rebuild `Read` mode against the persisted `read-model.json`.

It is grounded in:

- `docs/PROJECT_PLAN.md`
- `docs/CONTRACTS_AND_API_PLAN.md`
- `docs/API_ENDPOINTS.md`
- `docs/CHAPTER_ARTIFACT_LAYOUT.md`

It also reflects the current implementation state in:

- `reader/app.js`
- `reader/index.html`
- `reader/styles.css`
- `scripts/serve_reader.py`

## Goal

Make the learner-facing `Read` experience consume the persisted chapter-level `read-model.json` as its single content contract.

For this issue, `Read` should:

- render from `GET /api/chapters/:series/:chapter/read`
- stop doing client-side enrichment composition
- remain one continuous chapter surface
- preserve hover word help and click sentence help
- exclude deleted sentences from learner-facing interactions
- stop exposing refine/debug tooling in the `Read` UI

## Current Repo State

The repo already has most of the backend data needed for this issue.

What already exists:

- `scripts/build_chapter_artifacts.py` produces a persisted chapter-first `read-model.json`
- `scripts/serve_reader.py` serves `GET /api/chapters/:series/:chapter/read`
- `main` now includes the persisted model rebuild work from issue `#17`, including rebuilds after chapter enrichment import
- enrichment now has a canonical chapter-scoped path at `data/translated/<series>/<chapter>/full-chapter-enrichment.json`
- `reader/app.js` already loads `read-model.json` and `refine-model.json` together when the API is available
- the current reader already uses the persisted read model as display data and the persisted refine model as raw/debug data
- deleted sentences are already filtered out of the learner-facing display path

What is still missing for `#18`:

- a true `Read`-only UI surface
- separation between learner-facing state and refine/debug/review state
- removal of the legacy enrichment merge path from the read boot flow
- removal of debug/review controls from the learner-facing reading experience
- a cleaner chapter-first render path that does not conceptually depend on the old page-review tooling

## Current Frontend Gap

The current `reader/app.js` is a migration bridge rather than a finished `Read` implementation.

Today it still:

- keeps both `displayAnnotations` and `rawAnnotations`
- loads `refine-model.json` even when the user is only reading
- preserves the page-sentence review panel and OCR review panel in the same surface
- keeps the global debug toggle visible in the reading UI
- contains the legacy enrichment merge path for manifest-based fallback boot
- still treats rendered chapter sections as page-oriented frames even though the persisted model is chapter-first

One additional migration note:

- the legacy enrichment fallback in `reader/app.js` still points at the old pre-canonical path shape, which is another signal that `Read` should stop depending on read-time enrichment loading rather than trying to preserve that path

That means issue `#18` is primarily a frontend separation and simplification task, not a backend contract task.

## Implementation Checklist

- [x] Define the `Read` boot boundary in `reader/app.js`

Make `Read` boot from the persisted read endpoint as its primary content source.

Recommended changes:

- treat `GET /api/chapters/:series/:chapter/read` as the only required content payload for `Read`
- keep legacy manifest boot only as an explicit fallback path during migration, not as the normal code path
- stop calling `loadEnrichment()` for `Read`
- stop depending on `state.enrichment`, `enrichAnnotation()`, and `enrichmentPathForManifest()` for learner-facing rendering

Because `main` already materializes and rebuilds the persisted read model after enrichment changes, this issue should not spend time repairing the old client-side enrichment fallback.

Important boundary:

- `Read` should not require `refine-model.json` just to render the reading surface
- if later shared-shell mode selection needs refine data, that should be loaded only for `Refine`

- [x] Split reader state into learner-facing read state vs refine/debug state

The current single `state` object mixes multiple product concerns.

Recommended direction for this issue:

- keep one shared chapter selection state
- isolate `Read` state to the data needed for:
  - chapter choice
  - rendered segments/images
  - read sentences/words/characters
  - hovered word
  - active sentence
- move refine/debug/review-only state behind an explicit mode boundary or remove it from the read entrypoint entirely

This issue does not need to finish the full shared-shell architecture, but it should stop `Read` from owning refine workflow state.

- [x] Rebuild the sidebar and top-level shell for learner-facing `Read`

Issue `#18` acceptance criteria say the reading UI should no longer include refine/debug controls.

Recommended UI scope:

- keep chapter selection
- keep learner-facing word and sentence detail panels
- remove the page sentence review panel from `Read`
- remove the OCR review panel from `Read`
- remove the debug corner toggle from `Read`
- adjust the intro copy and panel labels so the screen reads as a focused reading tool rather than a mixed review tool

Non-goal for this issue:

- do not introduce the full final `Read` + `Refine` shared shell if that turns this branch into a much larger rewrite

One acceptable MVP shape for this branch:

- a dedicated `Read` experience that is visibly cleaner and only exposes learner interactions
- leaving the future `Refine` surface to a follow-up issue/branch

- [x] Simplify chapter rendering around the persisted read model

The persisted read model is chapter-first, but the current UI still bridges it back into page-like annotation maps for rendering.

Recommended scope:

- keep segment image rendering because the art still exists per segment
- keep overlay geometry sourced from the read model only
- ensure the render path does not rely on refine/raw annotation maps for normal learner interactions
- preserve continuous-scroll behavior across all segments

Practical note:

- it is acceptable to keep the internal segment-to-frame render loop for now if the user-facing behavior is chapter-first and read-only
- a deeper render abstraction cleanup can be deferred if it does not change behavior

- [x] Keep hover and click interactions aligned with the persisted contract

The issue specifically calls out learner interactions as acceptance criteria.

Required checks:

- hovering a character still resolves to the containing word from `read-model.json`
- clicking a character still resolves to the containing sentence from `read-model.json`
- sentence detail still shows pinyin, translation, grammar notes, and notes when present
- punctuation-only hotspots remain excluded if that is still the intended learner UX

- [x] Ensure deleted sentences stay out of `Read`

The persisted read model should already exclude deleted content from the learner-facing path, but the UI should not accidentally reintroduce deleted data by consulting refine/debug state.

Specific checks:

- no deleted sentence can be hovered, clicked, or focused in `Read`
- removed learner content does not leave broken word or sentence references
- chapter counts and empty states still behave sensibly if a segment has very little remaining content

- [x] Remove or quarantine review/debug-only code from the read entrypoint

The current file includes a large amount of patch-review and debug logic that should not be part of the learner-facing mode.

Recommended implementation options:

1. Extract read-only helpers and render functions into a dedicated module and leave review/debug code in the old module for later refine work.
2. Introduce a small mode gate where `Read` renders only the read surface and review/debug code is not mounted.

For this issue, option 1 is cleaner if the refactor stays reasonably small.

At minimum, this branch should ensure the shipped `Read` path no longer exposes:

- sentence delete / restore controls
- OCR review patch drafting controls
- review-mode drawing overlays
- debug polygon labels and toggles

- [x] Add focused verification for the read contract

Recommended verification scope:

- boot the reader against `/api/chapters/.../read`
- confirm the chapter renders without loading legacy enrichment JSON
- confirm hover word details work on chapter 1
- confirm click sentence details work on chapter 1
- confirm deleted sentences do not appear in the read interaction layer
- confirm the reading UI contains no debug/review controls

Verification can be a mix of:

- lightweight browser/manual smoke testing
- a small automated DOM or app-state smoke test if adding one is cheap in the current stack

- [x] Document the shipped `Read` behavior after implementation

Once the branch lands, update the docs that still describe the current mixed reader behavior.

Recommended doc updates:

- `docs/PROJECT_PLAN.md`
- `docs/API_ENDPOINTS.md`
- any reader-specific workflow note that still implies `Read` includes review/debug tooling

## Suggested Work Order

- [x] Remove legacy read-time enrichment composition from the learner-facing boot path.
- [x] Load the persisted read model directly as the primary `Read` contract.
- [x] Separate or delete learner-irrelevant review/debug UI from the read entrypoint.
- [x] Simplify render helpers so hover/click interactions only consult read-model data.
- [x] Smoke test continuous-scroll reading and learner panels against `chapter-001`.
- [x] Update docs to reflect the shipped `Read` experience.

## Branch Notes

Feature branch created for this issue:

- `codex/issue-18-read-mode-persisted-read-model`

Current base assumption:

- the persisted model generation and rebuild behavior from issue `#17` is now present on `main`

This branch has already been rebased onto updated `origin/main`, so the implementation can assume the current baseline includes:

- canonical chapter-scoped enrichment storage
- persisted read/refine model generation
- rebuilds after enrichment import, delete, restore, and patch application

## Risks And Tradeoffs

## Shared-shell timing

Issue `#18` says it assumes the shared shell exists, but the current repo is still in a transitional state.

Practical response:

- scope this branch around a clean learner-facing `Read`
- avoid turning it into the full dual-mode architecture unless that work is already underway

## Reader refactor size

`reader/app.js` currently mixes:

- chapter loading
- learner interactions
- debug inspection
- sentence-status review
- OCR patch review

Trying to perfect the architecture in one pass could make this issue much larger than intended.

Recommended response:

- prioritize a visibly correct read-only user experience
- extract only the code needed to make that boundary clear
- leave deeper module decomposition for a follow-up if needed

## Dependency on refine work

The current frontend uses `refine-model.json` as the source of truth for debug and review state.

If we try to preserve all of those tools while also cleaning up `Read`, the branch will stay coupled to refine concerns.

Recommended response:

- do not preserve review/debug tooling in the `Read` surface
- keep this issue scoped to the learner path

## Open Question To Resolve Before Coding

Resolved for this branch:

- deliver a clean dedicated `Read` surface first
- keep the implementation compatible with a later shared-shell split
- avoid mixing issue `#18` with the full `Refine` UI rewrite

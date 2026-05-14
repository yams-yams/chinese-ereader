# Issue 20 Implementation Plan

This document scopes the remaining work for GitHub issue `#20`: rebuild `Refine` mode against the persisted refine base model plus local draft state.

It is grounded in:

- `docs/PROJECT_PLAN.md`
- `docs/CONTRACTS_AND_API_PLAN.md`
- `docs/API_ENDPOINTS.md`
- GitHub issue `#20`

It also reflects the current implementation state in:

- `reader/app.js`
- `reader/index.html`
- `reader/styles.css`
- `scripts/serve_reader.py`

## Goal

Make `Refine` a focused annotation-improvement workspace that:

- loads authoritative chapter state from `GET /api/chapters/:series/:chapter/refine`
- keeps transient patch drafting state local to the frontend session
- supports soft-delete, restore, patch creation, patch processing, and patch deletion
- no longer depends on the old mixed single-surface reader architecture

## Current Repo State

What already exists:

- the shared shell can discover chapters from `GET /api/chapters`
- the frontend can load persisted `read-model.json` and `refine-model.json`
- mode switching already preserves chapter position using a sentence anchor
- `Refine` already renders sentence status, diagnostics, visible-sentence lists, and saved patches
- `Refine` already supports sentence delete / restore
- `Refine` already supports patch delete
- the backend already exposes:
  - `POST /api/delete-sentence`
  - `POST /api/restore-sentence`
  - `POST /api/delete-patch`
  - `POST /api/process-patch`

What is still missing for `#20`:

- a clean shell-to-mode loading boundary
- refine-first chapter readiness and mode fallback behavior
- semantic refine mutation payloads instead of frontend-computed annotation paths
- local/session patch draft state and patch creation UI
- patch processing UI that treats drafting as local until the user commits a patch action

## Concrete Gaps To Fix First

- [ ] Split shell loading so mode-specific data is fetched on demand

Today `loadChapterFromApi()` always fetches both `/read` and `/refine`, which keeps the shell and mode boundaries blurrier than intended.

Recommended changes:

- let the shared shell always fetch chapter discovery
- fetch `Read` data when booting or switching into `Read`
- fetch `Refine` data when booting or switching into `Refine`
- keep already-fetched model state cached in memory so mode switches stay fast
- preserve the existing top-visible-sentence anchor behavior while changing the load boundary

- [ ] Tighten chapter readiness and selection rules around both modes

Today chapter boot prefers entries with `hasReadModel`, which means the app is still conceptually read-first even though `Refine` has its own persisted contract.

Recommended changes:

- keep the shared chapter picker driven by `GET /api/chapters`
- allow the shell to recognize both `hasReadModel` and `hasRefineData`
- if the requested mode is `refine`, prefer chapters that have refine data
- if the requested mode is unavailable for a chapter, fall back explicitly and visibly to the available mode

- [ ] Move refine mutations off frontend-derived annotation paths

Today delete and restore still post `annotationPath`, which keeps filesystem details in the frontend contract.

Recommended changes:

- accept semantic payloads like:
  - `series`
  - `chapter`
  - `segmentId`
  - `sentenceId`
- let the backend resolve the source annotation path from the refine model / manifest boundary
- keep responses lightweight and continue reloading the persisted chapter contracts after committed mutations

- [ ] Align shipped docs and contracts with the actual mutation surface

Issue `#19` already added `delete-patch`, so the docs should treat that endpoint as part of the current shipped refine mutation surface.

Recommended changes:

- keep `docs/API_ENDPOINTS.md` current with every shipped refine mutation
- call out where current endpoint names still differ from the eventual `/api/refine/...` target naming

## Main Issue 20 Implementation Work

- [ ] Introduce explicit local refine draft state in the frontend

Recommended draft state:

- explicit refine sidebar submodes: `view` and `create`
- active draft patch ID or `"new"`
- draft polygon for the missing-text region
- draft text-flow guide geometry
- draft anchor selection
- draft transcript / notes fields
- transient tool state such as draw mode, selection mode, and unsaved edits

Important boundary:

- local draft edits should not rebuild persisted chapter artifacts
- drafting should remain session-scoped unless later persistence is explicitly wanted

- [ ] Add patch creation UI to `Refine`

Recommended MVP shape:

- default `Refine` to a `View Sentences + Patches` section
- enter `Create Patch` from an explicit button in the sidebar
- collapse the view section while `Create Patch` is active
- preserve the local draft while switching back and forth between the two refine submodes
- start a new missing-text patch draft without reusing sentence-selection state
- draw or adjust the patch region
- set text-flow direction
- choose insertion anchor context
- save/process the patch explicitly

Non-goal for this issue:

- do not broaden into a full generic annotation editor

- [ ] Add patch save/process flow that respects local draft state

Recommended flow:

1. create and edit a local draft in the browser
2. submit the committed draft to the backend only when the user saves or processes it
3. refresh `/api/chapters/:series/:chapter/refine` after successful committed mutations
4. refresh `Read` data after committed mutations that rebuild chapter artifacts

- [ ] Keep refine interactions clearly separated from learner-facing read interactions

Recommended checks:

- no read-mode hover/click learner panels inside `Refine`
- page clicks in `view` only affect sentence / patch inspection
- page clicks in `create` only affect patch-creation tools
- sentence focus, patch focus, and diagnostic detail remain refine-oriented
- refine copy and controls read as an annotation workspace rather than a learner reader

## Suggested Work Order

- [ ] Document the shipped `delete-patch` endpoint and current refine mutation surface.
- [ ] Split shell loading so `Read` and `Refine` each fetch their own persisted contracts on demand.
- [ ] Update chapter selection and mode fallback rules to respect `hasReadModel` and `hasRefineData`.
- [ ] Replace `annotationPath` mutation payloads with semantic chapter/segment/sentence payloads.
- [ ] Extract refine-specific state and render helpers out of the monolithic `reader/app.js` path.
- [ ] Add local patch draft state and patch creation UI.
- [ ] Wire patch save/process/reload flow against the backend contracts.
- [ ] Fix the existing saved-patch focus scroll bug so selecting a patch scrolls to the actual patch location instead of moving by a fixed amount.
- [ ] Smoke test delete, restore, patch create, patch process, and patch delete on `chapter-001`.

## Risks And Tradeoffs

## Frontend refactor size

`reader/app.js` is already acting as shell, read surface, refine surface, and render engine all at once.

Practical response:

- keep the current stack
- refactor by module / responsibility before introducing new refine behavior
- avoid turning `#20` into a framework migration

## API naming drift

The current shipped endpoints still use legacy names like `/api/delete-sentence`, while the target docs point toward `/api/refine/...`.

Practical response:

- first tighten payload semantics and behavior
- defer endpoint renaming unless it is small and clearly backward-compatible

## Patch creation scope creep

Patch creation can easily expand from "missing text patching" into a more general annotation editor.

Practical response:

- keep the MVP focused on missing-region patch creation and processing only
- avoid mixing in broader regrouping or geometry-edit workflows on this issue

## Recommendation

Do not switch to React or add a styling library before `#20`.

The fastest path is:

- keep the current static frontend stack
- split `reader/app.js` by responsibility
- land the shell/mutation boundary cleanup first
- then add local refine draft state and patch creation on top of that cleaner foundation

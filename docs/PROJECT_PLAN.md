# ChineseEreader Project Plan

## Purpose

This document captures:

- the current architecture of the application
- the proposed architecture for a cleaner MVP
- the gap between the two

The goal is to make product and technical tradeoffs explicit before implementation work is split into issues.

## Product Goal

ChineseEreader should be a clean, local-first reading tool for processed Chinese manhua chapters.

For the MVP, the product should feel like one application with two mutually exclusive modes:

- `Read`: a focused reading experience
- `Refine`: a focused annotation/data improvement experience

The product should avoid mixing reading interactions with debugging and correction tooling in the same UI surface.

## Current Architecture Of The Application

### App Architecture

The current application is a static web reader plus a scripts-driven local processing pipeline.

Current major layers:

- `reader/`
  - Static frontend delivered by a local Python server
  - Main files: `index.html`, `app.js`, `styles.css`
- `scripts/process_chapter.py`
  - Main CLI entrypoint for chapter processing
- `scripts/split_chapter.swift`
  - Splits tall captures into page images and applies horizontal trimming
- `scripts/ocr_pages.py`
  - Runs PaddleOCR and exports annotation JSON
- `scripts/chapter_enrichment_prompt.py` and related prompt/validation scripts
  - Build and validate local Codex enrichment requests
- `scripts/serve_reader.py`
  - Serves frontend files and exposes a small backend API for annotation edits and patch processing
- `scripts/apply_annotation_patches.py`
  - Merges accepted patch enrichments back into annotation JSON

Conceptually, the app already has three concerns, but they are not cleanly separated:

- reading
- OCR/debug/refinement
- pipeline processing and persistence

The strongest architectural problem today is that reading and refinement are both implemented inside one frontend module.

### Current UI Architecture

The current UI is a single-screen application with:

- a sidebar containing chapter info, word info, sentence info, page sentence review, and OCR review tools
- a main chapter surface showing all processed pages as a continuous scroll
- a global debug toggle

The current frontend state model combines:

- chapter loading
- annotation loading
- enrichment merging
- hover word interaction
- click sentence interaction
- debug page inspection
- sentence deletion
- patch drafting
- patch import/export
- patch processing orchestration
- local draft persistence

This is functional, but it makes the reader mode feel overloaded and fragile.

### Current Backend / Processing Architecture

The backend is not a standalone service. It is a local set of scripts plus a small HTTP layer.

Current backend responsibilities are spread across:

- chapter processing CLI
- page splitting CLI
- OCR export CLI
- prompt building / validation CLI
- patch application CLI
- local reader server with HTTP endpoints

This is acceptable for a local-first MVP, but the interface between frontend and backend is underspecified.

### Current API Surface

There is currently a very small HTTP API exposed by `scripts/serve_reader.py`.

Current endpoints:

- `POST /api/delete-sentence`
  - Deletes a sentence from an annotation file on disk
- `POST /api/process-patch`
  - Runs the focused OCR patch pipeline
  - updates review sidecar data
  - builds a prompt
  - runs local Codex enrichment
  - validates output
  - applies the patch to annotation JSON

Implicit backend surface outside HTTP:

- chapter processing via CLI
- OCR generation via CLI
- chapter enrichment via CLI/prompt files
- patch validation and application via CLI

Current reality:

- the browser only talks to two backend endpoints
- many backend capabilities exist, but only as scripts
- some frontend behaviors still depend on frontend-managed interpretation rather than backend-owned contracts

### Data Contract Maps That Currently Exist

#### 1. Raw Capture Contract

Source-of-truth input:

- `data/raw/<series>/<chapter>/<part>.png`

Purpose:

- manual screenshots captured from Bilibili Manga

#### 2. Processed Page Contract

Derived page images:

- `data/processed/pages/<series>/<chapter>/page-001.png`

Produced by:

- `scripts/split_chapter.swift`

#### 3. Chapter Manifest Contract

Current manifest:

- `data/processed/chapters/<series>/<chapter>.json`

Current fields:

- `series`
- `chapter`
- `pageCount`
- `pages[]`
  - `id`
  - `image`
  - `annotation`

Current limitation:

- manifest discovery is not implemented at the app level
- the reader is hard-wired to one manifest path

#### 4. OCR Annotation Contract

Current annotation files:

- `data/processed/annotations/<series>/<chapter>/page-001.json`

Current top-level shape includes:

- `sourceImage`
- `imageSize`
- `qualitySummary`
- `characters[]`
- `words[]`
- `sentences[]`

Current note:

- this contract mixes reader-facing data with OCR/debug metadata
- it is usable, but not clearly separated into "canonical annotation" vs "diagnostic metadata"

#### 5. Chapter Enrichment Contract

Current enrichment output:

- `data/translated/<series>/<chapter>/full-chapter-enrichment.json`

Current top-level shape includes:

- `series`
- `chapter`
- `sentence_analyses[]`
- `chapter_notes[]`

Current note:

- enrichment is stored separately from annotation JSON
- the reader merges enrichment into OCR annotations at runtime
- this means "read-ready data" is assembled in the frontend rather than precomputed or served in a unified contract

#### 6. Patch Review Contract

Current review sidecar:

- `data/review/<series>/<chapter>/patches.json`

Current patch shape includes:

- `patch_id`
- `page_id`
- `kind`
- `region.polygon`
- `text_flow.mode`
- `text_flow.guide`
- `ocr_candidate`
- `user_transcript`
- `anchor`
- `notes`

This is a useful contract and should likely survive into the refined architecture.

Important current nuance:

- nearby sentence context is not stored in the patch review sidecar itself
- it is currently derived at prompt-build time by `scripts/build_codex_patch_prompt.py`
- the current derivation uses nearby annotation sentences on the same page plus insertion anchors when available

#### 7. Patch Enrichment Contract

Current patch enrichment is built and validated separately, then applied into the page annotation file.

Current note:

- this pipeline is logically backend work
- the current frontend initiates it, but should not own its logic

### Current Features From The User's Point Of View

#### Reading Features

- can load a processed chapter and display it as one continuous vertical scroll
- can hover text hotspots to inspect word-level information
- can click text hotspots to inspect sentence-level information
- can see enriched pinyin and translation when enrichment data exists
- can read using the original page art rather than extracted text only

#### Debug / Inspection Features

- can toggle OCR debug visibility
- can inspect page-level OCR sentence groupings
- can select pages and sentences while debugging
- can reload a page's annotations from disk

#### Refinement Features

- can delete sentences from annotation JSON
- can create missing-region patches
- can draw patch region geometry
- can draw text-flow guide geometry
- can save/import/export patch drafts
- can run focused OCR on a patch region
- can run patch enrichment and apply the result back to annotation JSON

#### Pipeline Features

- can ingest raw captures
- can process raw chapter parts independently, though stitch-before-split is not implemented yet
- can split tall chapter captures into pages
- can trim horizontal gutters before OCR
- can run PaddleOCR to produce annotations
- can build prompt payloads for full-chapter enrichment
- can validate full-chapter and patch structured outputs
- can merge patch enrichments into annotation JSON

### Current Limitations From The User's Point Of View

#### Reading Experience Limitations

- reading and refinement tools are mixed in one UI
- the reader surface is visually and mentally overloaded
- the user sees controls that are irrelevant to reading
- the chapter is hard-wired rather than dynamically selected from available manifests
- chapter-level browsing is incomplete

#### Refinement Experience Limitations

- refinement is framed as debug/review inside the reader instead of as a first-class mode
- sentence deletion is destructive but lightweight in UX
- deleted content is physically removed rather than soft-deleted
- page splitting review is not implemented as a dedicated workflow
- word-boundary and sentence-grouping correction are only partially supported
- the refinement UX is tied tightly to current frontend state rather than a clean backend action model
- mode switching does not yet preserve a shared chapter position model

#### Backend / Data Limitations

- API surface is too small and too implicit
- many operations exist only as local scripts, not app-facing endpoints
- read-ready data is assembled in the browser by merging multiple sources
- annotation files contain both product data and diagnostic data without a clear contract boundary
- OCR filtering for implausible detections is not finalized
- enrichment execution/logging is still ad hoc

## Proposed Architecture Of The Application

### Proposed App Architecture

The application should be organized as one shared app shell plus two mutually exclusive mode surfaces.

#### Shared App Shell

The shell should own:

- app boot
- available chapter discovery
- chapter selection
- mode selection
- shared loading and error handling
- shared data refresh

The shell should not own mode-specific business logic.

#### Read Mode

`Read` should be a focused reading experience only.

Responsibilities:

- render the chapter as continuous scroll
- render learner-facing word/sentence interactions
- show reading panels and lightweight reading controls
- consume read-ready data from backend contracts
- preserve reading position when switching modes

Should not contain:

- OCR debug controls
- sentence deletion controls
- patch drafting tools
- annotation editing controls

#### Refine Mode

`Refine` should be a focused annotation improvement workspace.

Responsibilities:

- inspect OCR output and annotation geometry
- show annotation-level metadata and quality signals
- allow hiding or restoring bad OCR content
- allow missing-text patch creation and application
- preserve the shared chapter position when switching from `Read`
- eventually support more correction operations such as regrouping or merge/split actions

Should not contain:

- reading-side hover/click learner panels
- reading-oriented layout copy
- mixed reading/debug interactions

### Proposed Frontend Role

Both `Read` and `Refine` should be thin clients.

Frontend responsibilities:

- render backend-provided state
- collect user input
- maintain presentational UI state
- create explicit mutation requests
- call backend endpoints
- update local state from backend responses

Frontend should avoid owning:

- OCR heuristics
- patch geometry synthesis rules
- annotation normalization rules
- mutation persistence logic
- enrichment orchestration logic

### Proposed Backend Architecture

The backend can remain local-first and file-backed, but should be treated as the application core.

Responsibilities:

- chapter discovery
- read-model assembly
- refine-model assembly
- annotation validation
- annotation mutation operations
- patch pipeline orchestration
- OCR generation/filtering
- enrichment orchestration and logging
- persistence to JSON

Internally, the backend can continue using the current scripts where appropriate, but the app should talk to a stable API rather than to pipeline details.

### Proposed Backend API Surface

The exact shape can be refined later, but the MVP should have a deliberate application-facing API.

#### App / Chapter Endpoints

- `GET /api/chapters`
  - list available series/chapters
- `GET /api/chapters/:series/:chapter/read`
  - return read-ready chapter data for `Read`
- `GET /api/chapters/:series/:chapter/refine`
  - return refine-ready chapter data for `Refine`

#### Refinement Mutation Endpoints

- `POST /api/refine/delete-sentence`
  - soft-delete a sentence and persist annotation changes
- `POST /api/refine/restore-sentence`
  - restore a previously deleted sentence
- `POST /api/refine/patches`
  - save or update a patch sidecar entry
- `POST /api/refine/patches/process`
  - run focused OCR + enrichment + merge for a patch
- `POST /api/refine/reload-page`
  - reload persisted page state after mutation

Possible future MVP endpoints if needed:

- `POST /api/refine/filter-sentence`
  - mark OCR content as ignored rather than physically deleting immediately
- `POST /api/refine/rebuild-read-model`
  - if a precomputed read model is introduced

#### Pipeline/Admin Endpoints Or CLI

These can remain CLI-first for MVP if they are not part of the day-to-day app workflow:

- process chapter
- run full chapter enrichment
- validate outputs
- rebuild derived assets

The key rule is that `Read` and `Refine` should not need to understand those pipelines directly.

### Proposed Contract Maps

#### 1. Chapter Index Contract

New app-facing contract:

- list available series/chapters
- indicate whether read data exists
- indicate whether refine data exists

Purpose:

- remove hard-coded chapter bootstrapping from the frontend

#### 2. Read Model Contract

Target contract for `Read`:

- chapter metadata
- ordered reading segments
- read-ready annotations
- learner-facing word data
- learner-facing sentence data
- chapter-level reading position anchors

Goal:

- `Read` should consume one canonical contract
- it should not merge OCR JSON plus enrichment JSON in the browser

Decision:

- this model should be precomputed and saved when full-chapter enrichment is first accepted
- `Read` should then load that precomputed contract directly

#### 3. Refine Model Contract

Target contract for `Refine`:

- chapter metadata
- refine-visible reading segments or windows
- diagnostic metadata
- review sidecar data
- quality flags
- patch state
- sentence visibility and deletion state
- nearby-context data or enough information for the backend to derive it deterministically

Goal:

- `Refine` gets annotation detail and diagnostics
- `Read` does not have to carry refine-only data

Example differences between `Read` and `Refine`:

- `Read` includes learner-facing word glosses and sentence translations ready to render
- `Refine` includes OCR confidence, quality flags, and deletion state for those same sentences
- `Read` hides deleted content entirely
- `Refine` can hide deleted content by default but still surface it for restore and inspection
- `Read` only needs stable render geometry for interactive reading
- `Refine` needs edit-oriented metadata like patch anchors, source provenance, and diagnostic scoring
- `Read` can flatten implementation segments into one reading flow
- `Refine` may still need implementation segment identities to target a persisted image region precisely

#### 4. Mutation Request / Response Contracts

Target mutation contracts should be explicit and action-oriented.

Examples:

- delete sentence request
  - chapter identity
  - segment identity
  - sentence identity
- restore sentence request
  - chapter identity
  - segment identity
  - sentence identity
- patch save request
  - patch payload
- patch process response
  - persisted patch
  - updated page annotation summary
  - any OCR/enrichment outcome metadata needed by `Refine`

Goal:

- frontend sends intent
- backend returns authoritative updated state

#### 5. Internal Storage Contracts

Existing storage can largely remain:

- raw captures
- processed pages
- OCR annotations
- review sidecars
- translated/enrichment outputs

What should change is not necessarily storage shape first, but contract ownership and app-facing composition.

#### 6. Segment vs Page Boundary

Current storage and OCR contracts are page-based.

Proposed direction:

- app-facing contracts should stop treating pages as the primary product concept
- `Read` should be chapter-first and continuous
- `Refine` should be able to operate on whatever sentences or text regions are visible, even if they span former page boundaries or long segments

Working recommendation:

- keep a storage-level partition for now because OCR geometry, patch targeting, and file-backed persistence still need a stable image anchor
- de-emphasize or remove pages from the app-facing model wherever possible
- treat stored image partitions as implementation segments rather than as reading pages

## Gap Analysis

### 1. UI Mode Separation

Current:

- reading, debugging, and refinement coexist in one surface

Target:

- `Read` and `Refine` are mutually exclusive UIs inside one shared shell

Gap:

- large frontend refactor
- explicit mode-specific state and components need to be introduced

Priority:

- high

### 2. Reader Simplification

Current:

- reader contains many non-reading responsibilities

Target:

- `Read` becomes a narrow, stable reading client

Gap:

- remove refine/debug logic from read surface
- stop using one monolithic frontend module for all behaviors

Priority:

- high

### 3. Refine As A First-Class Workspace

Current:

- refinement exists as embedded review/debug tooling

Target:

- `Refine` is a dedicated mode for improving annotations and OCR-derived data

Gap:

- define the refine information architecture
- define the MVP refine action set
- route all refine mutations through explicit backend actions

Priority:

- high

### 4. App-Facing Chapter Discovery

Current:

- frontend is hard-wired to one manifest file

Target:

- shared shell loads available chapters dynamically

Gap:

- chapter index endpoint or equivalent app-facing manifest discovery layer

Priority:

- high

### 5. Read Model Contract

Current:

- frontend merges OCR annotation data with chapter enrichment data at runtime

Target:

- `Read` consumes one authoritative read-ready contract

Gap:

- define the read model shape
- decide whether to assemble it on request or precompute it

Priority:

- high

### 6. Refine Model Contract

Current:

- frontend directly manages a lot of annotation/editing assumptions

Target:

- `Refine` consumes a backend-owned refine model

Gap:

- define the refine model shape
- include patch state, diagnostics, and mutation outcomes cleanly

Priority:

- high

### 7. Backend API Formalization

Current:

- only two HTTP endpoints exist
- many backend capabilities are only available through scripts

Target:

- deliberate app-facing API for chapter loading and refinement operations

Gap:

- verify MVP backend capability
- formalize the minimum HTTP surface needed by `Read` and `Refine`

Priority:

- high

Note:

- backend logic may already be sufficient for most MVP needs
- the missing piece is likely API formalization rather than pipeline reinvention

### 8. OCR Filtering / Annotation Quality Control

Current:

- quality scoring and flags exist
- export-time filtering for implausible OCR detections is not finalized

Target:

- junk detections are handled before they degrade refine or enrichment workflows

Gap:

- finalize filtering strategy and its contract implications

Priority:

- medium to high

### 9. Enrichment Runner Formalization

Current:

- full chapter enrichment is prompt-driven and ad hoc

Target:

- reproducible enrichment workflow with logging and predictable outputs

Gap:

- implement or formalize the logged runner from issue `#9`

Priority:

- medium

### 10. Refinement Coverage

Current:

- missing-region patching exists
- sentence deletion exists
- page split review and richer regrouping workflows are incomplete

Target:

- MVP refine scope is explicit and intentionally limited or expanded

Gap:

- decide which refine operations are truly MVP-critical
- avoid accidental scope creep

Priority:

- medium

### 11. Arbitrary Capture Stitching Before Split

Current:

- raw chapter parts are processed individually before page splitting

Target:

- all raw parts for a chapter are stitched together in capture order before the split phase
- splitting then happens on the stitched chapter canvas rather than on arbitrary screenshot chunks

Gap:

- add a stitching stage ahead of split detection
- define the chapter-part ordering contract
- ensure downstream segment/image coordinates remain stable

Priority:

- medium to high

Reason:

- current screenshot boundaries can cut through panels
- stitching first should produce cleaner downstream segments and more coherent refine windows

### 12. Split Quality And Oversized Segment Control

Current:

- split detection is driven by long mostly-white horizontal gaps
- the current splitter uses a conservative minimum blank-gap threshold and a minimum segment height
- this can leave very tall segments intact when a chapter has weak whitespace separators
- the current `minGap` may be larger than necessary for this source material

Target:

- first-pass splitting should avoid producing oversized segments that materially degrade OCR quality
- long segments should be split further when they exceed a practical OCR-friendly height, even if whitespace separators are imperfect
- split boundaries should still remain sparse and intentional rather than over-fragmenting the chapter

Gap:

- evaluate the current split heuristics on chapter 1, especially oversized `page-006`
- test smaller `minGap` values against chapter 1 to see whether they produce better OCR-friendly segments without over-splitting
- add an OCR-aware fallback split strategy such as:
  - maximum segment height
  - local-minimum gap search within large segments
  - secondary split pass for oversized segments
- optionally scope a manual segment-split action in `Refine` as a fallback, while keeping first-pass improvement as the preferred solution

Priority:

- medium to high

Reason:

- very tall segments are likely downscaled more aggressively by OCR and may miss text that would be detected in shorter segments
- the current MVP should prefer improving first-pass split quality over relying on manual patching of preventable misses
- for this chapter source, a fully white horizontal run is often sufficient as a valid split candidate because panel borders usually provide black separators nearby
- smaller gap thresholds may improve first-pass splitting while still allowing the algorithm to choose relatively few segment boundaries

### 13. Soft Delete And Undo

Current:

- sentence deletion physically removes sentences, characters, and words from annotation JSON

Target:

- deletion should become a visibility/state flag so content can be restored
- all downstream operations should treat soft-deleted content as deleted by default

Gap:

- add deletion-state fields to the refine-side contract
- update render/filter logic to ignore deleted content unless explicitly requested
- support restore operations and undo-friendly UX

Priority:

- medium to high

### 14. Shared Position Persistence Across Mode Switch

Current:

- switching activities is not modeled as preserving a shared chapter position

Target:

- toggling between `Read` and `Refine` should preserve the user’s location in the chapter

Gap:

- define a shared position model
- keep the active viewport or anchor stable when the shell swaps mode content

Priority:

- medium

### 15. Contract Boundary Between Product Data And Diagnostic Data

Current:

- annotation files include both user-facing and diagnostic fields

Target:

- clear distinction between:
  - read-ready product data
  - refine-only diagnostic or OCR metadata

Gap:

- contract cleanup and composition rules

Priority:

- medium

## Recommended Planning Conclusions

### What Seems Good Enough To Keep

- local-first pipeline direction
- file-backed storage model
- storage-level image partitioning, even if pages disappear from the product-facing model
- PaddleOCR-based OCR pipeline
- patch sidecar concept
- patch application and merge approach
- continuous-scroll reading concept

### What Should Change First

- frontend architecture
- mode separation
- app-facing contracts
- backend API formalization for the app

### What Should Not Be Assumed Yet

- that the current backend API is sufficient as-is
- that the current annotation contract should be exposed directly to both modes unchanged
- that every current refine behavior belongs in MVP

## Next Planning Step

After reviewing this document, the next step should be to break the gaps into concrete issues with clear MVP scope and sequencing.

Recommended order for issue planning:

1. define target contracts and API surface
2. split frontend into shell + `Read` + `Refine`
3. implement chapter discovery and mode bootstrapping
4. wire `Read` to a read-ready contract
5. wire `Refine` to refine endpoints and contracts
6. close quality-control and enrichment workflow gaps

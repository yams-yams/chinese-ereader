# ChineseEreader Contracts And API Plan

## Purpose

This document defines the proposed app-facing contracts and API surface for the MVP, compares them to the current repo, and identifies where changes are needed.

This is the design pass for the API verification boundary:

- define the target contracts first
- compare them to the current contracts
- evaluate which differences require backend changes, frontend changes, or both

## Decisions Already Made

These decisions are now treated as working assumptions for the MVP plan.

- `Read` and `Refine` are mutually exclusive UI modes inside one shared shell.
- Manual split-segment support is only in MVP if first-pass split calibration fails.
- `Read` model should be precomputed and saved after enrichment is accepted.
- `Refine` should be split into:
  - a persisted precomputed refine base model
  - transient local/session refine draft state
- Sentence deletion should become sentence-level `status`, with:
  - default: `active`
  - deleted: `deleted`
- A minimal chapter picker in the shared shell is sufficient for MVP.
- Split calibration success means:
  - fewer oversized segments on chapter 1
  - no obvious over-splitting
  - sanity check that adjacent segments are not unnecessarily fragmented
- Mode switching should preserve user position using the top-most visible sentence as the primary anchor.

## Recommendation On Precomputing Read vs Refine

### Recommendation

Precompute both:

- a persisted `Read` model
- a persisted `Refine` base model

Do not rebuild the persisted `Refine` model for transient draft activity.

### Why

`Read` is a stable presentation model:

- it depends on accepted enrichment output
- it should be fast to serve
- it should not be rebuilt in the browser
- it changes relatively infrequently

`Refine` has two kinds of state:

- persisted refine base state
  - current authoritative chapter refine state
  - sentence statuses
  - applied patches
  - diagnostics
- transient refine draft state
  - in-progress patch drawing
  - unsaved patch edits
  - temporary tool, filter, and selection state

### Practical Outcome

Recommended split:

- persist a precomputed chapter-level `Read` model
- persist a precomputed chapter-level `Refine` base model
- keep transient refine working state out of persisted model rebuilds

Rebuild both persisted models after committed mutations that change authoritative chapter state, such as:

- soft-delete or restore a sentence
- apply a patch
- future accepted regrouping or split actions

Do not rebuild persisted models for:

- patch drafting
- local tool changes
- temporary filters
- unsaved refine edits

## Position Persistence Model

### Recommended Anchor

Use the top-most visible sentence as the primary anchor.

Suggested shape:

- `sentenceId`
- `segmentId`
- `offsetWithinSentencePx` or small viewport offset

### Why This Works

- sentence IDs are more stable product-facing anchors than raw scroll offsets
- the app is already sentence-centric for both `Read` and `Refine`
- it avoids exposing page-based UX again

### Why Apps Often Preserve Scroll Position

In practice, applications usually preserve scroll using one or more of:

- raw scroll offset in pixels
- DOM element anchor plus offset
- content item ID plus offset
- URL/hash/history state

For this app, sentence anchor plus offset is the best fit because:

- the content is dynamic across modes
- raw pixel scroll alone can drift if layout differs between `Read` and `Refine`
- sentence anchor lets both modes map back to a meaningful content location

## Current App-Facing Contracts

These are the contracts the app effectively relies on today, even if they are not all formalized as such.

### 1. Chapter Manifest Contract

Current source:

- `data/processed/chapters/<series>/<chapter>.json`

Current shape:

```json
{
  "series": "renjian-bailijin",
  "chapter": "chapter-001",
  "pageCount": 24,
  "pages": [
    {
      "id": "page-001",
      "image": "data/processed/pages/renjian-bailijin/chapter-001/page-001.png",
      "annotation": "data/processed/annotations/renjian-bailijin/chapter-001/page-001.json"
    }
  ]
}
```

Current use:

- boot the reader for one hard-coded chapter
- enumerate image/annotation pairs

Current issues:

- no chapter discovery
- page-centric naming leaks directly into the app
- not enough metadata for app shell behavior

### 2. OCR Annotation Contract

Current source:

- `data/processed/annotations/<series>/<chapter>/page-001.json`

Current shape includes:

- `sourceImage`
- `imageSize`
- `qualitySummary`
- `characters[]`
- `words[]`
- `sentences[]`

Current use:

- render hotspots
- support debug inspection
- serve as the base data that the reader enriches in memory
- support refine mutations

Current issues:

- mixed product and diagnostic concerns
- page/segment file is the direct frontend source
- deleted content is physically removed today rather than status-driven

### 3. Chapter Enrichment Contract

Current source:

- `data/translated/chapter1.json`

Current shape includes:

- `series`
- `chapter`
- `sentence_analyses[]`
- `chapter_notes[]`

Current use:

- browser merges sentence analyses into OCR annotations at runtime

Current issues:

- app has to perform contract composition
- no persisted read-ready chapter model
- file naming is chapter-number-specific rather than manifest-driven

### 4. Patch Review Contract

Current source:

- `data/review/<series>/<chapter>/patches.json`

Current shape includes:

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

Current use:

- store missing-text patch drafts and accepted patch inputs

Current issues:

- still uses `page_id` naming
- nearby context is not stored here; backend derives it later

### 5. HTTP API Contract

Current endpoints:

- `POST /api/delete-sentence`
- `POST /api/process-patch`

Current issues:

- too narrow for the proposed app shell
- naming reflects old implementation more than target app behavior
- not enough app-facing read/load contracts

## Proposed App-Facing Contracts

## 1. Chapter Index Contract

Purpose:

- drive the shared shell chapter picker

Proposed shape:

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

Notes:

- can stay minimal for MVP
- title can be simple until richer metadata exists
- chapter manifests remain primarily backend indexing artifacts
- the UI should not need to fetch a chapter manifest separately once it requests `Read` or `Refine`

## 2. Read Model Contract

Purpose:

- single read-ready input for `Read`

Proposed shape:

```json
{
  "series": "renjian-bailijin",
  "chapter": "chapter-001",
  "segments": [
    {
      "id": "segment-001",
      "image": "data/processed/pages/renjian-bailijin/chapter-001/page-001.png",
      "imageSize": { "width": 863, "height": 1951 }
    }
  ],
  "sentences": [
    {
      "id": "sentence-0001",
      "segmentId": "segment-001",
      "status": "active",
      "text": "这是啥玩意儿？",
      "pinyin": "zhè shì shá wányìr?",
      "translation": "What is this thing?",
      "characterIds": ["char-0001"],
      "polygon": [],
      "ocrText": "这是啥玩意儿？"
    }
  ],
  "words": [
    {
      "id": "word-0001",
      "segmentId": "segment-001",
      "text": "这是",
      "pinyin": "zhè shì",
      "translation": "this is",
      "characterIds": ["char-0001", "char-0002"]
    }
  ],
  "characters": [
    {
      "id": "char-0001",
      "segmentId": "segment-001",
      "wordId": "word-0001",
      "sentenceId": "sentence-0001",
      "text": "这",
      "polygon": []
    }
  ]
}
```

Notes:

- `Read` is chapter-first, not page-first
- `segments` remain as implementation anchors for image geometry
- deleted sentences are not returned, or are filtered out before persistence into the model
- this should be precomputed and saved after enrichment
- this model should be self-sufficient for the UI and not require a separate manifest fetch

## 3. Refine Model Contract

Purpose:

- current authoritative editable chapter state for `Refine`

Proposed shape:

```json
{
  "series": "renjian-bailijin",
  "chapter": "chapter-001",
  "segments": [
    {
      "id": "segment-006",
      "image": "data/processed/pages/renjian-bailijin/chapter-001/page-006.png",
      "imageSize": { "width": 863, "height": 13984 }
    }
  ],
  "sentences": [
    {
      "id": "sentence-0015",
      "segmentId": "segment-006",
      "status": "deleted",
      "text": "就是你这小胖子，",
      "ocrConfidence": 0.91,
      "qualityScore": 0.84,
      "flags": ["edge-adjacent"],
      "characterIds": ["char-0100"],
      "polygon": [],
      "source": { "type": "ocr" }
    }
  ],
  "words": [],
  "characters": [],
  "patches": [
    {
      "patch_id": "patch-0001",
      "segment_id": "segment-006",
      "kind": "missing_region",
      "region": { "polygon": [] },
      "text_flow": { "mode": "vertical_rl", "guide": [] },
      "ocr_candidate": "",
      "user_transcript": "",
      "anchor": {
        "insert_after_sentence_id": "sentence-0015",
        "insert_before_sentence_id": null
      },
      "notes": ""
    }
  ]
}
```

Notes:

- `Refine` includes current status and diagnostic fields
- deleted sentences remain present with `status: "deleted"`
- app can hide deleted content by default while still allowing restore
- nearby sentence context can either:
  - be returned directly in refine responses where useful, or
  - be derived server-side when processing a patch
- this is the persisted refine base model, not the transient local draft state
- this model should be self-sufficient for the UI and not require a separate manifest fetch

## 4. Mutation Contracts

Purpose:

- convert UI intent into backend-owned operations

### 4a. Soft Delete Sentence

Proposed request:

```json
{
  "series": "renjian-bailijin",
  "chapter": "chapter-001",
  "segmentId": "segment-006",
  "sentenceId": "sentence-0015"
}
```

Proposed response:

```json
{
  "ok": true,
  "sentenceId": "sentence-0015",
  "status": "deleted"
}
```

### 4b. Restore Sentence

Proposed request:

```json
{
  "series": "renjian-bailijin",
  "chapter": "chapter-001",
  "segmentId": "segment-006",
  "sentenceId": "sentence-0015"
}
```

Proposed response:

```json
{
  "ok": true,
  "sentenceId": "sentence-0015",
  "status": "active"
}
```

### 4c. Save Patch

Proposed request:

```json
{
  "series": "renjian-bailijin",
  "chapter": "chapter-001",
  "patch": {
    "patch_id": "patch-0001",
    "segment_id": "segment-006",
    "kind": "missing_region",
    "region": { "polygon": [] },
    "text_flow": { "mode": "vertical_rl", "guide": [] },
    "ocr_candidate": "",
    "user_transcript": "",
    "anchor": {
      "insert_after_sentence_id": "sentence-0015",
      "insert_before_sentence_id": null
    },
    "notes": ""
  }
}
```

### 4d. Process Patch

Proposed request:

```json
{
  "series": "renjian-bailijin",
  "chapter": "chapter-001",
  "patchId": "patch-0001"
}
```

Proposed response:

```json
{
  "ok": true,
  "patchId": "patch-0001",
  "segmentId": "segment-006",
  "needsRefresh": true,
  "ocr": {
    "text": "漂亮的仙女姐姐！"
  },
  "analysis": {
    "sentence_translation": "Pretty fairy big sister!"
  }
}
```

## Proposed HTTP API Surface

### App / Shell Endpoints

- `GET /api/chapters`
- `GET /api/chapters/:series/:chapter/read`
- `GET /api/chapters/:series/:chapter/refine`

### Refinement Endpoints

- `POST /api/refine/delete-sentence`
- `POST /api/refine/restore-sentence`
- `POST /api/refine/patches`
- `POST /api/refine/patches/process`
- `GET /api/refine/patches/:series/:chapter`

Transient refine draft state can remain frontend-local for MVP unless later persistence is explicitly desired.

### Pipeline / Admin

Remain CLI-first for MVP:

- process chapter
- run full-chapter enrichment
- validate outputs

## On-Disk Artifact Layout

Recommended MVP layout:

- chapter manifest/index stays under:
  - `data/processed/chapters/<series>/<chapter>.json`
- source annotation files stay under:
  - `data/processed/annotations/<series>/<chapter>/page-001.json`
- persisted derived app-facing models live alongside source annotations:
  - `data/processed/annotations/<series>/<chapter>/read-model.json`
  - `data/processed/annotations/<series>/<chapter>/refine-model.json`

Reasoning:

- the chapter manifest is mainly a backend indexing artifact
- `read-model.json` and `refine-model.json` are derived primarily from annotation state
- both app-facing models should already include the segment/image references the UI needs
- the UI should not have to fetch a manifest separately after requesting chapter data

## Current vs Proposed: Contract Deltas

## A. Chapter Discovery

### Current

- no chapter index contract
- reader boot path is hard-coded

### Proposed

- explicit chapter index contract for the shared shell

### Change Needed

Backend:

- add chapter discovery endpoint

Frontend:

- stop hard-coding one manifest path
- add minimal chapter picker

### Difficulty

- low

## B. Read Contract Composition

### Current

- browser loads chapter manifest
- browser loads annotation JSON per page
- browser loads enrichment JSON
- browser merges them in memory

### Proposed

- backend serves one precomputed `Read` contract

### Change Needed

Backend:

- add a read-model build step after accepted enrichment
- add read-model file storage
- add read endpoint

Frontend:

- replace client-side enrichment merge logic with direct read-model consumption

### Difficulty

- medium

### Notes

- existing enrichment and annotation contracts already contain most of the needed information
- this is more about composition and persistence than inventing new semantics

## C. Refine Contract Formalization

### Current

- frontend reads raw annotation files directly
- frontend holds review draft state in localStorage
- frontend calls process/delete endpoints directly

### Proposed

- backend serves one persisted refine base contract

### Change Needed

Backend:

- add refine base-model generation
- add refine chapter endpoint
- formalize response shape
- include current patch sidecars and sentence status

Frontend:

- move away from raw-file assumptions
- load refine base state from backend
- keep transient draft state local

### Difficulty

- medium

### Notes

- current backend already has most underlying source data
- the missing piece is composition, persistence, and rebuild orchestration

## D. Sentence Deletion Semantics

### Current

- delete physically removes sentences, characters, and words from annotation JSON

### Proposed

- sentence-level `status` with `active` / `deleted`

### Change Needed

Backend:

- mutation logic must update sentence status instead of removing content
- all consumers must treat deleted sentences as deleted by default
- patch context selection must ignore deleted sentences
- read-model generation must exclude deleted sentences

Frontend:

- hover/click logic must ignore deleted sentences in `Read`
- `Refine` should allow restore

### Difficulty

- medium

### Notes

- this is one of the few areas where behavior truly changes rather than just contract shape

## E. Patch Identity and Segment Naming

### Current

- patches use `page_id`

### Proposed

- app-facing contracts should prefer `segmentId` / `segment_id`

### Change Needed

Backend:

- either rename in persisted contracts
- or translate page-based storage names to segment-based app names

Frontend:

- use segment terminology

### Difficulty

- low to medium

### Recommendation

- keep file names as-is initially if helpful
- translate to segment terminology in app-facing contracts

## F. Nearby Patch Context

### Current

- derived only during patch prompt building

### Proposed

- backend remains owner of nearby-context derivation

### Change Needed

Backend:

- no major storage change required
- document and preserve derivation behavior
- update derivation to ignore `status: "deleted"` sentences

Frontend:

- none required if this stays backend-owned

### Difficulty

- low

### Recommendation

- do not persist nearby context in the patch sidecar
- keep it derived from the latest authoritative annotation state

## G. Position Persistence

### Current

- no formal shared-position contract

### Proposed

- shared shell manages sentence-anchor-based position across modes

### Change Needed

Backend:

- likely none, unless helper lookup endpoints prove useful

Frontend:

- add shared position state
- map scroll viewport to top-most visible sentence
- restore position after mode switch

### Difficulty

- low to medium

## H. Split Calibration / Oversized Segment Handling

### Current

- split algorithm is gap-based and may leave oversized segments intact

### Proposed

- keep first-pass split sparse, but calibrate it to avoid OCR-hostile oversized segments

### Change Needed

Backend / pipeline:

- split heuristic calibration
- possible secondary split pass if needed

Frontend:

- none unless manual split is later added

### Difficulty

- medium

## What Can Stay Largely As-Is

- file-backed storage
- current OCR annotation richness
- patch sidecar concept
- patch enrichment pipeline
- prompt-building logic concept
- local-first serve-and-edit workflow

## What Needs Real Change

- read-model persistence and serving
- refine-base-model persistence and serving
- sentence status semantics
- chapter discovery endpoint
- frontend contract consumption

## API Verification Summary

### Existing backend capabilities that already cover most MVP behavior

- chapter processing
- OCR annotation generation
- patch sidecar persistence
- focused patch OCR
- patch enrichment prompt generation
- patch output validation
- patch merge into annotations

### Existing backend capabilities that are not yet exposed in app-friendly form

- chapter discovery
- chapter-level read contract serving
- chapter-level refine base contract serving
- restore semantics
- status-driven filtering rules

### Conclusion

The backend appears broadly sufficient for MVP behavior, but not yet sufficient as an app-facing API.

The biggest missing work is:

- contract composition
- API formalization
- sentence status semantics
- derived-model rebuild rules

This supports the current strategy:

- evolve the repo in place
- do not rewrite the backend wholesale
- formalize app-facing behavior around the existing pipeline pieces

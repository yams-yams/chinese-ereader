# Chapter Artifact Layout

This document is the implementation checklist and contract note for GitHub issue `#14`.

## Checklist

- [x] Keep the chapter manifest at `data/processed/chapters/<series>/<chapter>.json`
- [x] Define a canonical `segments[]` manifest contract while preserving legacy `pages[]` during migration
- [x] Define a persisted `read-model.json` contract at `data/processed/annotations/<series>/<chapter>/read-model.json`
- [x] Define a persisted `refine-model.json` contract at `data/processed/annotations/<series>/<chapter>/refine-model.json`
- [x] Keep storage image partitions as implementation `segments`, not reader-facing pages
- [x] Build one backend script that can materialize the manifest and derived chapter artifacts for an existing chapter
- [x] Generate the new artifacts for `renjian-bailijin / chapter-001`
- [x] Keep the current page-based reader unbroken while migration is in progress

## Roles

### Chapter manifest

Path:

- `data/processed/chapters/<series>/<chapter>.json`

Role:

- backend indexing artifact for one processed chapter
- source of ordered storage segments
- compatibility bridge for the current page-based reader

Migration note:

- `segments[]` is the canonical storage-level list for the new architecture
- `pages[]` remains temporarily so the current reader can continue to boot unchanged

### Read model

Path:

- `data/processed/annotations/<series>/<chapter>/read-model.json`

Role:

- persisted chapter-first data for `Read`
- self-sufficient UI contract
- composed from source annotations plus accepted chapter enrichment

Current MVP note:

- every sentence is currently emitted with `status: "active"`
- learner-facing sentence detail includes `grammarNotes` and `notes` when enrichment provides them
- later issues will add soft-delete semantics and synchronous rebuild triggers

### Refine model

Path:

- `data/processed/annotations/<series>/<chapter>/refine-model.json`

Role:

- persisted refine base model for `Refine`
- self-sufficient chapter contract with segment/image references
- includes current annotations plus persisted patch sidecar data

Current MVP note:

- diagnostic fields such as `ocrConfidence`, `qualityScore`, and `flags` are present in the contract but are not yet populated from OCR scoring logic
- later issues will add soft-delete, restore, and rebuild orchestration

## Naming

- The original image partitions are treated as `segments` in the new contracts.
- Existing storage files still use `page-###.png` and `page-###.json`.
- Derived contracts map `page-001` to `segment-001` and preserve `sourcePageId` so migration stays reversible.

## Command

Build the chapter artifacts for the known-good chapter:

```bash
.venv/bin/python scripts/build_chapter_artifacts.py --series renjian-bailijin --chapter chapter-001
```

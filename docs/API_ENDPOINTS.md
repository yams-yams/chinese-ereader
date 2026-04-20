# API Endpoints

This document records the shipped app-facing HTTP endpoints for the local reader.

It complements:

- `docs/CONTRACTS_AND_API_PLAN.md` for the design rationale
- `scripts/serve_reader.py` for the current implementation

## Scope

These endpoints are served by:

- `python3 scripts/serve_reader.py`

The backend remains local-first and file-backed. The API surface is intentionally small.

## GET Endpoints

## `GET /api/chapters`

Purpose:

- drive the shared-shell chapter picker
- advertise which processed chapters currently have persisted app-facing models

Response:

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

- chapter discovery is based on `data/processed/chapters/<series>/<chapter>.json`
- `hasReadModel` reflects `read-model.json`
- `hasRefineData` reflects `refine-model.json`

## `GET /api/chapters/:series/:chapter/read`

Purpose:

- boot the learner-facing `Read` data for one chapter

Response:

- returns the persisted `data/processed/annotations/<series>/<chapter>/read-model.json` payload unchanged

Current top-level shape:

```json
{
  "series": "renjian-bailijin",
  "chapter": "chapter-001",
  "title": "renjian-bailijin / chapter-001",
  "segments": [],
  "sentences": [],
  "words": [],
  "characters": [],
  "chapterNotes": []
}
```

Notes:

- this endpoint is chapter-first, not page-first
- the current reader bridges `segments[].sourcePageId` back into the legacy page-centric UI during migration

Errors:

- `404` if the chapter manifest does not exist
- `404` if `read-model.json` is missing for the chapter

## `GET /api/chapters/:series/:chapter/refine`

Purpose:

- boot the authoritative editable `Refine` base state for one chapter

Response:

- returns the persisted `data/processed/annotations/<series>/<chapter>/refine-model.json` payload unchanged

Current top-level shape:

```json
{
  "series": "renjian-bailijin",
  "chapter": "chapter-001",
  "title": "renjian-bailijin / chapter-001",
  "segments": [],
  "sentences": [],
  "words": [],
  "characters": [],
  "patches": []
}
```

Notes:

- deleted sentences remain present here with `status: "deleted"`
- the current reader uses this model as the source of truth for review/debug state and sentence status

Errors:

- `404` if the chapter manifest does not exist
- `404` if `refine-model.json` is missing for the chapter

## POST Endpoints

## `POST /api/delete-sentence`

Purpose:

- mark one sentence as `deleted` in the source annotation file

Request:

```json
{
  "annotationPath": "data/processed/annotations/renjian-bailijin/chapter-001/page-006.json",
  "sentenceId": "sentence-0015"
}
```

Response:

```json
{
  "ok": true,
  "sentenceId": "sentence-0015",
  "status": "deleted",
  "annotation": {}
}
```

Notes:

- the source annotation file is updated in place
- the server rebuilds chapter artifacts after the mutation, so `read-model.json` and `refine-model.json` stay current

## `POST /api/restore-sentence`

Purpose:

- mark one sentence as `active` in the source annotation file

Request:

```json
{
  "annotationPath": "data/processed/annotations/renjian-bailijin/chapter-001/page-006.json",
  "sentenceId": "sentence-0015"
}
```

Response:

```json
{
  "ok": true,
  "sentenceId": "sentence-0015",
  "status": "active",
  "annotation": {}
}
```

Notes:

- like delete, this rebuilds the persisted chapter models after the mutation

## `POST /api/process-patch`

Purpose:

- run the focused OCR patch pipeline for one saved patch draft

Request:

```json
{
  "series": "renjian-bailijin",
  "chapter": "chapter-001",
  "imagePath": "data/processed/pages/renjian-bailijin/chapter-001/page-006.png",
  "patch": {},
  "patches": []
}
```

Response:

```json
{
  "patch": {},
  "patches": [],
  "ocr": {},
  "analysis": {},
  "reviewPath": "data/review/renjian-bailijin/chapter-001/patches.json",
  "needsReload": true
}
```

Notes:

- the server updates the review sidecar, runs OCR + enrichment, applies the patch, then rebuilds `read-model.json` and `refine-model.json`
- the frontend should refresh chapter data after a successful patch when `needsReload` is true

## Current Reader Behavior

The current reader now prefers:

1. `GET /api/chapters`
2. `GET /api/chapters/:series/:chapter/read`
3. `GET /api/chapters/:series/:chapter/refine`

If the GET API surface is unavailable, it falls back to the legacy manifest + page annotation boot path so the old local workflow keeps working during migration.

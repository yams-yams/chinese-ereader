# OCR Patching Pipeline

This document defines the first review-loop shape for OCR misses that were not detected on the initial page pass.

## Goal

Let the user mark a missing text region in the reader, confirm or edit a semi-automatic transcript, send that text through a structured Codex enrichment request, and merge the result into page annotation JSON without renumbering existing IDs.

## Recommended flow

1. The reader enters review mode on one page.
2. The user draws a polygon for the missing region.
3. The user draws a guide path that follows the text flow.
4. A focused OCR pass runs on the crop.
5. The UI shows the OCR candidate and lets the user edit it.
6. The accepted transcript is saved into `data/review/<series>/<chapter>/patches.json`.
7. `scripts/build_codex_patch_prompt.py` builds a strict JSON payload for local `codex exec`.
8. `scripts/validate_patch_output.py` validates the patch enrichment response.
9. `scripts/apply_annotation_patches.py` merges the enriched patch into the page annotation JSON.

## Why keep a sidecar review file

- Raw OCR output stays recoverable.
- Patches can be re-enriched without redrawing geometry.
- The merge step can be deterministic and repeatable.

## Patch sidecar schema

Each missing region patch should include:

- `patch_id`
- `page_id`
- `kind`
- `region.polygon`
- `text_flow.mode`
- `text_flow.guide`
- `ocr_candidate`
- `user_transcript`
- `anchor.insert_after_sentence_id` or `anchor.insert_before_sentence_id`
- `notes`

`user_transcript` is the authoritative text for enrichment. `ocr_candidate` is only provenance and can help explain uncertainty.

## Geometry strategy

The patch applier uses the user-drawn guide path plus the region polygon to synthesize per-character polygons.

- It samples character centers along the guide path.
- It estimates text thickness from the region envelope.
- It creates oriented rectangles per character.

This is intentionally approximate, but it is better than assigning the same polygon to every synthetic character and does not require renaming old OCR tokens.

## ID strategy

Never renumber existing page annotations.

Patched entities get namespaced IDs:

- `<page_id>-<patch_id>-char-0001`
- `<page_id>-<patch_id>-word-0001`
- `<page_id>-<patch_id>-sentence-0001`

This keeps all prior references stable while still making every new object unique.

## Sentence ordering

The patch sidecar carries an insertion anchor.

- If `insert_before_sentence_id` is present, insert there.
- Else if `insert_after_sentence_id` is present, insert there.
- Else append at the end.

This matters because chapter enrichment and reader behavior both rely on sentence order being meaningful.

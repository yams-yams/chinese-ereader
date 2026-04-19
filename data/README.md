# Data folders

## Raw

Put original browser captures here, grouped by series and chapter.

Example:

- `data/raw/renjian-bailijin/chapter-001/part-001.png`

## Processed

This folder will hold derived assets:

- page-level images
- OCR output
- word and sentence annotations

Derived data should not overwrite the original captures in `data/raw/`.

## Review

Manual OCR review sidecars should live under:

- `data/review/<series-slug>/<chapter-slug>/patches.json`

These review files describe missing regions, guide paths, OCR candidates, accepted transcripts, and insertion anchors before the final merged annotations are written back into `data/processed/annotations/`.

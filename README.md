# ChineseEreader

This project is a personal-use e-reader for reading Chinese manhua with interactive language support.

## MVP goal

Given a chapter capture from Bilibili Manga:

1. Normalize the chapter images into page-level images.
2. Run OCR and sentence/word grouping on each page.
3. Generate pinyin and English helpers.
4. Render the chapter in a custom reader where:
   - hover on a character shows the containing word, pinyin, and English
   - click on a character shows the containing sentence, pinyin, and English

## Project plan

### Phase 1: Ingest chapter captures

- Save the raw chapter screenshots or parts from the browser extension into `data/raw/`.
- Split each long screenshot into page candidates.
- Review and fix page boundaries when needed.

### Phase 2: Build the preprocessing pipeline

- Detect Chinese text regions on each page.
- OCR the text.
- Group OCR tokens into words and sentences.
- Generate:
  - word-level pinyin
  - word-level English glosses
  - sentence-level pinyin
  - sentence-level English translations
- Export page annotations as JSON.

### Phase 3: Build the reader

- Show the whole chapter in one continuous scroll.
- Overlay character hotspots.
- On hover, show word popup.
- On click, show sentence popup.

### Phase 4: Add review tooling

- Correct OCR mistakes.
- Fix word boundaries and sentence grouping.
- Re-export annotations for the reader.

## Data layout

Raw captures should go here first:

- `data/raw/<series-slug>/chapter-001/part-001.png`
- `data/raw/<series-slug>/chapter-001/part-002.png`

Normalized page images will be written here:

- `data/processed/pages/<series-slug>/chapter-001/page-001.png`

Generated annotations will be written here:

- `data/processed/annotations/<series-slug>/chapter-001/page-001.json`

Suggested slug for this title:

- `renjian-bailijin`

## Data durability

Not all data in this repo has the same importance.

Source-of-truth inputs that should be backed up:

- `data/raw/`
  - Manual source captures from Bilibili Manga.
  - If these are lost, the chapter has to be re-captured.

Meaningful intermediate work that should usually be preserved:

- `data/processed/annotations/<series>/<chapter>/page-*.json`
  - OCR output plus accepted patch-applied annotation state.
- `data/review/<series>/<chapter>/patches.json`
  - Saved OCR review/patch drafting data.
- `data/translated/<series>/<chapter>/full-chapter-enrichment.json`
  - Full-chapter Codex enrichment output.

Rebuildable derived artifacts that are safe not to commit:

- `data/processed/chapters/<series>/<chapter>.json`
- `data/processed/annotations/<series>/<chapter>/read-model.json`
- `data/processed/annotations/<series>/<chapter>/refine-model.json`

If the derived artifacts are lost but the annotation, review, and enrichment inputs still exist, rebuild them with:

```bash
.venv/bin/python scripts/build_chapter_artifacts.py --series renjian-bailijin --chapter chapter-001
```

## What to do next

Put the four chapter 1 images here:

- `data/raw/renjian-bailijin/chapter-001/`

Once they are in place, we can build the first preprocessing script around that exact input shape.

## Current local workflow

Create the local Python environment:

```bash
python3 -m venv .venv
```

Install OCR dependencies into the local environment:

```bash
.venv/bin/pip install --upgrade pip setuptools wheel paddlepaddle paddleocr opencv-python-headless openai
```

Process a chapter:

```bash
python3 scripts/process_chapter.py --series renjian-bailijin --chapter chapter-001
```

Process a chapter with the current recommended horizontal trim for the Bilibili captures:

```bash
python3 scripts/process_chapter.py --series renjian-bailijin --chapter chapter-001 --crop-left-ratio 0.26 --crop-right-ratio 0.26
```

That command stitches the raw chapter parts in sorted capture order before split detection. It also keeps a small horizontal safety margin by default (`48px` on each side). You can tune it with `--horizontal-margin-px`.

Compare several split `minGap` values before running OCR:

```bash
python3 scripts/evaluate_split_gaps.py --series renjian-bailijin --chapter chapter-001 --crop-left-ratio 0.26 --crop-right-ratio 0.26 --min-gaps 40 60 80 100 120
```

The sweep writes page images for each candidate under `tmp/split-gap-eval/` and saves a `summary.json` with page-count and height statistics so you can compare oversized vs over-split results quickly. By default it first tries to absorb tiny fragments under `--tiny-fragment-height` using a higher rescue cap (`--tiny-merge-max-height`), then runs a regular recombine pass that merges adjacent short segments when the combined height stays under `--max-segment-height`. Add `--disable-recombine` if you want to inspect split output before either recombine pass runs.

The first PaddleOCR run will also download model files into `tmp/paddlex-cache/`.

Build a prompt bundle for inspection/debugging, including the expected output schema:

```bash
.venv/bin/python scripts/build_codex_full_chapter_prompt.py --series renjian-bailijin --chapter chapter-001 > tmp/codex-full-chapter-prompt.json
```

Run local Codex with the saved command wrapper:

```bash
.venv/bin/python scripts/run_full_chapter_enrichment.py --series renjian-bailijin --chapter chapter-001
```

The runner writes the deterministic chapter output to:

- `data/translated/<series>/<chapter>/full-chapter-enrichment.json`

And appends structured run logs to:

- `data/translated/logs/full-chapter-enrichment-runs.jsonl`

During long runs, the runner also streams and persists live Codex event JSONL plus stderr logs under:

- `tmp/<series>/<chapter>/<timestamp>-codex-events.jsonl`
- `tmp/<series>/<chapter>/<timestamp>-codex-stderr.log`

Validate a saved local Codex JSON response against the chapter schema:

```bash
.venv/bin/python scripts/validate_full_chapter_output.py --input data/translated/renjian-bailijin/chapter-001/full-chapter-enrichment.json
```

Build a prompt bundle for manually patched OCR misses:

```bash
.venv/bin/python scripts/build_codex_patch_prompt.py --series renjian-bailijin --chapter chapter-001 --patches data/review/renjian-bailijin/chapter-001/patches.json > tmp/codex-ocr-patches-prompt.json
```

Validate a local Codex patch JSON response:

```bash
.venv/bin/python scripts/validate_patch_output.py --input tmp/codex-ocr-patches-output.json
```

Merge accepted patch enrichments into the page annotations:

```bash
.venv/bin/python scripts/apply_annotation_patches.py --series renjian-bailijin --chapter chapter-001 --patches data/review/renjian-bailijin/chapter-001/patches.json --enrichment tmp/codex-ocr-patches-output.json
```

The archived OpenAI probe scripts are kept locally under `scripts/archive/` for reference, but the active workflow now goes through the logged full-chapter runner and local `codex exec`.

Print the expected JSON schema by itself:

```bash
.venv/bin/python scripts/validate_full_chapter_output.py --schema
```

Serve the reader locally:

```bash
.venv/bin/python scripts/serve_reader.py
```

Then open:

- `http://localhost:8000/reader/`

## Current status

- Chapter 1 raw captures are split into page-level images.
- Horizontal trimming is supported as a preprocessing option for removing side gutters and reader UI artifacts.
- A chapter manifest is generated for the reader.
- The reader can navigate processed pages now.
- The reader now renders a chapter as one continuous scroll surface.
- The OCR stage now runs through PaddleOCR with the PP-OCRv5 mobile models, which gives better Chinese text detection and per-character regions than the previous Tesseract path.
- The reader now supports polygon-aligned OCR overlays plus an optional debug overlay for inspecting OCR geometry.
- The next step is replacing placeholder language helpers with an OpenAI-based enrichment pass that returns structured sentence and word analysis.

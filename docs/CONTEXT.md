# Project Context

This repo is a personal-use Chinese manhua e-reader for language learning.

The target UX is:

- Show a chapter as a continuous vertical reading surface.
- Default display is the original Chinese page art.
- Hover on a character to show the containing word, its pinyin, and an English gloss.
- Click on a character to show the containing sentence, its pinyin, and an English translation.

## Current title and source

- Current title: `renjian-bailijin`
- Current source workflow: capture chapters manually from Bilibili Manga using a browser full-page screenshot extension.
- Current known-good test chapter: `chapter-001`

The user is okay tailoring the MVP to this title first instead of solving general comic OCR.

## Important product decisions

- The reader is a web app and should stay cross-platform.
- Preprocessing can be local/offline tooling.
- We moved away from page-flip UX. The reader now renders the full chapter as one continuous scroll.
- We moved away from Tesseract OCR. PaddleOCR is the current OCR backend.
- We are leaning toward LLM-based language enrichment instead of local segmentation / dictionary / translation libraries.

## Current status

What is working:

- Raw Bilibili captures can be stored under `data/raw/<series>/<chapter>/`.
- Preprocessing splits the long captures into page-level images.
- Horizontal trimming is supported and materially improves OCR/splitting.
- OCR runs with PaddleOCR and produces character/word/sentence geometry.
- The reader renders the chapter in one continuous scroll.
- OCR overlays are polygon-aligned and currently look good on chapter 1.
- There is a debug overlay mode for OCR polygons in the reader.

What is not complete yet:

- Final hover/click learner popups are not fully wired to language enrichment.
- Full review/correction tooling does not exist yet.
- The enrichment pipeline is still in experiment mode.
- Some non-story author/promo text from end pages is still present in OCR/enrichment outputs.

## Key repo areas

- `reader/`
  - `index.html`, `app.js`, `styles.css`
  - Continuous-scroll web reader
  - Renders OCR overlays and debug polygons

- `scripts/process_chapter.py`
  - Main preprocessing entrypoint
  - Handles chapter processing and crop settings

- `scripts/split_chapter.swift`
  - Splits tall raw captures into page-level images
  - Also applies horizontal trimming before split logic

- `scripts/ocr_pages.py`
  - Current PaddleOCR pipeline

- `scripts/chapter_enrichment_prompt.py`
  - Shared full-chapter prompt/payload builder for local `codex exec`

- `scripts/enrichment_schema.py`
  - Shared Pydantic schemas for structured enrichment outputs

- `scripts/build_codex_full_chapter_prompt.py`
  - Builds prompt payloads for local `codex exec`

- `scripts/validate_full_chapter_output.py`
  - Validates structured chapter output and can print the JSON schema

## Data layout

- Raw captures:
  - `data/raw/renjian-bailijin/chapter-001/`

- Processed pages:
  - `data/processed/pages/renjian-bailijin/chapter-001/`

- OCR annotations:
  - `data/processed/annotations/renjian-bailijin/chapter-001/`

- Existing translated/output experiments:
  - `data/translated/`
  - `tmp/`

Treat `data/raw/` as source-of-truth input and do not overwrite it.

## Current preprocessing assumptions

- The user captures a few tall stitched screenshots per chapter from Bilibili.
- For chapter 1, fixed horizontal trim ratios worked well:
  - `--crop-left-ratio 0.26`
  - `--crop-right-ratio 0.26`
- A default horizontal safety margin is also applied.
- Variable page lengths are fine because the reader no longer depends on page-flip boundaries.

## Reader behavior

- The reader is no longer "one page at a time."
- The chapter is rendered as a single scrollable document.
- OCR overlays are positioned from normalized polygon coordinates saved in annotation JSON.
- Alignment quality improved after:
  - preserving polygon geometry
  - storing image dimensions
  - avoiding OCR-space / render-space drift

## OCR notes

- PaddleOCR outperformed Tesseract for this project.
- OCR alignment is currently good enough to build on.
- Some text is still missed, especially unusual side text, dense bubble text, or decorative text.
- Those misses are expected to be handled later via review/correction tooling rather than by overfitting OCR heuristics now.

## Enrichment strategy

The team explored two enrichment approaches:

1. Chunk-based enrichment
- Send 3-5 neighboring sentences or a likely dialogue box, whichever is smaller.
- This worked well during experimentation.

2. Full-chapter enrichment
- Send a chapter-wide request for stronger global context.
- This can work, but local `codex exec` is much slower and may appear stuck for large chapter-wide jobs.

Current practical recommendation:

- Keep the active local workflow centered on `codex exec` prompt generation plus schema validation.
- Optionally revisit chunking or a chapter-level context/glossary pass later for better consistency.

## Model findings

The project compared several models on chapter-1 enrichment samples.

Observed quality ranking:

1. `gpt-5.4`
2. `gpt-5.4-mini`
3. `gpt-5.1`
4. `gpt-5-mini`

Important quality notes:

- `gpt-5.4` was best overall for word grouping, translation, and contextual interpretation.
- `gpt-5.4-mini` looked strong enough to be a serious cost-saving fallback.
- Normalization should stay conservative.
- The user specifically cares about preserving real surface forms unless OCR error is obvious.

Example of an important nuance:

- `天呐` should not be silently normalized to `天哪` unless there is strong evidence it is an OCR mistake.

## Local Codex findings

- `codex exec` with `--output-schema` requires strict JSON Schema:
  - `additionalProperties: false`
  - every property must appear in `required`
- Full-chapter `codex exec` runs may look stalled for several minutes.

The current schema helper in `scripts/enrichment_schema.py` exists mainly to satisfy those strict structured-output constraints.

## Known open issues

From GitHub at the time this file was written:

- `#1` Build the Chinese language enrichment pipeline
- `#2` Add a review step for page splitting and OCR corrections
- `#3` Implement interactive word hover and sentence click in the reader
- `#4` Document the ingestion and local development workflow
- `#5` Support chapter manifests and chapter-level browsing in the web app
- `#7` Trim horizontal gutters and reader UI artifacts before OCR

Closed:

- `#6` Replace the current OCR stub with a Python OCR pipeline
- `#8` Render each chapter as a continuous scroll surface

Important nuance:

- `#7` is still open in GitHub, but some of its functionality is already implemented locally in preprocessing.
- Before closing or splitting it further, verify what remains versus what is already working.

## Known rough edges

- Old OpenAI probe scripts can live under `scripts/archive/` if they are still useful for reference, but they are not part of the active workflow.
- End-matter / promo pages are still present in some enrichment outputs.
- Some OCR sentence boundaries split phrases across adjacent bubbles or lines.
- Punctuation is still sometimes emitted as standalone `words[]` items.

## Useful commands

Create venv:

```bash
python3 -m venv .venv
```

Install Python deps:

```bash
.venv/bin/pip install --upgrade pip setuptools wheel paddlepaddle paddleocr opencv-python-headless openai
```

Process chapter 1 with known-good crop settings:

```bash
python3 scripts/process_chapter.py --series renjian-bailijin --chapter chapter-001 --crop-left-ratio 0.26 --crop-right-ratio 0.26
```

Run local reader:

```bash
python3 -m http.server 8000
```

Build the local Codex prompt bundle:

```bash
.venv/bin/python scripts/build_codex_full_chapter_prompt.py --series renjian-bailijin --chapter chapter-001 > tmp/codex-full-chapter-prompt.json
```

Run the saved local Codex command:

```bash
./codex-full-chapter-command.sh
```

Validate the saved JSON output:

```bash
.venv/bin/python scripts/validate_full_chapter_output.py --input data/translated/chapter1.json
```

## Working style guidance for future agents

- Do not re-litigate the page-flip UX; continuous scroll is the current direction.
- Do not switch away from PaddleOCR without strong evidence.
- Prefer conservative normalization over "cleaned up" rewrite.
- Treat chunk-based enrichment as the safest current implementation path.
- Preserve alignment fidelity; coordinate mismatches were a major issue and are now mostly solved.
- Be careful not to overwrite user-provided raw captures.
- If changing enrichment schema, consider both:
  - OpenAI Responses API structured outputs
  - local `codex exec --output-schema` strict schema requirements

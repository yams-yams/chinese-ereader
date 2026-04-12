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

- Save the stitched chapter screenshots from the browser extension into `data/raw/`.
- Split each long screenshot into page candidates.
- Review and fix page boundaries when needed.

### Phase 2: Build the preprocessing pipeline

- Detect Chinese text regions on each page.
- OCR the text.
- Group characters into words and sentences.
- Generate:
  - word-level pinyin
  - word-level English glosses
  - sentence-level pinyin
  - sentence-level English translations
- Export page annotations as JSON.

### Phase 3: Build the reader

- Show one page at a time with next/previous navigation.
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

## What to do next

Put the four chapter 1 images here:

- `data/raw/renjian-bailijin/chapter-001/`

Once they are in place, we can build the first preprocessing script around that exact input shape.

## Current local workflow

Process a chapter:

```bash
python3 scripts/process_chapter.py --series renjian-bailijin --chapter chapter-001
```

Process a chapter with the current recommended horizontal trim for the Bilibili captures:

```bash
python3 scripts/process_chapter.py --series renjian-bailijin --chapter chapter-001 --crop-left-ratio 0.26 --crop-right-ratio 0.26
```

Serve the reader locally:

```bash
python3 -m http.server 8000
```

Then open:

- `http://localhost:8000/reader/`

## Current status

- Chapter 1 raw captures are split into page-level images.
- Horizontal trimming is supported as a preprocessing option for removing side gutters and reader UI artifacts.
- A chapter manifest is generated for the reader.
- The reader can navigate processed pages now.
- OCR scaffolding is in place, but the built-in macOS Vision OCR path is currently failing in this environment, so annotation files are placeholders for the moment.

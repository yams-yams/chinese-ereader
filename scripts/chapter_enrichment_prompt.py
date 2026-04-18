#!/usr/bin/env python3

from __future__ import annotations

import json
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
ANNOTATIONS_ROOT = ROOT / "data" / "processed" / "annotations"

DEVELOPER_PROMPT = """You enrich OCR'd Chinese manhua text for a language-learning reader.

Return learner-friendly structured analysis for one full chapter.

Rules:
- Use the full chapter context to interpret each sentence holistically.
- Return one sentence analysis for every input sentence, in the same order.
- Each sentence analysis must stay anchored to that sentence's OCR token ids.
- Correct only obvious OCR mistakes. Do not silently normalize colloquial, stylistic, or character-voice variants unless the OCR error is very likely.
- In particular, preserve variants like 天呐, 啥, 咋, 玩意儿, 那儿 when they appear intentional.
- normalized_text may differ from ocr_text only when the correction is very likely.
- Segment each sentence into learner-friendly words or short chunks.
- Prefer established Chinese words over single-character splits when the combined form is a common lexical item.
- Every OCR token id from each sentence must appear exactly once across that sentence's words. Preserve token order.
- surface_text must equal the concatenation of the mapped OCR token texts for that word.
- normalized_text for a word can fix an OCR mistake, but keep it close to the observed text.
- Use Hanyu Pinyin with tone marks.
- sentence_translation should be natural English, concise, and faithful.
- word translation should be a short gloss appropriate for a learner, not a full sentence.
- grammar_notes should be short and only mention useful learner-facing grammar or usage details.
- notes should be short and only mention meaningful OCR uncertainty or ambiguity.
- Do not invent story details that are not supported by the OCR text and chapter context.
- Some OCR lines may be credits, title cards, SFX, promo text, or end-matter. Still analyze each input sentence and use notes or grammar_notes briefly when that context matters.
"""


def iter_annotation_paths(series: str, chapter: str) -> list[Path]:
    root = ANNOTATIONS_ROOT / series / chapter
    return sorted(root.glob("page-*.json"))


def load_annotation(path: Path) -> dict:
    return json.loads(path.read_text())


def build_chapter_payload(series: str, chapter: str) -> dict:
    sentences = []
    for annotation_path in iter_annotation_paths(series, chapter):
        annotation = load_annotation(annotation_path)
        page_id = annotation_path.stem
        characters_by_id = {
            character["id"]: character for character in annotation.get("characters", [])
        }

        for sentence in annotation.get("sentences", []):
            text = sentence.get("text", "").strip()
            token_ids = sentence.get("characterIds", [])
            if not text or not token_ids:
                continue

            sentences.append(
                {
                    "page_id": page_id,
                    "sentence_id": sentence["id"],
                    "ocr_text": text,
                    "ocr_tokens": [
                        {
                            "id": token_id,
                            "text": characters_by_id.get(token_id, {}).get("text", ""),
                        }
                        for token_id in token_ids
                    ],
                }
            )

    return {
        "task": "Analyze one full chapter of OCRd Chinese manhua for a language-learning reader.",
        "chapter": {
            "series": series,
            "chapter": chapter,
            "sentences": sentences,
        },
        "requirements": {
            "analyze_every_sentence": "Return analysis for every sentence in order.",
            "word_mapping": "Every OCR token id in each sentence must be used exactly once across that sentence's words.",
            "conservative_correction": "Only fix obvious OCR mistakes. Preserve intentional colloquial variants.",
            "reader_goal": "Hover uses words; click uses the full sentence.",
        },
    }

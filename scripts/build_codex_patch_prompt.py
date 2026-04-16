#!/usr/bin/env python3

from __future__ import annotations

import argparse
import json
import math
from pathlib import Path

from ocr_patch_schema import (
    MissingRegionPatch,
    PatchEnrichmentResponse,
    PatchPromptInput,
    PatchReviewFile,
)
from enrichment_schema import strict_json_schema
from chapter_enrichment_prompt import ANNOTATIONS_ROOT


DEVELOPER_PROMPT = """You enrich manually patched Chinese manhua text for a language-learning reader.

Return learner-friendly structured analysis for every patch.

Rules:
- Treat user_transcript/source_text as the authoritative text for the missing region.
- Use ocr_candidate only as weak supporting evidence when it helps explain uncertainty.
- Respect nearby dialogue context from neighbor_sentences, but do not rewrite the patch into different story content.
- Correct only obvious character mistakes. Preserve colloquial or stylized wording unless the error is very likely.
- Segment each patch into learner-friendly words or short chunks.
- surface_text should stay faithful to the accepted patch transcript.
- normalized_text can fix obvious OCR or punctuation mistakes, but stay conservative.
- Use Hanyu Pinyin with tone marks.
- sentence_translation should be concise, natural, and faithful.
- word translation should be a short learner gloss.
- grammar_notes and notes should stay short.
- Return one analysis object per input patch, in the same order.
"""


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Build a local-Codex prompt for OCR patch enrichment.")
    parser.add_argument("--series", required=True)
    parser.add_argument("--chapter", required=True)
    parser.add_argument(
        "--patches",
        help="Path to the patch review file. Defaults to data/review/<series>/<chapter>/patches.json.",
    )
    return parser.parse_args()


def annotation_path(series: str, chapter: str, page_id: str) -> Path:
    return ANNOTATIONS_ROOT / series / chapter / f"{page_id}.json"


def load_json(path: Path) -> dict:
    return json.loads(path.read_text())


def compact_text(text: str) -> str:
    return "".join(character for character in text if not character.isspace())


def polygon_center(points: list[dict[str, float]]) -> tuple[float, float] | None:
    if not points:
        return None
    return (
        sum(point.get("x", 0.0) for point in points) / len(points),
        sum(point.get("y", 0.0) for point in points) / len(points),
    )


def distance(a: tuple[float, float], b: tuple[float, float]) -> float:
    return math.hypot(a[0] - b[0], a[1] - b[1])


def infer_anchor_index_from_geometry(
    patch: MissingRegionPatch,
    sentences: list[dict],
) -> int | None:
    patch_center = polygon_center([point.model_dump(mode="json") for point in patch.region.polygon])
    if patch_center is None:
        return None

    best_index = None
    best_distance = None
    for index, sentence in enumerate(sentences):
        sentence_center = polygon_center(sentence.get("polygon", []))
        if sentence_center is None:
            continue
        candidate_distance = distance(patch_center, sentence_center)
        if best_distance is None or candidate_distance < best_distance:
            best_distance = candidate_distance
            best_index = index

    return best_index


def build_neighbor_sentences(
    patch: MissingRegionPatch,
    annotation: dict,
) -> list[dict[str, str]]:
    sentences = [
        sentence
        for sentence in annotation.get("sentences", [])
        if sentence.get("source", {}).get("type") != "patch"
    ]
    if not sentences:
        return []

    index_by_id = {
        sentence.get("id"): index for index, sentence in enumerate(sentences) if sentence.get("id")
    }

    anchor_index = None
    if patch.anchor.insert_after_sentence_id:
        anchor_index = index_by_id.get(patch.anchor.insert_after_sentence_id)
    elif patch.anchor.insert_before_sentence_id:
        before_index = index_by_id.get(patch.anchor.insert_before_sentence_id)
        if before_index is not None:
            anchor_index = max(0, before_index - 1)

    if anchor_index is None:
        anchor_index = infer_anchor_index_from_geometry(patch, sentences)

    if anchor_index is None:
        return []

    window_start = max(0, anchor_index - 1)
    window_end = min(len(sentences), anchor_index + 2)
    neighbors = []
    for sentence in sentences[window_start:window_end]:
        text = sentence.get("text", "").strip()
        sentence_id = sentence.get("id")
        if not text or not sentence_id:
            continue
        neighbors.append({"sentence_id": sentence_id, "text": text})
    return neighbors


def default_patch_path(series: str, chapter: str) -> Path:
    return Path("data") / "review" / series / chapter / "patches.json"


def main() -> None:
    args = parse_args()
    patch_path = Path(args.patches) if args.patches else default_patch_path(args.series, args.chapter)
    review = PatchReviewFile.model_validate(load_json(patch_path))

    patch_inputs: list[PatchPromptInput] = []
    for patch in review.patches:
        annotation = load_json(annotation_path(args.series, args.chapter, patch.page_id))
        patch_inputs.append(
            PatchPromptInput(
                patch_id=patch.patch_id,
                page_id=patch.page_id,
                source_text=patch.user_transcript,
                ocr_candidate=compact_text(patch.ocr_candidate),
                reading_direction=patch.text_flow.mode,
                neighbor_sentences=build_neighbor_sentences(patch, annotation),
                notes=patch.notes,
            )
        )

    prompt = {
        "instructions": DEVELOPER_PROMPT
        + "\nBefore finalizing, verify that your output is valid JSON matching the provided schema exactly. Return only the JSON object and no commentary.",
        "output_schema": strict_json_schema(PatchEnrichmentResponse),
        "input_payload": {
            "task": "Analyze manually patched OCR misses for the reader.",
            "chapter": {
                "series": review.series,
                "chapter": review.chapter,
            },
            "patches": [patch.model_dump(mode="json") for patch in patch_inputs],
        },
    }

    print(json.dumps(prompt, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()

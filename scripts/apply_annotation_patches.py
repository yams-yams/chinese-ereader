#!/usr/bin/env python3

from __future__ import annotations

import argparse
import json
import math
from pathlib import Path

from ocr_patch_schema import MissingRegionPatch, PatchEnrichmentResponse, PatchReviewFile, Point


ROOT = Path(__file__).resolve().parents[1]
ANNOTATIONS_ROOT = ROOT / "data" / "processed" / "annotations"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Apply OCR patch enrichments into page annotation JSON.")
    parser.add_argument("--series", required=True)
    parser.add_argument("--chapter", required=True)
    parser.add_argument("--patches", required=True, help="Path to the patch review JSON file.")
    parser.add_argument("--enrichment", required=True, help="Path to the patch enrichment JSON file.")
    parser.add_argument(
        "--output-root",
        default=str(ANNOTATIONS_ROOT),
        help="Root directory for annotation JSON output.",
    )
    return parser.parse_args()


def load_json(path: Path) -> dict:
    return json.loads(path.read_text())


def compact_text(text: str) -> str:
    return "".join(character for character in text if not character.isspace())


def annotation_path(output_root: Path, series: str, chapter: str, page_id: str) -> Path:
    return output_root / series / chapter / f"{page_id}.json"


def subtract(a: tuple[float, float], b: tuple[float, float]) -> tuple[float, float]:
    return (a[0] - b[0], a[1] - b[1])


def add(a: tuple[float, float], b: tuple[float, float]) -> tuple[float, float]:
    return (a[0] + b[0], a[1] + b[1])


def scale(vector: tuple[float, float], factor: float) -> tuple[float, float]:
    return (vector[0] * factor, vector[1] * factor)


def length(vector: tuple[float, float]) -> float:
    return math.hypot(vector[0], vector[1])


def normalize(vector: tuple[float, float], fallback: tuple[float, float]) -> tuple[float, float]:
    vector_length = length(vector)
    if vector_length < 1e-6:
        return fallback
    return (vector[0] / vector_length, vector[1] / vector_length)


def point_to_tuple(point: Point) -> tuple[float, float]:
    return (point.x, point.y)


def clamp_point(point: tuple[float, float]) -> dict[str, float]:
    return {
        "x": min(max(point[0], 0.0), 1.0),
        "y": min(max(point[1], 0.0), 1.0),
    }


def polyline_lengths(points: list[tuple[float, float]]) -> tuple[list[float], float]:
    cumulative = [0.0]
    total = 0.0
    for start, end in zip(points, points[1:]):
        total += length(subtract(end, start))
        cumulative.append(total)
    return cumulative, total


def sample_along_polyline(points: list[tuple[float, float]], distance: float) -> tuple[float, float]:
    cumulative, total = polyline_lengths(points)
    if total < 1e-6:
        return points[0]
    target = min(max(distance, 0.0), total)
    for index in range(1, len(points)):
        if cumulative[index] < target:
            continue
        start = points[index - 1]
        end = points[index]
        segment_length = cumulative[index] - cumulative[index - 1]
        if segment_length < 1e-6:
            return start
        ratio = (target - cumulative[index - 1]) / segment_length
        return (
            start[0] + (end[0] - start[0]) * ratio,
            start[1] + (end[1] - start[1]) * ratio,
        )
    return points[-1]


def tangent_at_fraction(points: list[tuple[float, float]], fraction: float) -> tuple[float, float]:
    cumulative, total = polyline_lengths(points)
    if total < 1e-6:
        return (0.0, -1.0)
    target = min(max(fraction, 0.0), 1.0) * total
    for index in range(1, len(points)):
        if cumulative[index] < target:
            continue
        return normalize(subtract(points[index], points[index - 1]), (0.0, -1.0))
    return normalize(subtract(points[-1], points[-2]), (0.0, -1.0))


def region_thickness(polygon: list[Point], flow_mode: str) -> float:
    xs = [point.x for point in polygon]
    ys = [point.y for point in polygon]
    width = max(xs) - min(xs) if xs else 0.05
    height = max(ys) - min(ys) if ys else 0.05
    # Use the smaller region axis as the text thickness. This keeps patched
    # character geometry close to the user-drawn OCR region instead of
    # exploding when a shallow region is marked with a vertical flow mode.
    return max(min(width, height) * 0.8, 0.002)


def build_character_polygons(patch: MissingRegionPatch, text: str) -> list[dict[str, object]]:
    characters = [character for character in text if not character.isspace()]
    if not characters:
        return []

    guide = [point_to_tuple(point) for point in patch.text_flow.guide]
    if len(guide) < 2:
        guide = [point_to_tuple(point) for point in patch.region.polygon[:2]]
    if len(guide) < 2:
        guide = [(0.5, 0.75), (0.5, 0.25)]

    _, total_length = polyline_lengths(guide)
    total_length = max(total_length, 0.001)
    tangent_fallback = (0.0, -1.0) if patch.text_flow.mode.startswith("vertical") else (1.0, 0.0)
    thickness = region_thickness(patch.region.polygon, patch.text_flow.mode)
    char_span = max(total_length / len(characters), 0.012)

    polygons = []
    for index, character in enumerate(characters):
        center_distance = total_length * ((index + 0.5) / len(characters))
        center = sample_along_polyline(guide, center_distance)
        tangent = tangent_at_fraction(guide, (index + 0.5) / len(characters))
        tangent = normalize(tangent, tangent_fallback)
        normal = (-tangent[1], tangent[0])
        half_tangent = char_span * 0.45
        half_normal = thickness * 0.5

        corners = [
            add(add(center, scale(tangent, -half_tangent)), scale(normal, half_normal)),
            add(add(center, scale(tangent, half_tangent)), scale(normal, half_normal)),
            add(add(center, scale(tangent, half_tangent)), scale(normal, -half_normal)),
            add(add(center, scale(tangent, -half_tangent)), scale(normal, -half_normal)),
        ]
        polygons.append(
            {
                "text": character,
                "polygon": [clamp_point(point) for point in corners],
            }
        )

    return polygons


def polygon_bounds(polygon: list[dict[str, float]]) -> dict[str, float]:
    xs = [point["x"] for point in polygon]
    ys = [point["y"] for point in polygon]
    min_x = min(xs)
    max_x = max(xs)
    min_y = min(ys)
    max_y = max(ys)
    return {
        "x": min_x,
        "y": min_y,
        "width": max(max_x - min_x, 0.0001),
        "height": max(max_y - min_y, 0.0001),
    }


def build_word_character_ids(words: list[dict], characters: list[dict]) -> list[list[str]]:
    compact_characters = [character["text"] for character in characters]
    joined = "".join(compact_characters)
    cursor = 0
    groups: list[list[str]] = []

    for word in words:
        surface = compact_text(word["surface_text"])
        if not surface:
            groups.append([])
            continue

        expected = joined[cursor : cursor + len(surface)]
        if expected != surface:
            raise ValueError(
                f"Word segmentation for patch text drifted. Expected '{expected}' but got '{surface}'."
            )
        ids = [character["id"] for character in characters[cursor : cursor + len(surface)]]
        groups.append(ids)
        cursor += len(surface)

    if cursor != len(characters):
        raise ValueError("Patch word segmentation did not consume the full accepted transcript.")

    return groups


def insert_sentence(annotation: dict, sentence: dict, anchor: MissingRegionPatch) -> None:
    sentences = annotation.setdefault("sentences", [])
    if anchor.anchor.insert_before_sentence_id:
        target = anchor.anchor.insert_before_sentence_id
        for index, existing in enumerate(sentences):
            if existing.get("id") == target:
                sentences.insert(index, sentence)
                return
    if anchor.anchor.insert_after_sentence_id:
        target = anchor.anchor.insert_after_sentence_id
        for index, existing in enumerate(sentences):
            if existing.get("id") == target:
                sentences.insert(index + 1, sentence)
                return
    sentences.append(sentence)


def main() -> None:
    args = parse_args()
    output_root = Path(args.output_root)
    review = PatchReviewFile.model_validate(load_json(Path(args.patches)))
    enrichment = PatchEnrichmentResponse.model_validate(load_json(Path(args.enrichment)))

    patches_by_id = {patch.patch_id: patch for patch in review.patches}
    analyses_by_page: dict[str, list[tuple[MissingRegionPatch, object]]] = {}
    for analysis in enrichment.patch_analyses:
        patch = patches_by_id.get(analysis.patch_id)
        if not patch:
            continue
        analyses_by_page.setdefault(analysis.page_id, []).append((patch, analysis))

    for page_id, page_analyses in analyses_by_page.items():
        path = annotation_path(output_root, args.series, args.chapter, page_id)
        annotation = load_json(path)
        annotation.setdefault("characters", [])
        annotation.setdefault("words", [])
        annotation.setdefault("sentences", [])

        for patch, analysis in page_analyses:
            character_geometry = build_character_polygons(patch, analysis.original_text)
            patch_prefix = f"{page_id}-{patch.patch_id}"

            new_characters = []
            for index, geometry in enumerate(character_geometry, start=1):
                character_id = f"{patch_prefix}-char-{index:04d}"
                new_characters.append(
                    {
                        "id": character_id,
                        "text": geometry["text"],
                        "box": polygon_bounds(geometry["polygon"]),
                        "polygon": geometry["polygon"],
                    }
                )

            word_character_ids = build_word_character_ids(
                [word.model_dump(mode="json") for word in analysis.words],
                new_characters,
            )

            sentence_id = f"{patch_prefix}-sentence-0001"
            for character in new_characters:
                character["sentenceId"] = sentence_id

            new_words = []
            for index, (word, character_ids) in enumerate(zip(analysis.words, word_character_ids), start=1):
                word_id = f"{patch_prefix}-word-{index:04d}"
                new_words.append(
                    {
                        "id": word_id,
                        "text": word.surface_text,
                        "pinyin": word.pinyin,
                        "translation": word.translation,
                        "normalizedText": word.normalized_text,
                        "confidence": word.confidence,
                        "characterIds": character_ids,
                    }
                )
                for character_id in character_ids:
                    for character in new_characters:
                        if character["id"] == character_id:
                            character["wordId"] = word_id
                            break

            for character in new_characters:
                character.setdefault("wordId", f"{patch_prefix}-word-0000")

            sentence = {
                "id": sentence_id,
                "status": "active",
                "text": analysis.normalized_text or analysis.original_text,
                "pinyin": analysis.sentence_pinyin,
                "translation": analysis.sentence_translation,
                "grammarNotes": analysis.grammar_notes,
                "notes": analysis.notes,
                "ocrText": analysis.original_text,
                "characterIds": [character["id"] for character in new_characters],
                "polygon": [point.model_dump(mode="json") for point in patch.region.polygon],
                "source": {
                    "type": "patch",
                    "patchId": patch.patch_id,
                },
            }

            annotation["characters"].extend(new_characters)
            annotation["words"].extend(new_words)
            insert_sentence(annotation, sentence, patch)

        path.write_text(json.dumps(annotation, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()

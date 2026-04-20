#!/usr/bin/env python3

from __future__ import annotations

import argparse
import json
import re
from pathlib import Path
from typing import Any

from chapter_artifact_models import (
    ChapterManifest,
    ChapterSegment,
    ImageSize,
    LegacyManifestPage,
    ReadCharacter,
    ReadModel,
    ReadSentence,
    ReadWord,
    RefineCharacter,
    RefineModel,
    RefinePatch,
    RefineSentence,
    RefineWord,
    SegmentArtifact,
    SentenceSource,
)
from enrichment_schema import ChapterEnrichment
from ocr_patch_schema import PatchReviewFile


ROOT = Path(__file__).resolve().parents[1]
CHAPTERS_ROOT = ROOT / "data" / "processed" / "chapters"
ANNOTATIONS_ROOT = ROOT / "data" / "processed" / "annotations"
TRANSLATED_ROOT = ROOT / "data" / "translated"
REVIEW_ROOT = ROOT / "data" / "review"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Build migration-safe chapter manifest/read/refine artifacts for one chapter."
    )
    parser.add_argument("--series", required=True)
    parser.add_argument("--chapter", required=True)
    parser.add_argument(
        "--enrichment",
        default=None,
        help="Optional explicit path to the full-chapter enrichment JSON. Defaults to the legacy translated path.",
    )
    parser.add_argument(
        "--skip-read-model",
        action="store_true",
        help="Skip building read-model.json even if enrichment data exists.",
    )
    return parser.parse_args()


def load_json(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def write_json(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def chapter_title(series: str, chapter: str) -> str:
    return f"{series} / {chapter}"


def segment_id_for_page_id(page_id: str) -> str:
    suffix = page_id.removeprefix("page-")
    return f"segment-{suffix}"


def default_enrichment_path(chapter: str) -> Path | None:
    match = re.fullmatch(r"chapter-(\d+)", chapter)
    if not match:
        return None
    return TRANSLATED_ROOT / f"chapter{int(match.group(1))}.json"


def manifest_path(series: str, chapter: str) -> Path:
    return CHAPTERS_ROOT / series / f"{chapter}.json"


def chapter_annotations_dir(series: str, chapter: str) -> Path:
    return ANNOTATIONS_ROOT / series / chapter


def review_path(series: str, chapter: str) -> Path:
    return REVIEW_ROOT / series / chapter / "patches.json"


def build_manifest(series: str, chapter: str, pages: list[dict[str, str]]) -> ChapterManifest:
    segments = [
        ChapterSegment(
            id=segment_id_for_page_id(page["id"]),
            image=page["image"],
            annotation=page["annotation"],
            sourcePageId=page["id"],
        )
        for page in pages
    ]
    legacy_pages = [LegacyManifestPage.model_validate(page) for page in pages]
    return ChapterManifest(
        series=series,
        chapter=chapter,
        title=chapter_title(series, chapter),
        segmentCount=len(segments),
        segments=segments,
        pageCount=len(legacy_pages),
        pages=legacy_pages,
    )


def load_pages_from_existing_manifest(path: Path) -> list[dict[str, str]]:
    raw = load_json(path)
    pages = raw.get("pages") or []
    return [dict(page) for page in pages]


def load_annotations_for_manifest(manifest: ChapterManifest) -> dict[str, dict[str, Any]]:
    annotations: dict[str, dict[str, Any]] = {}
    for segment in manifest.segments:
        annotation_path = ROOT / segment.annotation
        annotations[segment.id] = load_json(annotation_path)
    return annotations


def load_enrichment(path: Path | None) -> ChapterEnrichment | None:
    if path is None or not path.is_file():
        return None
    return ChapterEnrichment.model_validate(load_json(path))


def load_patches(series: str, chapter: str) -> PatchReviewFile | None:
    path = review_path(series, chapter)
    if not path.is_file():
        return None
    return PatchReviewFile.model_validate(load_json(path))


def analysis_by_sentence(enrichment: ChapterEnrichment | None) -> dict[tuple[str, str], Any]:
    if enrichment is None:
        return {}
    return {
        (analysis.page_id, analysis.sentence_id): analysis for analysis in enrichment.sentence_analyses
    }


def to_image_size(raw_size: dict[str, Any]) -> ImageSize:
    return ImageSize(width=int(raw_size["width"]), height=int(raw_size["height"]))


def build_segments(manifest: ChapterManifest, annotations: dict[str, dict[str, Any]]) -> list[SegmentArtifact]:
    built_segments: list[SegmentArtifact] = []
    for segment in manifest.segments:
        annotation = annotations[segment.id]
        built_segments.append(
            SegmentArtifact(
                id=segment.id,
                image=segment.image,
                imageSize=to_image_size(annotation["imageSize"]),
                sourcePageId=segment.sourcePageId,
            )
        )
    return built_segments


def collect_read_entities(
    manifest: ChapterManifest,
    annotations: dict[str, dict[str, Any]],
    enrichment: ChapterEnrichment | None,
) -> tuple[list[ReadSentence], list[ReadWord], list[ReadCharacter], list[str]]:
    analyses = analysis_by_sentence(enrichment)
    read_sentences: list[ReadSentence] = []
    read_words: list[ReadWord] = []
    read_characters: list[ReadCharacter] = []
    chapter_notes = list(enrichment.chapter_notes) if enrichment else []

    for segment in manifest.segments:
        annotation = annotations[segment.id]
        source_page_id = segment.sourcePageId

        for character in annotation.get("characters", []):
            read_characters.append(
                ReadCharacter(
                    id=character["id"],
                    segmentId=segment.id,
                    wordId=character.get("wordId"),
                    sentenceId=character.get("sentenceId"),
                    text=character.get("text", ""),
                    polygon=character.get("polygon", []),
                )
            )

        for sentence in annotation.get("sentences", []):
            analysis = analyses.get((source_page_id, sentence["id"]))
            read_sentences.append(
                ReadSentence(
                    id=sentence["id"],
                    segmentId=segment.id,
                    status="active",
                    text=(analysis.normalized_text if analysis else sentence.get("text")) or "",
                    pinyin=(analysis.sentence_pinyin if analysis else sentence.get("pinyin")) or "",
                    translation=(analysis.sentence_translation if analysis else sentence.get("translation")),
                    grammarNotes=(
                        analysis.grammar_notes
                        if analysis
                        else sentence.get("grammarNotes", "")
                    )
                    or "",
                    notes=list(
                        analysis.notes
                        if analysis
                        else sentence.get("notes") or []
                    ),
                    characterIds=list(sentence.get("characterIds") or []),
                    polygon=sentence.get("polygon", []),
                    ocrText=(analysis.ocr_text if analysis else sentence.get("text")),
                )
            )

        if enrichment is None:
            for word in annotation.get("words", []):
                read_words.append(
                    ReadWord(
                        id=word["id"],
                        segmentId=segment.id,
                        text=word.get("text", ""),
                        pinyin=word.get("pinyin") or "",
                        translation=word.get("translation"),
                        characterIds=list(word.get("characterIds") or []),
                        polygon=word.get("polygon", []),
                    )
                )
            continue

        enriched_word_ids: set[str] = set()
        word_counter = 1
        for sentence in annotation.get("sentences", []):
            analysis = analyses.get((source_page_id, sentence["id"]))
            if analysis is None:
                continue
            for word in analysis.words:
                word_id = f"{segment.id}-word-{word_counter:04d}"
                word_counter += 1
                enriched_word_ids.update(word.ocr_token_ids)
                read_words.append(
                    ReadWord(
                        id=word_id,
                        segmentId=segment.id,
                        text=word.surface_text,
                        pinyin=word.pinyin,
                        translation=word.translation,
                        characterIds=list(word.ocr_token_ids),
                        normalizedText=word.normalized_text,
                        confidence=word.confidence,
                    )
                )
                for character in read_characters:
                    if character.segmentId == segment.id and character.id in word.ocr_token_ids:
                        character.wordId = word_id

        for word in annotation.get("words", []):
            if any(character_id in enriched_word_ids for character_id in word.get("characterIds") or []):
                continue
            read_words.append(
                ReadWord(
                    id=word["id"],
                    segmentId=segment.id,
                    text=word.get("text", ""),
                    pinyin=word.get("pinyin") or "",
                    translation=word.get("translation"),
                    characterIds=list(word.get("characterIds") or []),
                    polygon=word.get("polygon", []),
                )
            )

    return read_sentences, read_words, read_characters, chapter_notes


def source_for_sentence(sentence_id: str) -> SentenceSource:
    match = re.search(r"(patch-\d+)", sentence_id)
    if match:
        return SentenceSource(type="patch", patchId=match.group(1))
    return SentenceSource(type="ocr")


def collect_refine_entities(
    manifest: ChapterManifest,
    annotations: dict[str, dict[str, Any]],
    patches: PatchReviewFile | None,
) -> tuple[list[RefineSentence], list[RefineWord], list[RefineCharacter], list[RefinePatch]]:
    refine_sentences: list[RefineSentence] = []
    refine_words: list[RefineWord] = []
    refine_characters: list[RefineCharacter] = []
    refine_patches: list[RefinePatch] = []

    for segment in manifest.segments:
        annotation = annotations[segment.id]
        for character in annotation.get("characters", []):
            refine_characters.append(
                RefineCharacter(
                    id=character["id"],
                    segmentId=segment.id,
                    wordId=character.get("wordId"),
                    sentenceId=character.get("sentenceId"),
                    text=character.get("text", ""),
                    polygon=character.get("polygon", []),
                )
            )

        for word in annotation.get("words", []):
            refine_words.append(
                RefineWord(
                    id=word["id"],
                    segmentId=segment.id,
                    text=word.get("text", ""),
                    characterIds=list(word.get("characterIds") or []),
                    polygon=word.get("polygon", []),
                    pinyin=word.get("pinyin") or "",
                    translation=word.get("translation"),
                )
            )

        for sentence in annotation.get("sentences", []):
            refine_sentences.append(
                RefineSentence(
                    id=sentence["id"],
                    segmentId=segment.id,
                    status=sentence.get("status") or "active",
                    text=sentence.get("text", "") or "",
                    characterIds=list(sentence.get("characterIds") or []),
                    polygon=sentence.get("polygon", []),
                    pinyin=sentence.get("pinyin") or "",
                    translation=sentence.get("translation"),
                    ocrConfidence=None,
                    qualityScore=None,
                    flags=[],
                    source=source_for_sentence(sentence["id"]),
                )
            )

    if patches:
        segment_ids_by_page_id = {segment.sourcePageId: segment.id for segment in manifest.segments}
        for patch in patches.patches:
            refine_patches.append(
                RefinePatch(
                    patch_id=patch.patch_id,
                    segmentId=segment_ids_by_page_id[patch.page_id],
                    kind=patch.kind,
                    region=patch.region,
                    text_flow=patch.text_flow,
                    ocr_candidate=patch.ocr_candidate,
                    user_transcript=patch.user_transcript,
                    anchor=patch.anchor,
                    notes=patch.notes,
                )
            )

    return refine_sentences, refine_words, refine_characters, refine_patches


def build_read_model(
    manifest: ChapterManifest,
    annotations: dict[str, dict[str, Any]],
    enrichment: ChapterEnrichment | None,
) -> ReadModel:
    segments = build_segments(manifest, annotations)
    sentences, words, characters, chapter_notes = collect_read_entities(manifest, annotations, enrichment)
    return ReadModel(
        series=manifest.series,
        chapter=manifest.chapter,
        title=manifest.title,
        segments=segments,
        sentences=sentences,
        words=words,
        characters=characters,
        chapterNotes=chapter_notes,
    )


def build_refine_model(
    manifest: ChapterManifest,
    annotations: dict[str, dict[str, Any]],
    patches: PatchReviewFile | None,
) -> RefineModel:
    segments = build_segments(manifest, annotations)
    sentences, words, characters, refine_patches = collect_refine_entities(manifest, annotations, patches)
    return RefineModel(
        series=manifest.series,
        chapter=manifest.chapter,
        title=manifest.title,
        segments=segments,
        sentences=sentences,
        words=words,
        characters=characters,
        patches=refine_patches,
    )


def main() -> None:
    args = parse_args()
    manifest_file = manifest_path(args.series, args.chapter)
    pages = load_pages_from_existing_manifest(manifest_file)
    manifest = build_manifest(args.series, args.chapter, pages)
    annotations = load_annotations_for_manifest(manifest)

    write_json(manifest_file, manifest.model_dump(mode="json"))

    annotations_dir = chapter_annotations_dir(args.series, args.chapter)
    patches = load_patches(args.series, args.chapter)
    refine_model = build_refine_model(manifest, annotations, patches)
    write_json(annotations_dir / "refine-model.json", refine_model.model_dump(mode="json"))

    enrichment_path = Path(args.enrichment) if args.enrichment else default_enrichment_path(args.chapter)
    enrichment = load_enrichment(enrichment_path)
    if enrichment is not None and not args.skip_read_model:
        read_model = build_read_model(manifest, annotations, enrichment)
        write_json(annotations_dir / "read-model.json", read_model.model_dump(mode="json"))


if __name__ == "__main__":
    main()

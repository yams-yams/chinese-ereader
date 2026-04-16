#!/usr/bin/env python3

from __future__ import annotations

from typing import Literal, Optional

from pydantic import Field

from enrichment_schema import StrictBaseModel


class Point(StrictBaseModel):
    x: float
    y: float


class RegionGeometry(StrictBaseModel):
    polygon: list[Point]


class TextFlow(StrictBaseModel):
    mode: Literal["vertical_rl", "vertical_lr", "horizontal_ltr", "horizontal_rtl"]
    guide: list[Point]


ReadingDirection = Literal["vertical_rl", "vertical_lr", "horizontal_ltr", "horizontal_rtl"]


class PatchAnchor(StrictBaseModel):
    insert_after_sentence_id: Optional[str] = None
    insert_before_sentence_id: Optional[str] = None


class MissingRegionPatch(StrictBaseModel):
    patch_id: str
    page_id: str
    kind: Literal["missing_region"]
    region: RegionGeometry
    text_flow: TextFlow
    ocr_candidate: str = ""
    user_transcript: str
    anchor: PatchAnchor
    notes: str = ""


class PatchReviewFile(StrictBaseModel):
    series: str
    chapter: str
    patches: list[MissingRegionPatch] = Field(default_factory=list)


class NeighborSentence(StrictBaseModel):
    sentence_id: str
    text: str


class PatchPromptInput(StrictBaseModel):
    patch_id: str
    page_id: str
    source_text: str
    ocr_candidate: str = ""
    reading_direction: ReadingDirection
    neighbor_sentences: list[NeighborSentence] = Field(default_factory=list)
    notes: str = ""


class PatchWordEnrichment(StrictBaseModel):
    surface_text: str
    normalized_text: str
    pinyin: str
    translation: str
    confidence: Literal["high", "medium", "low"]


class PatchSentenceEnrichment(StrictBaseModel):
    patch_id: str
    page_id: str
    original_text: str
    normalized_text: str
    sentence_pinyin: str
    sentence_translation: str
    grammar_notes: str = ""
    words: list[PatchWordEnrichment]
    notes: list[str] = Field(default_factory=list)


class PatchEnrichmentResponse(StrictBaseModel):
    series: str
    chapter: str
    patch_analyses: list[PatchSentenceEnrichment]
    chapter_notes: list[str] = Field(default_factory=list)

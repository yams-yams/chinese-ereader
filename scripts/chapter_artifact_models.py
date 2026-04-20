#!/usr/bin/env python3

from __future__ import annotations

from typing import Literal, Optional

from pydantic import Field

from enrichment_schema import StrictBaseModel
from ocr_patch_schema import MissingRegionPatch, Point


class ChapterSegment(StrictBaseModel):
    id: str
    image: str
    annotation: str
    sourcePageId: str


class LegacyManifestPage(StrictBaseModel):
    id: str
    image: str
    annotation: str


class ChapterManifest(StrictBaseModel):
    series: str
    chapter: str
    title: str
    segmentCount: int
    segments: list[ChapterSegment]
    # Keep the legacy fields during migration so the current reader still boots.
    pageCount: int
    pages: list[LegacyManifestPage]


class ImageSize(StrictBaseModel):
    width: int
    height: int


class SegmentArtifact(StrictBaseModel):
    id: str
    image: str
    imageSize: ImageSize
    sourcePageId: str


class ReadSentence(StrictBaseModel):
    id: str
    segmentId: str
    status: Literal["active", "deleted"] = "active"
    text: str
    pinyin: str = ""
    translation: Optional[str] = None
    grammarNotes: str = ""
    notes: list[str] = Field(default_factory=list)
    characterIds: list[str] = Field(default_factory=list)
    polygon: list[Point] = Field(default_factory=list)
    ocrText: Optional[str] = None


class ReadWord(StrictBaseModel):
    id: str
    segmentId: str
    text: str
    pinyin: str = ""
    translation: Optional[str] = None
    characterIds: list[str] = Field(default_factory=list)
    polygon: list[Point] = Field(default_factory=list)
    normalizedText: Optional[str] = None
    confidence: Optional[Literal["high", "medium", "low"]] = None


class ReadCharacter(StrictBaseModel):
    id: str
    segmentId: str
    wordId: Optional[str] = None
    sentenceId: Optional[str] = None
    text: str
    polygon: list[Point] = Field(default_factory=list)


class ReadModel(StrictBaseModel):
    series: str
    chapter: str
    title: str
    segments: list[SegmentArtifact]
    sentences: list[ReadSentence]
    words: list[ReadWord]
    characters: list[ReadCharacter]
    chapterNotes: list[str] = Field(default_factory=list)


class SentenceSource(StrictBaseModel):
    type: Literal["ocr", "patch"]
    patchId: Optional[str] = None


class RefineSentence(StrictBaseModel):
    id: str
    segmentId: str
    status: Literal["active", "deleted"] = "active"
    text: str
    characterIds: list[str] = Field(default_factory=list)
    polygon: list[Point] = Field(default_factory=list)
    pinyin: str = ""
    translation: Optional[str] = None
    ocrConfidence: Optional[float] = None
    qualityScore: Optional[float] = None
    flags: list[str] = Field(default_factory=list)
    source: SentenceSource


class RefineWord(StrictBaseModel):
    id: str
    segmentId: str
    text: str
    characterIds: list[str] = Field(default_factory=list)
    polygon: list[Point] = Field(default_factory=list)
    pinyin: str = ""
    translation: Optional[str] = None
    normalizedText: Optional[str] = None
    confidence: Optional[Literal["high", "medium", "low"]] = None


class RefineCharacter(StrictBaseModel):
    id: str
    segmentId: str
    wordId: Optional[str] = None
    sentenceId: Optional[str] = None
    text: str
    polygon: list[Point] = Field(default_factory=list)


class RefinePatch(StrictBaseModel):
    patch_id: str
    segmentId: str
    kind: Literal["missing_region"]
    region: MissingRegionPatch.model_fields["region"].annotation
    text_flow: MissingRegionPatch.model_fields["text_flow"].annotation
    ocr_candidate: str = ""
    user_transcript: str = ""
    anchor: MissingRegionPatch.model_fields["anchor"].annotation
    notes: str = ""


class RefineModel(StrictBaseModel):
    series: str
    chapter: str
    title: str
    segments: list[SegmentArtifact]
    sentences: list[RefineSentence]
    words: list[RefineWord]
    characters: list[RefineCharacter]
    patches: list[RefinePatch] = Field(default_factory=list)

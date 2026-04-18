#!/usr/bin/env python3

from __future__ import annotations

from copy import deepcopy
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field


class StrictBaseModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class WordEnrichment(StrictBaseModel):
    surface_text: str
    normalized_text: str
    pinyin: str
    translation: str
    ocr_token_ids: list[str]
    confidence: Literal["high", "medium", "low"]


class SentenceEnrichment(StrictBaseModel):
    page_id: str
    sentence_id: str
    ocr_text: str
    normalized_text: str
    sentence_pinyin: str
    sentence_translation: str
    grammar_notes: str = ""
    words: list[WordEnrichment]
    notes: list[str] = Field(default_factory=list)


class ChapterEnrichment(StrictBaseModel):
    series: str
    chapter: str
    sentence_analyses: list[SentenceEnrichment]
    chapter_notes: list[str] = Field(default_factory=list)


class ChunkEnrichment(StrictBaseModel):
    page_id: str
    chunk_id: str
    chunk_reason: Literal["dialogue_box", "neighbor_window"]
    sentence_analyses: list[SentenceEnrichment]


def _make_schema_strict(node: object) -> object:
    if isinstance(node, dict):
        properties = node.get("properties")
        if isinstance(properties, dict):
            node["required"] = list(properties.keys())
            node["additionalProperties"] = False
            for value in properties.values():
                _make_schema_strict(value)

        items = node.get("items")
        if items is not None:
            _make_schema_strict(items)

        defs = node.get("$defs")
        if isinstance(defs, dict):
            for value in defs.values():
                _make_schema_strict(value)

        any_of = node.get("anyOf")
        if isinstance(any_of, list):
            for value in any_of:
                _make_schema_strict(value)

        one_of = node.get("oneOf")
        if isinstance(one_of, list):
            for value in one_of:
                _make_schema_strict(value)

    elif isinstance(node, list):
        for value in node:
            _make_schema_strict(value)

    return node


def strict_json_schema(model: type[BaseModel]) -> dict:
    schema = deepcopy(model.model_json_schema())
    return _make_schema_strict(schema)

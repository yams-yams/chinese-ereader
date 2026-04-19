#!/usr/bin/env python3

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

from pydantic import ValidationError

from enrichment_schema import strict_json_schema
from ocr_patch_schema import PatchEnrichmentResponse


CODE_BLOCK_RE = re.compile(r"```(?:json)?\s*(.*?)```", re.DOTALL)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Validate OCR patch enrichment JSON.")
    parser.add_argument("--input", help="Path to a JSON file. If omitted, read stdin.")
    parser.add_argument(
        "--schema",
        action="store_true",
        help="Print the JSON schema for the expected output format and exit.",
    )
    return parser.parse_args()


def load_text(input_path: str | None) -> str:
    if input_path:
        return Path(input_path).read_text()
    return sys.stdin.read()


def extract_json_blob(text: str) -> str:
    match = CODE_BLOCK_RE.search(text)
    if match:
        return match.group(1).strip()

    stripped = text.strip()
    start_candidates = [index for index in (stripped.find("{"), stripped.find("[")) if index != -1]
    if not start_candidates:
        raise ValueError("No JSON object or array found in input.")
    return stripped[min(start_candidates) :]


def main() -> None:
    args = parse_args()

    if args.schema:
        print(json.dumps(strict_json_schema(PatchEnrichmentResponse), ensure_ascii=False, indent=2))
        return

    raw_text = load_text(args.input)
    json_blob = extract_json_blob(raw_text)

    try:
        payload = json.loads(json_blob)
    except json.JSONDecodeError as error:
        raise SystemExit(f"Invalid JSON: {error}")

    try:
        validated = PatchEnrichmentResponse.model_validate(payload)
    except ValidationError as error:
        print(error, file=sys.stderr)
        raise SystemExit(1)

    print(
        json.dumps(
            {
                "status": "ok",
                "series": validated.series,
                "chapter": validated.chapter,
                "patch_count": len(validated.patch_analyses),
                "chapter_notes_count": len(validated.chapter_notes),
            },
            ensure_ascii=False,
            indent=2,
        )
    )


if __name__ == "__main__":
    main()

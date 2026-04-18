#!/usr/bin/env python3

from __future__ import annotations

import argparse
import json

from chapter_enrichment_prompt import DEVELOPER_PROMPT, build_chapter_payload
from enrichment_schema import ChapterEnrichment, strict_json_schema


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Build a local-Codex prompt for full chapter enrichment.")
    parser.add_argument("--series", required=True)
    parser.add_argument("--chapter", required=True)
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    payload = build_chapter_payload(args.series, args.chapter)
    schema = strict_json_schema(ChapterEnrichment)

    prompt = {
        "instructions": DEVELOPER_PROMPT
        + "\nBefore finalizing, verify that your output is valid JSON matching the provided schema exactly. Return only the JSON object and no commentary.",
        "output_schema": schema,
        "input_payload": payload,
    }

    print(json.dumps(prompt, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()

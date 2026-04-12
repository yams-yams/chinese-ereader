#!/usr/bin/env python3

import argparse
import json
import subprocess
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SPLITTER = ROOT / "scripts" / "split_chapter.swift"
OCR = ROOT / "scripts" / "ocr_pages.swift"
SWIFT_CACHE = ROOT / "tmp" / "swift-module-cache"


def run(cmd):
    print(">", " ".join(str(part) for part in cmd))
    subprocess.run(cmd, check=True)


def build_manifest(series_slug: str, chapter_slug: str) -> None:
    pages_dir = ROOT / "data" / "processed" / "pages" / series_slug / chapter_slug
    annotations_dir = ROOT / "data" / "processed" / "annotations" / series_slug / chapter_slug
    manifest_path = ROOT / "data" / "processed" / "chapters" / series_slug / f"{chapter_slug}.json"
    manifest_path.parent.mkdir(parents=True, exist_ok=True)

    page_entries = []
    for page_path in sorted(pages_dir.glob("page-*.png")):
        annotation_path = annotations_dir / f"{page_path.stem}.json"
        page_entries.append(
            {
                "id": page_path.stem,
                "image": str(page_path.relative_to(ROOT)),
                "annotation": str(annotation_path.relative_to(ROOT)),
            }
        )

    manifest = {
        "series": series_slug,
        "chapter": chapter_slug,
        "pageCount": len(page_entries),
        "pages": page_entries,
    }

    manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2))


def main() -> None:
    parser = argparse.ArgumentParser(description="Process one captured chapter.")
    parser.add_argument("--series", required=True)
    parser.add_argument("--chapter", required=True)
    parser.add_argument(
        "--min-gap",
        type=int,
        default=120,
        help="Minimum vertical whitespace gap in pixels to split pages.",
    )
    parser.add_argument(
        "--white-threshold",
        type=int,
        default=245,
        help="Pixels brighter than this are considered white.",
    )
    args = parser.parse_args()

    raw_dir = ROOT / "data" / "raw" / args.series / args.chapter
    pages_dir = ROOT / "data" / "processed" / "pages" / args.series / args.chapter
    annotations_dir = ROOT / "data" / "processed" / "annotations" / args.series / args.chapter

    SWIFT_CACHE.mkdir(parents=True, exist_ok=True)
    pages_dir.mkdir(parents=True, exist_ok=True)
    annotations_dir.mkdir(parents=True, exist_ok=True)

    run(
        [
            "swift",
            "-module-cache-path",
            str(SWIFT_CACHE),
            str(SPLITTER),
            "--input",
            str(raw_dir),
            "--output",
            str(pages_dir),
            "--min-gap",
            str(args.min_gap),
            "--white-threshold",
            str(args.white_threshold),
        ]
    )
    run(
        [
            "swift",
            "-module-cache-path",
            str(SWIFT_CACHE),
            str(OCR),
            "--input",
            str(pages_dir),
            "--output",
            str(annotations_dir),
        ]
    )
    build_manifest(args.series, args.chapter)


if __name__ == "__main__":
    main()

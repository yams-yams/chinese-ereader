#!/usr/bin/env python3

import argparse
import json
import subprocess
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SPLITTER = ROOT / "scripts" / "split_chapter.swift"
OCR = ROOT / "scripts" / "ocr_pages.py"
SWIFT_CACHE = ROOT / "tmp" / "swift-module-cache"


def run(cmd):
    print(">", " ".join(str(part) for part in cmd))
    subprocess.run(cmd, check=True)


def clear_generated_files(directory: Path, suffix: str) -> None:
    if not directory.exists():
        return

    for path in directory.glob(f"*{suffix}"):
        if path.is_file():
            path.unlink()


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
    parser.add_argument(
        "--crop-left-ratio",
        type=float,
        default=0.0,
        help="Fraction of image width to trim from the left before page splitting.",
    )
    parser.add_argument(
        "--crop-right-ratio",
        type=float,
        default=0.0,
        help="Fraction of image width to trim from the right before page splitting.",
    )
    parser.add_argument(
        "--horizontal-margin-px",
        type=int,
        default=48,
        help="Pixels of horizontal margin to preserve on both sides after ratio-based trimming.",
    )
    parser.add_argument(
        "--ocr-lang",
        default="chi_sim+chi_sim_vert",
        help="Tesseract language pack(s) used by the Python OCR stage.",
    )
    parser.add_argument(
        "--ocr-psm",
        default="11",
        help="Tesseract page segmentation mode.",
    )
    parser.add_argument(
        "--ocr-min-confidence",
        type=float,
        default=25.0,
        help="Discard OCR tokens below this confidence.",
    )
    args = parser.parse_args()

    raw_dir = ROOT / "data" / "raw" / args.series / args.chapter
    pages_dir = ROOT / "data" / "processed" / "pages" / args.series / args.chapter
    annotations_dir = ROOT / "data" / "processed" / "annotations" / args.series / args.chapter

    SWIFT_CACHE.mkdir(parents=True, exist_ok=True)
    pages_dir.mkdir(parents=True, exist_ok=True)
    annotations_dir.mkdir(parents=True, exist_ok=True)
    clear_generated_files(pages_dir, ".png")
    clear_generated_files(annotations_dir, ".json")

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
            "--crop-left-ratio",
            str(args.crop_left_ratio),
            "--crop-right-ratio",
            str(args.crop_right_ratio),
            "--horizontal-margin-px",
            str(args.horizontal_margin_px),
        ]
    )
    run(
        [
            "python3",
            str(OCR),
            "--input",
            str(pages_dir),
            "--output",
            str(annotations_dir),
            "--lang",
            str(args.ocr_lang),
            "--psm",
            str(args.ocr_psm),
            "--min-confidence",
            str(args.ocr_min_confidence),
        ]
    )
    build_manifest(args.series, args.chapter)


if __name__ == "__main__":
    main()

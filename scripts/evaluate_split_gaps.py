#!/usr/bin/env python3

import argparse
import json
import shutil
import struct
import subprocess
from pathlib import Path
from statistics import median


ROOT = Path(__file__).resolve().parents[1]
SPLITTER = ROOT / "scripts" / "split_chapter.swift"
SWIFT_CACHE = ROOT / "tmp" / "swift-module-cache"
DEFAULT_GAPS = [40, 60, 80, 100, 120]


def run(cmd: list[str]) -> None:
    print(">", " ".join(str(part) for part in cmd))
    subprocess.run(cmd, check=True)


def png_size(path: Path) -> tuple[int, int]:
    with path.open("rb") as handle:
        if handle.read(8) != b"\x89PNG\r\n\x1a\n":
            raise ValueError(f"{path} is not a PNG")
        chunk_length = struct.unpack(">I", handle.read(4))[0]
        chunk_type = handle.read(4)
        if chunk_type != b"IHDR" or chunk_length < 8:
            raise ValueError(f"{path} is missing a valid IHDR chunk")
        width, height = struct.unpack(">II", handle.read(8))
    return width, height


def summarize_pages(directory: Path, oversize_height: int) -> dict:
    pages = []
    for page_path in sorted(directory.glob("page-*.png")):
        width, height = png_size(page_path)
        pages.append(
            {
                "page": page_path.name,
                "width": width,
                "height": height,
            }
        )

    heights = [page["height"] for page in pages]
    oversized = [page["page"] for page in pages if page["height"] > oversize_height]
    return {
        "pageCount": len(pages),
        "minHeight": min(heights) if heights else None,
        "medianHeight": int(median(heights)) if heights else None,
        "maxHeight": max(heights) if heights else None,
        "oversizedPages": oversized,
        "pages": pages,
    }


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Sweep chapter split min-gap values and report page height stats."
    )
    parser.add_argument("--series", required=True)
    parser.add_argument("--chapter", required=True)
    parser.add_argument(
        "--min-gaps",
        nargs="+",
        type=int,
        default=DEFAULT_GAPS,
        help="List of min-gap values to evaluate.",
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
        "--oversize-height",
        type=int,
        default=3500,
        help="Height threshold used to flag OCR-unfriendly oversized pages.",
    )
    parser.add_argument(
        "--max-segment-height",
        type=int,
        default=3500,
        help="Maximum merged page height to allow during recombination.",
    )
    parser.add_argument(
        "--oversized-split-min-gap",
        type=int,
        default=50,
        help="Fallback gap threshold for splitting oversized segments on a second pass.",
    )
    parser.add_argument(
        "--tiny-fragment-height",
        type=int,
        default=200,
        help="Try to absorb segments shorter than this before the regular recombine pass.",
    )
    parser.add_argument(
        "--tiny-merge-max-height",
        type=int,
        default=3300,
        help="Maximum merged page height allowed when rescuing tiny fragments.",
    )
    parser.add_argument(
        "--recombine-short-height",
        type=int,
        default=1500,
        help="Merge adjacent splits when either side is shorter than this and the merged result stays under the regular height cap.",
    )
    parser.add_argument(
        "--disable-recombine",
        action="store_true",
        help="Skip both the tiny-fragment rescue pass and the regular recombine pass.",
    )
    parser.add_argument(
        "--output-root",
        default=None,
        help="Optional output directory for sweep results. Defaults under tmp/.",
    )
    parser.add_argument(
        "--keep-existing",
        action="store_true",
        help="Do not clear prior sweep outputs before running.",
    )
    return parser.parse_args()


def main() -> None:
    args = parse_args()

    raw_dir = ROOT / "data" / "raw" / args.series / args.chapter
    if not raw_dir.exists():
        raise SystemExit(f"Raw chapter directory does not exist: {raw_dir}")

    output_root = (
        Path(args.output_root)
        if args.output_root
        else ROOT / "tmp" / "split-gap-eval" / args.series / args.chapter
    )
    output_root.mkdir(parents=True, exist_ok=True)
    SWIFT_CACHE.mkdir(parents=True, exist_ok=True)

    sweep_results = []
    for min_gap in sorted(set(args.min_gaps)):
        gap_dir = output_root / f"min-gap-{min_gap:03d}"
        if gap_dir.exists() and not args.keep_existing:
            shutil.rmtree(gap_dir)
        gap_dir.mkdir(parents=True, exist_ok=True)

        cmd = [
            "swift",
            "-module-cache-path",
            str(SWIFT_CACHE),
            str(SPLITTER),
            "--input",
            str(raw_dir),
            "--output",
            str(gap_dir),
            "--min-gap",
            str(min_gap),
            "--white-threshold",
            str(args.white_threshold),
            "--crop-left-ratio",
            str(args.crop_left_ratio),
            "--crop-right-ratio",
            str(args.crop_right_ratio),
            "--horizontal-margin-px",
            str(args.horizontal_margin_px),
            "--max-segment-height",
            str(args.max_segment_height),
            "--oversized-split-min-gap",
            str(args.oversized_split_min_gap),
            "--tiny-fragment-height",
            str(args.tiny_fragment_height),
            "--tiny-merge-max-height",
            str(args.tiny_merge_max_height),
            "--recombine-short-height",
            str(args.recombine_short_height),
        ]
        if args.disable_recombine:
            cmd.append("--disable-recombine")
        run(cmd)
        summary = summarize_pages(gap_dir, oversize_height=args.oversize_height)
        summary["minGap"] = min_gap
        summary["recombineEnabled"] = not args.disable_recombine
        sweep_results.append(summary)

    summary_path = output_root / "summary.json"
    summary_path.write_text(json.dumps(sweep_results, indent=2))

    print()
    print("minGap | pages | min | median | max | oversized")
    print("------ | ----- | --- | ------ | --- | ---------")
    for result in sweep_results:
        oversized = ", ".join(result["oversizedPages"]) if result["oversizedPages"] else "-"
        print(
            f"{result['minGap']:>6} | "
            f"{result['pageCount']:>5} | "
            f"{result['minHeight']:>3} | "
            f"{result['medianHeight']:>6} | "
            f"{result['maxHeight']:>3} | "
            f"{oversized}"
        )

    print()
    print(f"Wrote comparison outputs to {output_root}")
    print(f"Wrote summary JSON to {summary_path}")


if __name__ == "__main__":
    main()

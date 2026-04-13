#!/usr/bin/env python3

import argparse
import csv
import json
import subprocess
from pathlib import Path


def parse_args():
    parser = argparse.ArgumentParser(description="Run OCR over processed chapter pages.")
    parser.add_argument("--input", required=True, help="Directory with page PNGs.")
    parser.add_argument("--output", required=True, help="Directory to write page JSON annotations.")
    parser.add_argument(
        "--lang",
        default="chi_sim+chi_sim_vert",
        help="Tesseract language pack(s) to use.",
    )
    parser.add_argument(
        "--psm",
        default="11",
        help="Tesseract page segmentation mode.",
    )
    parser.add_argument(
        "--min-confidence",
        type=float,
        default=25.0,
        help="Discard OCR tokens below this confidence.",
    )
    return parser.parse_args()


def iter_pages(directory: Path):
    return sorted(directory.glob("page-*.png"))


def run_tesseract(page_path: Path, lang: str, psm: str):
    command = [
        "tesseract",
        str(page_path),
        "stdout",
        "-l",
        lang,
        "--psm",
        psm,
        "tsv",
    ]
    result = subprocess.run(command, check=True, capture_output=True, text=True)
    return list(csv.DictReader(result.stdout.splitlines(), delimiter="\t"))


def run_tesseract_makebox(page_path: Path, lang: str, psm: str):
    command = [
        "tesseract",
        str(page_path),
        "stdout",
        "-l",
        lang,
        "--psm",
        psm,
        "makebox",
    ]
    result = subprocess.run(command, check=True, capture_output=True, text=True)
    return result.stdout.splitlines()


def normalize_box(left, top, width, height, page_width, page_height):
    return {
        "x": left / page_width,
        "y": 1 - ((top + height) / page_height),
        "width": width / page_width,
        "height": height / page_height,
    }


def parse_makebox(lines, page_width, page_height):
    characters = []
    for line in lines:
        parts = line.strip().split()
        if len(parts) < 6:
            continue

        text = parts[0]
        try:
            left = int(parts[1])
            bottom = int(parts[2])
            right = int(parts[3])
            top = int(parts[4])
        except ValueError:
            continue

        width = right - left
        height = top - bottom
        if width <= 0 or height <= 0:
            continue

        characters.append(
            {
                "text": text,
                "pixelBox": {
                    "left": left,
                    "top": page_height - top,
                    "width": width,
                    "height": height,
                },
                "box": normalize_box(left, page_height - top, width, height, page_width, page_height),
            }
        )

    return characters


def overlap_area(box_a, box_b):
    ax1 = box_a["left"]
    ay1 = box_a["top"]
    ax2 = ax1 + box_a["width"]
    ay2 = ay1 + box_a["height"]

    bx1 = box_b["left"]
    by1 = box_b["top"]
    bx2 = bx1 + box_b["width"]
    by2 = by1 + box_b["height"]

    overlap_width = max(0, min(ax2, bx2) - max(ax1, bx1))
    overlap_height = max(0, min(ay2, by2) - max(ay1, by1))
    return overlap_width * overlap_height


def build_annotation(rows, page_path, min_confidence, lang, psm):
    source_image = page_path.name
    page_row = next((row for row in rows if row.get("level") == "1"), None)
    page_width = max(1, int(page_row["width"])) if page_row else 1
    page_height = max(1, int(page_row["height"])) if page_row else 1

    words = []
    sentences_by_line = {}
    word_counter = 1
    word_entries = []

    for row in rows:
        if row.get("level") != "5":
            continue

        text = (row.get("text") or "").strip()
        if not text:
            continue

        try:
            confidence = float(row.get("conf", "-1"))
        except ValueError:
            confidence = -1

        if confidence < min_confidence:
            continue

        left = int(row["left"])
        top = int(row["top"])
        width = int(row["width"])
        height = int(row["height"])
        line_key = (
            row["block_num"],
            row["par_num"],
            row["line_num"],
        )
        sentence = sentences_by_line.setdefault(
            line_key,
            {
                "text_parts": [],
                "word_ids": [],
            },
        )

        word_id = f"word-{word_counter:04d}"
        word_counter += 1
        word_entries.append(
            {
                "id": word_id,
                "text": text,
                "lineKey": line_key,
                "pixelBox": {
                    "left": left,
                    "top": top,
                    "width": width,
                    "height": height,
                },
            }
        )

        sentence["text_parts"].append(text)
        sentence["word_ids"].append(word_id)

    char_box_lines = run_tesseract_makebox(page_path, lang, psm)
    raw_characters = parse_makebox(char_box_lines, page_width, page_height)

    characters = []
    character_counter = 1
    words_by_id = {
        entry["id"]: {
            "id": entry["id"],
            "text": entry["text"],
            "pinyin": "",
            "translation": None,
            "characterIds": [],
        }
        for entry in word_entries
    }

    for raw_character in raw_characters:
        best_word = None
        best_overlap = 0
        for word_entry in word_entries:
            overlap = overlap_area(raw_character["pixelBox"], word_entry["pixelBox"])
            if overlap > best_overlap:
                best_overlap = overlap
                best_word = word_entry

        if best_word is None:
            continue

        character_id = f"char-{character_counter:04d}"
        character_counter += 1
        characters.append(
            {
                "id": character_id,
                "text": raw_character["text"],
                "box": raw_character["box"],
                "wordId": best_word["id"],
                "sentenceId": None,
            }
        )
        words_by_id[best_word["id"]]["characterIds"].append(character_id)

    sentences = []
    for index, sentence in enumerate(sentences_by_line.values(), start=1):
        sentence_id = f"sentence-{index:04d}"
        sentence_text = "".join(sentence["text_parts"])
        sentence_character_ids = []
        for word_id in sentence["word_ids"]:
            sentence_character_ids.extend(words_by_id[word_id]["characterIds"])

        sentences.append(
            {
                "id": sentence_id,
                "text": sentence_text,
                "pinyin": "",
                "translation": None,
                "characterIds": sentence_character_ids,
            }
        )
        sentence_character_ids = set(sentence_character_ids)
        for character in characters:
            if character["id"] in sentence_character_ids:
                character["sentenceId"] = sentence_id

    words = list(words_by_id.values())

    return {
        "sourceImage": source_image,
        "characters": characters,
        "words": words,
        "sentences": sentences,
    }


def main():
    args = parse_args()
    input_dir = Path(args.input)
    output_dir = Path(args.output)
    output_dir.mkdir(parents=True, exist_ok=True)

    for page_path in iter_pages(input_dir):
        try:
            rows = run_tesseract(page_path, lang=args.lang, psm=args.psm)
            annotation = build_annotation(
                rows,
                page_path,
                args.min_confidence,
                args.lang,
                args.psm,
            )
        except subprocess.CalledProcessError as error:
            print(f"Failed OCR for {page_path.name}: {error}", flush=True)
            annotation = {
                "sourceImage": page_path.name,
                "characters": [],
                "words": [],
                "sentences": [],
            }

        output_path = output_dir / f"{page_path.stem}.json"
        output_path.write_text(json.dumps(annotation, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()

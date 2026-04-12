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


def normalize_box(left, top, width, height, page_width, page_height):
    return {
        "x": left / page_width,
        "y": 1 - ((top + height) / page_height),
        "width": width / page_width,
        "height": height / page_height,
    }


def split_character_boxes(word_box, text):
    text = text.strip()
    if not text:
        return []

    length = len(text)
    if length == 0:
        return []

    x = word_box["x"]
    y = word_box["y"]
    width = word_box["width"]
    height = word_box["height"]

    vertical = height > width * 1.35
    boxes = []

    for index, character in enumerate(text):
        if vertical:
            char_height = height / length
            boxes.append(
                {
                    "text": character,
                    "box": {
                        "x": x,
                        "y": y + (height - char_height * (index + 1)),
                        "width": width,
                        "height": char_height,
                    },
                }
            )
        else:
            char_width = width / length
            boxes.append(
                {
                    "text": character,
                    "box": {
                        "x": x + char_width * index,
                        "y": y,
                        "width": char_width,
                        "height": height,
                    },
                }
            )

    return boxes


def build_annotation(rows, source_image, min_confidence):
    page_row = next((row for row in rows if row.get("level") == "1"), None)
    page_width = max(1, int(page_row["width"])) if page_row else 1
    page_height = max(1, int(page_row["height"])) if page_row else 1

    words = []
    characters = []
    sentences_by_line = {}
    word_counter = 1
    character_counter = 1

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
        box = normalize_box(left, top, width, height, page_width, page_height)

        line_key = (
            row["block_num"],
            row["par_num"],
            row["line_num"],
        )
        sentence = sentences_by_line.setdefault(
            line_key,
            {
                "text_parts": [],
                "character_ids": [],
                "word_ids": [],
            },
        )

        word_id = f"word-{word_counter:04d}"
        word_counter += 1
        word_characters = []

        for chunk in split_character_boxes(box, text):
            character_id = f"char-{character_counter:04d}"
            character_counter += 1
            characters.append(
                {
                    "id": character_id,
                    "text": chunk["text"],
                    "box": chunk["box"],
                    "wordId": word_id,
                    "sentenceId": None,
                }
            )
            word_characters.append(character_id)
            sentence["character_ids"].append(character_id)

        words.append(
            {
                "id": word_id,
                "text": text,
                "pinyin": "",
                "translation": None,
                "characterIds": word_characters,
            }
        )

        sentence["text_parts"].append(text)
        sentence["word_ids"].append(word_id)

    sentences = []
    for index, sentence in enumerate(sentences_by_line.values(), start=1):
        sentence_id = f"sentence-{index:04d}"
        sentence_text = "".join(sentence["text_parts"])
        sentences.append(
            {
                "id": sentence_id,
                "text": sentence_text,
                "pinyin": "",
                "translation": None,
                "characterIds": sentence["character_ids"],
            }
        )
        sentence_character_ids = set(sentence["character_ids"])
        for character in characters:
            if character["id"] in sentence_character_ids:
                character["sentenceId"] = sentence_id

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
            annotation = build_annotation(rows, page_path.name, args.min_confidence)
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

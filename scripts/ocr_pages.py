#!/usr/bin/env python3

import argparse
import json
import os
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
PADDLE_CACHE = ROOT / "tmp" / "paddlex-cache"
os.environ.setdefault("PADDLE_PDX_CACHE_HOME", str(PADDLE_CACHE))
os.environ.setdefault("PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK", "True")

from paddleocr import PaddleOCR


def parse_args():
    parser = argparse.ArgumentParser(description="Run PaddleOCR over processed chapter pages.")
    parser.add_argument("--input", required=True, help="Directory with page PNGs.")
    parser.add_argument("--output", required=True, help="Directory to write page JSON annotations.")
    parser.add_argument(
        "--lang",
        default="ch",
        help="PaddleOCR language code.",
    )
    parser.add_argument(
        "--min-confidence",
        type=float,
        default=0.7,
        help="Discard OCR lines below this confidence.",
    )
    parser.add_argument(
        "--text-detection-model-name",
        default=None,
        help="Optional PaddleOCR text detection model override.",
    )
    parser.add_argument(
        "--text-recognition-model-name",
        default=None,
        help="Optional PaddleOCR text recognition model override.",
    )
    parser.add_argument(
        "--text-det-limit-side-len",
        type=int,
        default=2500,
        help="Maximum side length PaddleOCR should use before resizing.",
    )
    return parser.parse_args()


def iter_pages(directory: Path):
    return sorted(directory.glob("page-*.png"))


def normalize_box(left, top, width, height, page_width, page_height):
    return {
        "x": left / page_width,
        "y": 1 - ((top + height) / page_height),
        "width": width / page_width,
        "height": height / page_height,
    }


def normalize_polygon(polygon, page_width, page_height):
    return [
        {
            "x": point[0] / page_width,
            "y": 1 - (point[1] / page_height),
        }
        for point in polygon
    ]


def polygon_to_box(polygon, page_width, page_height):
    xs = [point[0] for point in polygon]
    ys = [point[1] for point in polygon]
    left = min(xs)
    top = min(ys)
    width = max(xs) - left
    height = max(ys) - top
    return normalize_box(left, top, width, height, page_width, page_height)


def build_annotation(result, page_path: Path, min_confidence: float):
    input_img = result["doc_preprocessor_res"]["output_img"]
    page_height, page_width = input_img.shape[:2]

    characters = []
    words = []
    sentences = []
    character_counter = 1
    word_counter = 1
    sentence_counter = 1

    rec_texts = result.get("rec_texts", [])
    rec_scores = result.get("rec_scores", [])
    rec_polys = result.get("rec_polys", [])
    text_words = result.get("text_word", [])
    text_word_regions = result.get("text_word_region", [])

    for line_index, text in enumerate(rec_texts):
        confidence = rec_scores[line_index]
        if confidence < min_confidence:
            continue

        fallback_poly = rec_polys[line_index] if line_index < len(rec_polys) else [
            (0, 0),
            (page_width, 0),
            (page_width, page_height),
            (0, page_height),
        ]
        sentence_id = f"sentence-{sentence_counter:04d}"
        sentence_counter += 1
        sentence_character_ids = []

        word_tokens = text_words[line_index] if line_index < len(text_words) else []
        word_regions = (
            text_word_regions[line_index] if line_index < len(text_word_regions) else []
        )

        if word_tokens and word_regions and len(word_tokens) == len(word_regions):
            for token, token_region in zip(word_tokens, word_regions):
                token_text = str(token).strip()
                if not token_text:
                    continue

                word_id = f"word-{word_counter:04d}"
                word_counter += 1

                character_id = f"char-{character_counter:04d}"
                character_counter += 1
                characters.append(
                    {
                        "id": character_id,
                        "text": token_text,
                        "box": polygon_to_box(token_region, page_width, page_height),
                        "polygon": normalize_polygon(token_region, page_width, page_height),
                        "wordId": word_id,
                        "sentenceId": sentence_id,
                    }
                )
                sentence_character_ids.append(character_id)

                words.append(
                    {
                        "id": word_id,
                        "text": token_text,
                        "pinyin": "",
                        "translation": None,
                        "characterIds": [character_id],
                        "polygon": normalize_polygon(token_region, page_width, page_height),
                    }
                )
        else:
            word_id = f"word-{word_counter:04d}"
            word_counter += 1
            character_id = f"char-{character_counter:04d}"
            character_counter += 1

            characters.append(
                {
                    "id": character_id,
                    "text": text,
                    "box": polygon_to_box(fallback_poly, page_width, page_height),
                    "polygon": normalize_polygon(fallback_poly, page_width, page_height),
                    "wordId": word_id,
                    "sentenceId": sentence_id,
                }
            )
            sentence_character_ids.append(character_id)
            words.append(
                {
                    "id": word_id,
                    "text": text,
                    "pinyin": "",
                    "translation": None,
                    "characterIds": [character_id],
                    "polygon": normalize_polygon(fallback_poly, page_width, page_height),
                }
            )

        sentences.append(
            {
                "id": sentence_id,
                "text": text,
                "pinyin": "",
                "translation": None,
                "characterIds": sentence_character_ids,
                "polygon": normalize_polygon(
                    rec_polys[line_index] if line_index < len(rec_polys) else fallback_poly,
                    page_width,
                    page_height,
                ),
            }
        )

    return {
        "sourceImage": page_path.name,
        "imageSize": {
            "width": page_width,
            "height": page_height,
        },
        "characters": characters,
        "words": words,
        "sentences": sentences,
    }


def build_ocr(args):
    kwargs = {
        "lang": args.lang,
        "text_det_limit_side_len": args.text_det_limit_side_len,
        "text_detection_model_name": args.text_detection_model_name or "PP-OCRv5_mobile_det",
        "text_recognition_model_name": args.text_recognition_model_name or "PP-OCRv5_mobile_rec",
        "use_doc_orientation_classify": False,
        "use_doc_unwarping": False,
        "use_textline_orientation": False,
    }
    return PaddleOCR(**kwargs)


def main():
    args = parse_args()
    input_dir = Path(args.input)
    output_dir = Path(args.output)
    output_dir.mkdir(parents=True, exist_ok=True)
    PADDLE_CACHE.mkdir(parents=True, exist_ok=True)

    ocr = build_ocr(args)

    for page_path in iter_pages(input_dir):
        try:
            print(f"OCR {page_path.name}", flush=True)
            results = list(ocr.predict(str(page_path), return_word_box=True))
            if results:
                annotation = build_annotation(results[0], page_path, args.min_confidence)
            else:
                annotation = {
                    "sourceImage": page_path.name,
                    "characters": [],
                    "words": [],
                    "sentences": [],
                }
        except Exception as error:  # noqa: BLE001
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

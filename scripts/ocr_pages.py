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


SIZE_WIDTH_REFERENCE_PX = 30.0
SIZE_HEIGHT_REFERENCE_PX = 12.0
SIZE_AREA_REFERENCE_PX = 360.0
EDGE_REFERENCE_PX = 24.0
NEIGHBORHOOD_REFERENCE_PX = 160.0
ISOLATION_REFERENCE_PX = 160.0


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


def pixel_bounds_for_polygon(polygon):
    xs = [float(point[0]) for point in polygon]
    ys = [float(point[1]) for point in polygon]
    left = float(min(xs))
    top = float(min(ys))
    width = float(max(xs) - left)
    height = float(max(ys) - top)
    return {
        "x": left,
        "y": top,
        "width": width,
        "height": height,
        "area": float(width * height),
    }


def polygon_center_px(polygon):
    bounds = pixel_bounds_for_polygon(polygon)
    return (
        bounds["x"] + (bounds["width"] / 2.0),
        bounds["y"] + (bounds["height"] / 2.0),
    )


def clamp_score(value):
    return max(0.0, min(1.0, value))


def size_score(bounds):
    width_score = clamp_score(bounds["width"] / SIZE_WIDTH_REFERENCE_PX)
    height_score = clamp_score(bounds["height"] / SIZE_HEIGHT_REFERENCE_PX)
    area_score = clamp_score(bounds["area"] / SIZE_AREA_REFERENCE_PX)
    return clamp_score((width_score * 0.4) + (height_score * 0.4) + (area_score * 0.2))


def edge_score(bounds, page_width, page_height):
    min_edge_distance = min(
        bounds["x"],
        bounds["y"],
        max(page_width - (bounds["x"] + bounds["width"]), 0.0),
        max(page_height - (bounds["y"] + bounds["height"]), 0.0),
    )
    return clamp_score(min_edge_distance / EDGE_REFERENCE_PX)


def neighborhood_score(index, centers):
    if len(centers) <= 1:
        return 0.0

    current_x, current_y = centers[index]
    nearest_distance = min(
        (
            ((current_x - other_x) ** 2 + (current_y - other_y) ** 2) ** 0.5
            for other_index, (other_x, other_y) in enumerate(centers)
            if other_index != index
        ),
        default=NEIGHBORHOOD_REFERENCE_PX,
    )
    return clamp_score(1.0 - (nearest_distance / NEIGHBORHOOD_REFERENCE_PX))


def nearest_neighbor_distance(index, centers):
    if len(centers) <= 1:
        return None

    current_x, current_y = centers[index]
    return min(
        (
            ((current_x - other_x) ** 2 + (current_y - other_y) ** 2) ** 0.5
            for other_index, (other_x, other_y) in enumerate(centers)
            if other_index != index
        ),
        default=None,
    )


def quality_score(recognition_confidence, bounds, page_width, page_height, nearest_distance):
    geometry_size_score = size_score(bounds)
    min_edge_distance = min(
        bounds["x"],
        bounds["y"],
        max(page_width - (bounds["x"] + bounds["width"]), 0.0),
        max(page_height - (bounds["y"] + bounds["height"]), 0.0),
    )
    is_tiny = (
        bounds["width"] < SIZE_WIDTH_REFERENCE_PX
        or bounds["height"] < SIZE_HEIGHT_REFERENCE_PX
        or bounds["area"] < SIZE_AREA_REFERENCE_PX
    )
    edge_penalty = 0.0
    if is_tiny and min_edge_distance < EDGE_REFERENCE_PX:
        edge_penalty = clamp_score((EDGE_REFERENCE_PX - min_edge_distance) / EDGE_REFERENCE_PX) * 0.12

    isolation_penalty = 0.0
    if is_tiny and nearest_distance is not None and nearest_distance > ISOLATION_REFERENCE_PX:
        isolation_penalty = (
            clamp_score((nearest_distance - ISOLATION_REFERENCE_PX) / ISOLATION_REFERENCE_PX) * 0.08
        )

    score = recognition_confidence * 0.75 + geometry_size_score * 0.25 - edge_penalty - isolation_penalty
    return clamp_score(score), {
        "ocrConfidence": round(recognition_confidence, 4),
        "sizeScore": round(geometry_size_score, 4),
        "edgePenalty": round(edge_penalty, 4),
        "isolationPenalty": round(isolation_penalty, 4),
        "nearestNeighborDistancePx": round(nearest_distance, 2) if nearest_distance is not None else None,
    }


def geometry_flags(bounds, page_width, page_height):
    flags = []
    if bounds["width"] < SIZE_WIDTH_REFERENCE_PX:
        flags.append("narrow")
    if bounds["height"] < SIZE_HEIGHT_REFERENCE_PX:
        flags.append("short")
    if bounds["area"] < SIZE_AREA_REFERENCE_PX:
        flags.append("small-area")

    min_edge_distance = min(
        bounds["x"],
        bounds["y"],
        max(page_width - (bounds["x"] + bounds["width"]), 0.0),
        max(page_height - (bounds["y"] + bounds["height"]), 0.0),
    )
    if min_edge_distance < EDGE_REFERENCE_PX:
        flags.append("edge-adjacent")
    return flags


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
    kept_sentence_meta = []

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
        sentence_polygon = normalize_polygon(
            rec_polys[line_index] if line_index < len(rec_polys) else fallback_poly,
            page_width,
            page_height,
        )
        sentence_pixel_bounds = pixel_bounds_for_polygon(
            rec_polys[line_index] if line_index < len(rec_polys) else fallback_poly
        )
        sentence_id = f"sentence-{sentence_counter:04d}"
        sentence_counter += 1
        sentence_character_ids = []
        kept_sentence_meta.append(
            {
                "id": sentence_id,
                "text": text,
                "confidence": confidence,
                "pixelBounds": sentence_pixel_bounds,
                "center": polygon_center_px(
                    rec_polys[line_index] if line_index < len(rec_polys) else fallback_poly
                ),
                "polygon": sentence_polygon,
            }
        )

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
                token_pixel_bounds = pixel_bounds_for_polygon(token_region)
                characters.append(
                    {
                        "id": character_id,
                        "text": token_text,
                        "box": polygon_to_box(token_region, page_width, page_height),
                        "polygon": normalize_polygon(token_region, page_width, page_height),
                        "pixelBox": {key: round(value, 2) for key, value in token_pixel_bounds.items()},
                        "ocrConfidence": round(confidence, 4),
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
                        "pixelBox": {key: round(value, 2) for key, value in token_pixel_bounds.items()},
                        "ocrConfidence": round(confidence, 4),
                    }
                )
        else:
            word_id = f"word-{word_counter:04d}"
            word_counter += 1
            character_id = f"char-{character_counter:04d}"
            character_counter += 1
            fallback_pixel_bounds = pixel_bounds_for_polygon(fallback_poly)

            characters.append(
                {
                    "id": character_id,
                    "text": text,
                    "box": polygon_to_box(fallback_poly, page_width, page_height),
                    "polygon": normalize_polygon(fallback_poly, page_width, page_height),
                    "pixelBox": {key: round(value, 2) for key, value in fallback_pixel_bounds.items()},
                    "ocrConfidence": round(confidence, 4),
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
                    "pixelBox": {key: round(value, 2) for key, value in fallback_pixel_bounds.items()},
                    "ocrConfidence": round(confidence, 4),
                }
            )

        sentences.append(
            {
                "id": sentence_id,
                "text": text,
                "pinyin": "",
                "translation": None,
                "characterIds": sentence_character_ids,
                "polygon": sentence_polygon,
            }
        )

    sentence_index = {sentence["id"]: sentence for sentence in sentences}
    centers = [meta["center"] for meta in kept_sentence_meta]
    sentence_scores = []
    for index, meta in enumerate(kept_sentence_meta):
        nearest_distance = nearest_neighbor_distance(index, centers)
        score, breakdown = quality_score(
            meta["confidence"],
            meta["pixelBounds"],
            page_width,
            page_height,
            nearest_distance,
        )
        sentence = sentence_index[meta["id"]]
        sentence["pixelBox"] = {key: round(value, 2) for key, value in meta["pixelBounds"].items()}
        sentence["ocrConfidence"] = round(meta["confidence"], 4)
        sentence["qualityScore"] = round(score, 4)
        sentence["scoreBreakdown"] = breakdown
        sentence["flags"] = geometry_flags(meta["pixelBounds"], page_width, page_height)
        if nearest_distance is not None and nearest_distance > ISOLATION_REFERENCE_PX:
            sentence["flags"] = [*sentence["flags"], "isolated"]
        sentence_scores.append(score)

    return {
        "sourceImage": page_path.name,
        "imageSize": {
            "width": page_width,
            "height": page_height,
        },
        "qualitySummary": {
            "sentenceCount": len(sentences),
            "averageSentenceQualityScore": round(sum(sentence_scores) / len(sentence_scores), 4)
            if sentence_scores
            else None,
            "averageSentenceOcrConfidence": round(
                sum(meta["confidence"] for meta in kept_sentence_meta) / len(kept_sentence_meta), 4
            )
            if kept_sentence_meta
            else None,
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

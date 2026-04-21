#!/usr/bin/env python3

from __future__ import annotations

import json
import os
import subprocess
import sys
from copy import deepcopy
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Optional
from urllib.parse import urlparse

from chapter_artifact_rebuild import rebuild_chapter_artifacts


ROOT = Path(__file__).resolve().parents[1]
CHAPTERS_ROOT = ROOT / "data" / "processed" / "chapters"
ANNOTATIONS_ROOT = ROOT / "data" / "processed" / "annotations"
PAGES_ROOT = ROOT / "data" / "processed" / "pages"
REVIEW_ROOT = ROOT / "data" / "review"
TMP_ROOT = ROOT / "tmp" / "ocr-patches"
PADDLEX_CACHE_ROOT = ROOT / "tmp" / "paddlex-cache"
VENV_PYTHON = ROOT / ".venv" / "bin" / "python"
PYTHON_BIN = VENV_PYTHON if VENV_PYTHON.exists() else Path(sys.executable)

PATCH_OCR = None


def ensure_runtime_python() -> None:
    if not VENV_PYTHON.exists():
        return

    current_python = Path(sys.executable).resolve()
    target_python = VENV_PYTHON.resolve()
    if current_python == target_python:
        return

    os.execv(str(target_python), [str(target_python), str(Path(__file__).resolve()), *sys.argv[1:]])


def resolve_annotation_path(relative_path: str) -> Optional[Path]:
    candidate = (ROOT / relative_path).resolve()
    if not candidate.is_file():
        return None
    try:
        candidate.relative_to(ANNOTATIONS_ROOT.resolve())
    except ValueError:
        return None
    return candidate


def resolve_repo_path(root: Path, *parts: str) -> Optional[Path]:
    candidate = root.joinpath(*parts).resolve()
    try:
        candidate.relative_to(root.resolve())
    except ValueError:
        return None
    return candidate


def chapter_manifest_path(series: str, chapter: str) -> Optional[Path]:
    return resolve_repo_path(CHAPTERS_ROOT, series, f"{chapter}.json")


def chapter_model_path(series: str, chapter: str, model_name: str) -> Optional[Path]:
    return resolve_repo_path(ANNOTATIONS_ROOT, series, chapter, f"{model_name}.json")


def load_json_file(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def chapter_title(series: str, chapter: str, manifest: dict) -> str:
    return str(manifest.get("title") or f"{series} / {chapter}")


def list_chapters() -> list[dict]:
    chapters = []
    for manifest_file in sorted(CHAPTERS_ROOT.glob("*/*.json")):
        try:
            relative = manifest_file.relative_to(CHAPTERS_ROOT)
        except ValueError:
            continue
        if len(relative.parts) != 2:
            continue

        series = relative.parts[0]
        chapter = manifest_file.stem
        manifest = load_json_file(manifest_file)
        read_model = chapter_model_path(series, chapter, "read-model")
        refine_model = chapter_model_path(series, chapter, "refine-model")
        chapters.append(
            {
                "series": series,
                "chapter": chapter,
                "title": chapter_title(series, chapter, manifest),
                "hasReadModel": bool(read_model and read_model.is_file()),
                "hasRefineData": bool(refine_model and refine_model.is_file()),
            }
        )

    return sorted(chapters, key=lambda item: (item["series"], item["chapter"]))


def annotation_location(annotation_path: Path) -> tuple[str, str, str] | None:
    try:
        relative = annotation_path.resolve().relative_to(ANNOTATIONS_ROOT.resolve())
    except ValueError:
        return None

    if len(relative.parts) != 3:
        return None

    series, chapter, filename = relative.parts
    return series, chapter, Path(filename).stem


def resolve_page_image_path(relative_path: str) -> Optional[Path]:
    candidate = (ROOT / relative_path).resolve()
    if not candidate.is_file():
        return None
    try:
        candidate.relative_to(PAGES_ROOT.resolve())
    except ValueError:
        return None
    return candidate


def json_response(handler: SimpleHTTPRequestHandler, status: HTTPStatus, payload: dict) -> None:
    response = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    handler.send_response(status)
    handler.send_header("Content-Type", "application/json; charset=utf-8")
    handler.send_header("Content-Length", str(len(response)))
    handler.end_headers()
    handler.wfile.write(response)


def set_sentence_status(annotation: dict, sentence_id: str, status: str) -> tuple[dict, bool]:
    updated_sentences = []
    found = False
    for sentence in annotation.get("sentences", []):
        next_sentence = dict(sentence)
        if next_sentence.get("id") == sentence_id:
            next_sentence["status"] = status
            found = True
        elif not next_sentence.get("status"):
            next_sentence["status"] = "active"
        updated_sentences.append(next_sentence)

    updated_annotation = dict(annotation)
    updated_annotation["sentences"] = updated_sentences
    return updated_annotation, found


def compact_text(text: str) -> str:
    return "".join(character for character in text if not character.isspace())


def next_patch_id(patches: list[dict]) -> str:
    highest = 0
    for patch in patches:
        patch_id = str(patch.get("patch_id", ""))
        if not patch_id.startswith("patch-"):
            continue
        try:
            highest = max(highest, int(patch_id.split("-", 1)[1]))
        except ValueError:
            continue
    return f"patch-{highest + 1:04d}"


def normalize_patch_payload(patch: dict, patches: list[dict]) -> dict:
    normalized = deepcopy(patch)
    normalized["patch_id"] = normalized.get("patch_id") or next_patch_id(patches)
    normalized["kind"] = "missing_region"
    normalized.setdefault("region", {}).setdefault("polygon", [])
    normalized.setdefault("text_flow", {}).setdefault("guide", [])
    normalized["text_flow"].setdefault("mode", "vertical_rl")
    normalized.setdefault("ocr_candidate", "")
    normalized.setdefault("user_transcript", "")
    normalized.setdefault("notes", "")
    normalized.setdefault("anchor", {})
    normalized["anchor"].setdefault("insert_after_sentence_id", None)
    normalized["anchor"].setdefault("insert_before_sentence_id", None)
    return normalized


def crop_bounds_from_polygon(polygon: list[dict], image_width: int, image_height: int) -> tuple[int, int, int, int]:
    xs = [point["x"] for point in polygon]
    ys = [point["y"] for point in polygon]
    min_x = max(0.0, min(xs))
    max_x = min(1.0, max(xs))
    min_y = max(0.0, min(ys))
    max_y = min(1.0, max(ys))

    source_x = max(0, int(min_x * image_width))
    source_y = max(0, int((1.0 - max_y) * image_height))
    source_width = max(1, int(round((max_x - min_x) * image_width)))
    source_height = max(1, int(round((max_y - min_y) * image_height)))
    return source_x, source_y, source_width, source_height


def get_patch_ocr():
    global PATCH_OCR
    if PATCH_OCR is not None:
        return PATCH_OCR

    PADDLEX_CACHE_ROOT.mkdir(parents=True, exist_ok=True)
    os.environ.setdefault("PADDLE_PDX_CACHE_HOME", str(PADDLEX_CACHE_ROOT))
    os.environ.setdefault("PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK", "True")

    from paddleocr import PaddleOCR

    PATCH_OCR = PaddleOCR(
        lang="ch",
        text_detection_model_name="PP-OCRv5_mobile_det",
        text_recognition_model_name="PP-OCRv5_mobile_rec",
        use_doc_orientation_classify=False,
        use_doc_unwarping=False,
        use_textline_orientation=False,
        text_det_limit_side_len=2500,
    )
    return PATCH_OCR


def best_text_from_ocr_result(result: dict) -> tuple[str, float]:
    rec_texts = result.get("rec_texts", [])
    rec_scores = result.get("rec_scores", [])
    parts = [str(text).strip() for text in rec_texts if str(text).strip()]
    text = compact_text("".join(parts))
    if not text:
        return "", 0.0
    score = sum(float(score) for score in rec_scores[: len(parts)]) / max(len(parts), 1)
    return text, float(score)


def rotated_variants(image, flow_mode: str):
    import cv2

    variants = [("original", image)]
    if flow_mode.startswith("vertical"):
        variants.extend(
            [
                ("rotate_cw", cv2.rotate(image, cv2.ROTATE_90_CLOCKWISE)),
                ("rotate_ccw", cv2.rotate(image, cv2.ROTATE_90_COUNTERCLOCKWISE)),
            ]
        )
    else:
        variants.append(("rotate_180", cv2.rotate(image, cv2.ROTATE_180)))
    return variants


def transcribe_patch_region(page_image_path: Path, patch: dict) -> dict:
    import cv2

    image = cv2.imread(str(page_image_path))
    if image is None:
        raise RuntimeError(f"Unable to read page image: {page_image_path}")

    height, width = image.shape[:2]
    source_x, source_y, source_width, source_height = crop_bounds_from_polygon(
        patch.get("region", {}).get("polygon", []),
        width,
        height,
    )
    crop = image[source_y : source_y + source_height, source_x : source_x + source_width]
    if crop.size == 0:
        raise RuntimeError("Selected patch region produced an empty crop.")

    ocr = get_patch_ocr()
    best_text = ""
    best_score = -1.0
    best_variant = "original"
    for variant_name, variant_image in rotated_variants(crop, patch.get("text_flow", {}).get("mode", "vertical_rl")):
        try:
            results = list(ocr.predict(variant_image, return_word_box=True))
        except Exception:
            continue
        if not results:
            continue
        text, score = best_text_from_ocr_result(results[0])
        weighted_score = score * max(len(text), 1)
        if text and weighted_score > best_score:
            best_text = text
            best_score = weighted_score
            best_variant = variant_name

    return {
        "text": best_text,
        "variant": best_variant,
        "bounds": {
            "x": source_x,
            "y": source_y,
            "width": source_width,
            "height": source_height,
        },
    }


def review_file_path(series: str, chapter: str) -> Path:
    return REVIEW_ROOT / series / chapter / "patches.json"


def run_command(command: list[str], *, input_text: Optional[str] = None) -> subprocess.CompletedProcess:
    return subprocess.run(
        command,
        cwd=ROOT,
        input=input_text,
        text=True,
        capture_output=True,
        check=False,
    )


def ensure_success(result: subprocess.CompletedProcess, step_name: str) -> None:
    if result.returncode == 0:
        return
    raise RuntimeError(f"{step_name} failed.\nSTDOUT:\n{result.stdout}\nSTDERR:\n{result.stderr}")
def process_patch_pipeline(payload: dict) -> dict:
    series = str(payload.get("series", "")).strip()
    chapter = str(payload.get("chapter", "")).strip()
    patch = payload.get("patch")
    all_patches = payload.get("patches") or []
    page_image_path = resolve_page_image_path(str(payload.get("imagePath", "")))
    if not series or not chapter or not isinstance(patch, dict) or page_image_path is None:
        raise ValueError("series, chapter, patch, and a valid imagePath are required.")

    normalized_patch = normalize_patch_payload(patch, all_patches)
    merged_patches = [deepcopy(item) for item in all_patches if item.get("patch_id") != normalized_patch["patch_id"]]
    transcription = transcribe_patch_region(page_image_path, normalized_patch)
    normalized_patch["ocr_candidate"] = transcription["text"]
    if not compact_text(str(normalized_patch.get("user_transcript", ""))):
        normalized_patch["user_transcript"] = transcription["text"]
    if not compact_text(str(normalized_patch.get("user_transcript", ""))):
        raise RuntimeError("Focused OCR did not produce a transcript. Edit the transcript manually and try again.")
    merged_patches.append(normalized_patch)

    review_payload = {
        "series": series,
        "chapter": chapter,
        "patches": merged_patches,
    }
    master_review_path = review_file_path(series, chapter)
    master_review_path.parent.mkdir(parents=True, exist_ok=True)
    master_review_path.write_text(json.dumps(review_payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    TMP_ROOT.mkdir(parents=True, exist_ok=True)
    patch_tmp_dir = TMP_ROOT / series / chapter / normalized_patch["patch_id"]
    patch_tmp_dir.mkdir(parents=True, exist_ok=True)
    single_patch_review_path = patch_tmp_dir / "patches.json"
    single_patch_review_path.write_text(
        json.dumps({"series": series, "chapter": chapter, "patches": [normalized_patch]}, ensure_ascii=False, indent=2)
        + "\n",
        encoding="utf-8",
    )

    prompt_path = patch_tmp_dir / "prompt.json"
    schema_path = patch_tmp_dir / "schema.json"
    output_path = patch_tmp_dir / "output.json"

    prompt_result = run_command(
        [
            str(PYTHON_BIN),
            "scripts/build_codex_patch_prompt.py",
            "--series",
            series,
            "--chapter",
            chapter,
            "--patches",
            str(single_patch_review_path),
        ]
    )
    ensure_success(prompt_result, "Build patch prompt")
    prompt_path.write_text(prompt_result.stdout, encoding="utf-8")

    schema_result = run_command([str(PYTHON_BIN), "scripts/validate_patch_output.py", "--schema"])
    ensure_success(schema_result, "Build patch schema")
    schema_path.write_text(schema_result.stdout, encoding="utf-8")

    codex_result = run_command(
        [
            "codex",
            "exec",
            "-m",
            "gpt-5.4",
            "--ephemeral",
            "--sandbox",
            "workspace-write",
            "--output-schema",
            str(schema_path),
            "-o",
            str(output_path),
            "-",
        ],
        input_text=prompt_result.stdout,
    )
    ensure_success(codex_result, "Run codex exec")

    validate_result = run_command(
        [str(PYTHON_BIN), "scripts/validate_patch_output.py", "--input", str(output_path)]
    )
    ensure_success(validate_result, "Validate patch output")

    apply_result = run_command(
        [
            str(PYTHON_BIN),
            "scripts/apply_annotation_patches.py",
            "--series",
            series,
            "--chapter",
            chapter,
            "--patches",
            str(single_patch_review_path),
            "--enrichment",
            str(output_path),
        ]
    )
    ensure_success(apply_result, "Apply patch output")
    rebuild_chapter_artifacts(series, chapter)

    patch_output = json.loads(output_path.read_text(encoding="utf-8"))
    patch_analysis = patch_output.get("patch_analyses", [{}])[0]

    return {
        "patch": normalized_patch,
        "patches": merged_patches,
        "ocr": transcription,
        "analysis": patch_analysis,
        "reviewPath": str(master_review_path.relative_to(ROOT)),
        "needsReload": True,
    }


class ReaderHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def do_GET(self):
        parsed = urlparse(self.path)
        if parsed.path == "/api/chapters":
            self.handle_list_chapters()
            return

        parts = [part for part in parsed.path.split("/") if part]
        if len(parts) == 5 and parts[0] == "api" and parts[1] == "chapters":
            series = parts[2]
            chapter = parts[3]
            mode = parts[4]
            if mode in {"read", "refine"}:
                self.handle_get_chapter_model(series, chapter, mode)
                return

        super().do_GET()

    def do_POST(self):
        parsed = urlparse(self.path)

        content_length = int(self.headers.get("Content-Length", "0"))
        raw_body = self.rfile.read(content_length)
        try:
            payload = json.loads(raw_body.decode("utf-8"))
        except json.JSONDecodeError:
            self.send_error(HTTPStatus.BAD_REQUEST, "Invalid JSON body")
            return

        if parsed.path == "/api/delete-sentence":
            self.handle_set_sentence_status(payload, "deleted")
            return
        if parsed.path == "/api/restore-sentence":
            self.handle_set_sentence_status(payload, "active")
            return
        if parsed.path == "/api/process-patch":
            self.handle_process_patch(payload)
            return

        self.send_error(HTTPStatus.NOT_FOUND, "Unknown API endpoint")

    def handle_list_chapters(self) -> None:
        try:
            chapters = list_chapters()
        except Exception as error:  # noqa: BLE001
            json_response(self, HTTPStatus.INTERNAL_SERVER_ERROR, {"error": str(error)})
            return

        json_response(self, HTTPStatus.OK, {"chapters": chapters})

    def handle_get_chapter_model(self, series: str, chapter: str, mode: str) -> None:
        manifest_path = chapter_manifest_path(series, chapter)
        if manifest_path is None:
            self.send_error(HTTPStatus.BAD_REQUEST, "Invalid chapter path")
            return
        if not manifest_path.is_file():
            self.send_error(HTTPStatus.NOT_FOUND, f"Unknown chapter: {series}/{chapter}")
            return

        model_name = "read-model" if mode == "read" else "refine-model"
        model_path = chapter_model_path(series, chapter, model_name)
        if model_path is None:
            self.send_error(HTTPStatus.BAD_REQUEST, "Invalid chapter path")
            return
        if not model_path.is_file():
            self.send_error(HTTPStatus.NOT_FOUND, f"Missing {model_name}.json for {series}/{chapter}")
            return

        try:
            payload = load_json_file(model_path)
        except Exception as error:  # noqa: BLE001
            json_response(self, HTTPStatus.INTERNAL_SERVER_ERROR, {"error": str(error)})
            return

        json_response(self, HTTPStatus.OK, payload)

    def handle_set_sentence_status(self, payload: dict, status: str) -> None:
        annotation_path = resolve_annotation_path(str(payload.get("annotationPath", "")))
        sentence_id = str(payload.get("sentenceId", "")).strip()
        if annotation_path is None or not sentence_id:
            self.send_error(HTTPStatus.BAD_REQUEST, "annotationPath and sentenceId are required")
            return

        location = annotation_location(annotation_path)
        if location is None:
            self.send_error(HTTPStatus.BAD_REQUEST, "annotationPath must resolve under processed annotations")
            return
        series, chapter, _page_id = location

        annotation = json.loads(annotation_path.read_text(encoding="utf-8"))
        updated_annotation, found = set_sentence_status(annotation, sentence_id, status)
        if not found:
            self.send_error(HTTPStatus.NOT_FOUND, f"Unknown sentenceId: {sentence_id}")
            return
        annotation_path.write_text(
            json.dumps(updated_annotation, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )
        rebuild_chapter_artifacts(series, chapter)
        json_response(
            self,
            HTTPStatus.OK,
            {
                "ok": True,
                "sentenceId": sentence_id,
                "status": status,
                "annotation": updated_annotation,
            },
        )

    def handle_process_patch(self, payload: dict) -> None:
        try:
            result = process_patch_pipeline(payload)
        except ValueError as error:
            self.send_error(HTTPStatus.BAD_REQUEST, str(error))
            return
        except Exception as error:  # noqa: BLE001
            json_response(self, HTTPStatus.INTERNAL_SERVER_ERROR, {"error": str(error)})
            return

        json_response(self, HTTPStatus.OK, result)


def main():
    ensure_runtime_python()
    server = ThreadingHTTPServer(("127.0.0.1", 8000), ReaderHandler)
    print("Serving reader at http://127.0.0.1:8000/reader/")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()

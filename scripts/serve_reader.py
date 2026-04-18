#!/usr/bin/env python3

import json
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Optional
from urllib.parse import urlparse


ROOT = Path(__file__).resolve().parents[1]
ANNOTATIONS_ROOT = ROOT / "data" / "processed" / "annotations"


def resolve_annotation_path(relative_path: str) -> Optional[Path]:
    candidate = (ROOT / relative_path).resolve()
    if not candidate.is_file():
        return None
    try:
        candidate.relative_to(ANNOTATIONS_ROOT.resolve())
    except ValueError:
        return None
    return candidate


def delete_sentence(annotation: dict, sentence_id: str) -> dict:
    kept_sentences = [
        sentence for sentence in annotation.get("sentences", []) if sentence.get("id") != sentence_id
    ]
    kept_sentence_ids = {sentence.get("id") for sentence in kept_sentences}

    kept_characters = [
        character
        for character in annotation.get("characters", [])
        if character.get("sentenceId") in kept_sentence_ids
    ]
    kept_character_ids = {character.get("id") for character in kept_characters}

    kept_words = []
    for word in annotation.get("words", []):
      character_ids = word.get("characterIds") or []
      if any(character_id in kept_character_ids for character_id in character_ids):
          kept_words.append(word)

    updated_annotation = dict(annotation)
    updated_annotation["sentences"] = kept_sentences
    updated_annotation["characters"] = kept_characters
    updated_annotation["words"] = kept_words
    return updated_annotation


class ReaderHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def do_POST(self):
        parsed = urlparse(self.path)
        if parsed.path != "/api/delete-sentence":
            self.send_error(HTTPStatus.NOT_FOUND, "Unknown API endpoint")
            return

        content_length = int(self.headers.get("Content-Length", "0"))
        raw_body = self.rfile.read(content_length)
        try:
            payload = json.loads(raw_body.decode("utf-8"))
        except json.JSONDecodeError:
            self.send_error(HTTPStatus.BAD_REQUEST, "Invalid JSON body")
            return

        annotation_path = resolve_annotation_path(str(payload.get("annotationPath", "")))
        sentence_id = str(payload.get("sentenceId", "")).strip()
        if annotation_path is None or not sentence_id:
            self.send_error(HTTPStatus.BAD_REQUEST, "annotationPath and sentenceId are required")
            return

        annotation = json.loads(annotation_path.read_text(encoding="utf-8"))
        updated_annotation = delete_sentence(annotation, sentence_id)
        annotation_path.write_text(
            json.dumps(updated_annotation, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )

        response = json.dumps(updated_annotation, ensure_ascii=False).encode("utf-8")
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(response)))
        self.end_headers()
        self.wfile.write(response)


def main():
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

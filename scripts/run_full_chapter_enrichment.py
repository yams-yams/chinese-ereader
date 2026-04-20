#!/usr/bin/env python3

from __future__ import annotations

import argparse
import json
import subprocess
import sys
import threading
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from build_codex_full_chapter_prompt import DEVELOPER_PROMPT, build_chapter_payload
from enrichment_schema import ChapterEnrichment, strict_json_schema
from validate_full_chapter_output import validate_text


ROOT = Path(__file__).resolve().parents[1]
TMP_ROOT = ROOT / "tmp"
TRANSLATED_ROOT = ROOT / "data" / "translated"
RUN_LOG_PATH = TRANSLATED_ROOT / "logs" / "full-chapter-enrichment-runs.jsonl"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Run logged full-chapter Codex enrichment.")
    parser.add_argument("--series", required=True)
    parser.add_argument("--chapter", required=True)
    parser.add_argument("--model", default="gpt-5.4")
    parser.add_argument("--codex-bin", default="codex")
    parser.add_argument("--sandbox", default="read-only")
    parser.add_argument(
        "--output",
        help="Override the deterministic output path.",
    )
    parser.add_argument(
        "--log-path",
        default=str(RUN_LOG_PATH),
        help="Path to the JSONL run log.",
    )
    parser.add_argument(
        "--keep-events",
        action="store_true",
        help="Deprecated: event JSONL is now always persisted under tmp/ for observability.",
    )
    parser.add_argument(
        "--skip-validation",
        action="store_true",
        help="Skip post-run schema validation of the saved output.",
    )
    return parser.parse_args()


def deterministic_output_path(series: str, chapter: str) -> Path:
    return TRANSLATED_ROOT / series / chapter / "full-chapter-enrichment.json"


def timestamp_slug(now: datetime) -> str:
    return now.strftime("%Y%m%dT%H%M%SZ")


def ensure_parent(path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)


def resolve_repo_path(path: Path) -> Path:
    if path.is_absolute():
        return path
    return ROOT / path


def display_path(path: Path) -> str:
    resolved = resolve_repo_path(path)
    if resolved.is_relative_to(ROOT):
        return str(resolved.relative_to(ROOT))
    return str(resolved)


def write_json(path: Path, payload: Any) -> None:
    ensure_parent(path)
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def build_prompt_payload(series: str, chapter: str) -> dict[str, Any]:
    payload = build_chapter_payload(series, chapter)
    schema = strict_json_schema(ChapterEnrichment)
    return {
        "instructions": DEVELOPER_PROMPT
        + "\nBefore finalizing, verify that your output is valid JSON matching the provided schema exactly. Return only the JSON object and no commentary.",
        "output_schema": schema,
        "input_payload": payload,
    }


def extract_token_usage(events_text: str) -> dict[str, Any] | str:
    if not events_text.strip():
        return "unknown"

    usage_candidates: list[dict[str, Any]] = []
    for line in events_text.splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            event = json.loads(line)
        except json.JSONDecodeError:
            continue
        usage_candidates.extend(find_usage_objects(event))

    if not usage_candidates:
        return "unknown"

    best = usage_candidates[-1]
    normalized: dict[str, Any] = {}
    for key in ("input_tokens", "output_tokens", "total_tokens", "prompt_tokens", "completion_tokens"):
        if key in best:
            normalized[key] = best[key]

    if not normalized:
        normalized = best
    return normalized


def find_usage_objects(node: Any) -> list[dict[str, Any]]:
    matches: list[dict[str, Any]] = []
    if isinstance(node, dict):
        if looks_like_usage(node):
            matches.append(node)
        for value in node.values():
            matches.extend(find_usage_objects(value))
    elif isinstance(node, list):
        for value in node:
            matches.extend(find_usage_objects(value))
    return matches


def looks_like_usage(node: dict[str, Any]) -> bool:
    usage_keys = {"input_tokens", "output_tokens", "total_tokens", "prompt_tokens", "completion_tokens"}
    return any(key in node for key in usage_keys)


def build_codex_command(args: argparse.Namespace, schema_path: Path, output_path: Path) -> list[str]:
    return [
        args.codex_bin,
        "exec",
        "-m",
        args.model,
        "--ephemeral",
        "--sandbox",
        args.sandbox,
        "--output-schema",
        str(schema_path),
        "--json",
        "-o",
        str(output_path),
        "-",
    ]


def append_run_log(log_path: Path, entry: dict[str, Any]) -> None:
    ensure_parent(log_path)
    with log_path.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(entry, ensure_ascii=False) + "\n")


def append_text(path: Path, text: str) -> None:
    ensure_parent(path)
    with path.open("a", encoding="utf-8") as handle:
        handle.write(text)


def validate_saved_output(output_path: Path) -> dict[str, Any]:
    raw_text = output_path.read_text(encoding="utf-8")
    validated = validate_text(raw_text)
    return {
        "series": validated.series,
        "chapter": validated.chapter,
        "sentence_count": len(validated.sentence_analyses),
        "chapter_notes_count": len(validated.chapter_notes),
    }


def summarize_event(event: dict[str, Any]) -> str | None:
    event_type = event.get("type")
    if event_type == "thread.started":
        return f"[codex] thread started: {event.get('thread_id', 'unknown')}"
    if event_type == "turn.started":
        return "[codex] turn started"
    if event_type == "turn.completed":
        usage = event.get("usage")
        if usage:
            return f"[codex] turn completed with usage {json.dumps(usage, ensure_ascii=False)}"
        return "[codex] turn completed"
    if event_type == "item.completed":
        item = event.get("item", {})
        item_type = item.get("type", "unknown")
        item_id = item.get("id", "unknown")
        return f"[codex] item completed: {item_type} ({item_id})"
    if event_type == "error":
        return f"[codex] error event: {json.dumps(event, ensure_ascii=False)}"
    return None


def stream_codex_process(
    command: list[str],
    prompt_text: str,
    events_path: Path,
    stderr_path: Path,
) -> tuple[int, str, str]:
    ensure_parent(events_path)
    ensure_parent(stderr_path)
    events_path.write_text("", encoding="utf-8")
    stderr_path.write_text("", encoding="utf-8")

    process = subprocess.Popen(
        command,
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        cwd=ROOT,
        bufsize=1,
    )

    assert process.stdin is not None
    assert process.stdout is not None
    assert process.stderr is not None

    stdout_lines: list[str] = []
    stderr_lines: list[str] = []

    def write_prompt() -> None:
        try:
            process.stdin.write(prompt_text)
            process.stdin.close()
        except BrokenPipeError:
            pass

    def read_stdout() -> None:
        for line in process.stdout:
            stdout_lines.append(line)
            append_text(events_path, line)
            stripped = line.strip()
            if not stripped:
                continue
            try:
                event = json.loads(stripped)
            except json.JSONDecodeError:
                print(f"[codex] raw stdout: {stripped}", file=sys.stderr)
                continue
            summary = summarize_event(event)
            if summary:
                print(summary, file=sys.stderr)

    def read_stderr() -> None:
        for line in process.stderr:
            stderr_lines.append(line)
            append_text(stderr_path, line)
            print(f"[codex-stderr] {line.rstrip()}", file=sys.stderr)

    input_thread = threading.Thread(target=write_prompt, daemon=True)
    stdout_thread = threading.Thread(target=read_stdout, daemon=True)
    stderr_thread = threading.Thread(target=read_stderr, daemon=True)

    input_thread.start()
    stdout_thread.start()
    stderr_thread.start()

    return_code = process.wait()
    input_thread.join()
    stdout_thread.join()
    stderr_thread.join()

    return return_code, "".join(stdout_lines), "".join(stderr_lines)


def main() -> None:
    args = parse_args()
    started_at = datetime.now(timezone.utc)
    output_path = resolve_repo_path(Path(args.output)) if args.output else deterministic_output_path(args.series, args.chapter)
    log_path = resolve_repo_path(Path(args.log_path))

    stamp = timestamp_slug(started_at)
    prompt_path = TMP_ROOT / args.series / args.chapter / f"{stamp}-codex-full-chapter-prompt.json"
    schema_path = TMP_ROOT / args.series / args.chapter / f"{stamp}-chapter-enrichment-schema.json"
    events_path = TMP_ROOT / args.series / args.chapter / f"{stamp}-codex-events.jsonl"
    stderr_path = TMP_ROOT / args.series / args.chapter / f"{stamp}-codex-stderr.log"

    prompt_payload = build_prompt_payload(args.series, args.chapter)
    write_json(prompt_path, prompt_payload)
    write_json(schema_path, prompt_payload["output_schema"])
    ensure_parent(output_path)

    command = build_codex_command(args, schema_path, output_path)
    prompt_text = json.dumps(prompt_payload, ensure_ascii=False, indent=2) + "\n"

    run_record: dict[str, Any] = {
        "timestamp": started_at.isoformat().replace("+00:00", "Z"),
        "series": args.series,
        "chapter": args.chapter,
        "model": args.model,
        "command": command,
        "prompt_path": display_path(prompt_path),
        "schema_path": display_path(schema_path),
        "events_path": display_path(events_path),
        "stderr_path": display_path(stderr_path),
        "output_path": display_path(output_path),
        "log_path": display_path(log_path),
        "status": "running",
    }
    append_run_log(log_path, run_record)
    print(
        f"[runner] started chapter enrichment for {args.series}/{args.chapter} with model {args.model}",
        file=sys.stderr,
    )
    print(f"[runner] output: {display_path(output_path)}", file=sys.stderr)
    print(f"[runner] events: {display_path(events_path)}", file=sys.stderr)
    print(f"[runner] stderr: {display_path(stderr_path)}", file=sys.stderr)

    start_perf = time.perf_counter()
    try:
        return_code, events_text, stderr_text = stream_codex_process(
            command,
            prompt_text,
            events_path,
            stderr_path,
        )
    except OSError as error:
        duration_seconds = round(time.perf_counter() - start_perf, 3)
        run_record.update(
            {
                "duration_seconds": duration_seconds,
                "exit_code": None,
                "stderr": str(error),
                "token_usage": "unknown",
                "status": "runner_invocation_failed",
            }
        )
        append_run_log(log_path, run_record)
        print(json.dumps(run_record, ensure_ascii=False, indent=2), file=sys.stderr)
        raise SystemExit(1)

    duration_seconds = round(time.perf_counter() - start_perf, 3)

    run_record.update(
        {
            "duration_seconds": duration_seconds,
            "exit_code": return_code,
            "stderr": stderr_text.strip(),
            "token_usage": extract_token_usage(events_text),
        }
    )

    if return_code != 0:
        run_record["status"] = "codex_exec_failed"
        append_run_log(log_path, run_record)
        print(json.dumps(run_record, ensure_ascii=False, indent=2), file=sys.stderr)
        raise SystemExit(return_code)

    if not output_path.exists():
        run_record["status"] = "missing_output_file"
        append_run_log(log_path, run_record)
        print(json.dumps(run_record, ensure_ascii=False, indent=2), file=sys.stderr)
        raise SystemExit(1)

    if args.skip_validation:
        run_record["status"] = "ok_unvalidated"
        append_run_log(log_path, run_record)
        print(json.dumps(run_record, ensure_ascii=False, indent=2))
        return

    try:
        validation_summary = validate_saved_output(output_path)
    except ValueError as error:
        run_record["status"] = "validation_failed"
        run_record["validation_error"] = str(error)
        append_run_log(log_path, run_record)
        print(json.dumps(run_record, ensure_ascii=False, indent=2), file=sys.stderr)
        raise SystemExit(1)

    run_record["status"] = "ok"
    run_record["validation"] = validation_summary
    append_run_log(log_path, run_record)
    print(json.dumps(run_record, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()

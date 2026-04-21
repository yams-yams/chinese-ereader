from __future__ import annotations

import subprocess
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
TRANSLATED_ROOT = ROOT / "data" / "translated"
VENV_PYTHON = ROOT / ".venv" / "bin" / "python"
PYTHON_BIN = VENV_PYTHON if VENV_PYTHON.exists() else Path(sys.executable)


def canonical_enrichment_path(series: str, chapter: str) -> Path:
    return TRANSLATED_ROOT / series / chapter / "full-chapter-enrichment.json"


def resolve_default_enrichment_path(series: str, chapter: str) -> Path:
    return canonical_enrichment_path(series, chapter)


def rebuild_chapter_artifacts(series: str, chapter: str) -> None:
    command = [
        str(PYTHON_BIN),
        "scripts/build_chapter_artifacts.py",
        "--series",
        series,
        "--chapter",
        chapter,
    ]
    result = subprocess.run(
        command,
        cwd=ROOT,
        capture_output=True,
        text=True,
        check=False,
    )
    if result.returncode == 0:
        return
    raise RuntimeError(
        "Rebuild chapter artifacts failed.\n"
        f"STDOUT:\n{result.stdout}\n"
        f"STDERR:\n{result.stderr}"
    )

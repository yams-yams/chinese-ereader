#!/usr/bin/env bash

codex exec -m gpt-5.4 --ephemeral --sandbox read-only --output-schema tmp/chapter_enrichment_schema.json -o tmp/codex-full-chapter-response-lite.json - < tmp/codex-full-chapter-prompt-lite.txt

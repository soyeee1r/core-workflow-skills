#!/usr/bin/env python3
"""Validate personal-work scheduled-run capture and final delivery."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path


PAIRS = (
    ("chats_expected", "chats_scanned"),
    ("threads_expected", "threads_expanded"),
    ("reports_expected", "reports_resolved"),
    ("calendar_expected", "calendar_resolved"),
)
REQUIRED_SOURCE_KINDS = {"weekly_report", "messages", "project_facts", "calendar"}


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("receipt", type=Path)
    parser.add_argument("--phase", choices=("preflight", "final"), required=True)
    args = parser.parse_args()
    try:
        data = json.loads(args.receipt.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        print(f"INVALID: cannot read receipt: {exc}", file=sys.stderr)
        return 2

    errors: list[str] = []
    if data.get("schema_version") != 1:
        errors.append("schema_version must be 1")
    if data.get("status") not in {"ready", "delivered"}:
        errors.append("status must be ready or delivered")
    if not data.get("corrections_read"):
        errors.append("corrections_read must contain at least one active correction id")

    sources = data.get("sources", [])
    kinds = {source.get("kind") for source in sources}
    for kind in sorted(REQUIRED_SOURCE_KINDS - kinds):
        errors.append(f"missing required source kind: {kind}")
    for source in sources:
        allowed = {"complete", "not_applicable"}
        if source.get("allow_missing"):
            allowed.add("resolved_missing")
        if source.get("required") and source.get("status") not in allowed:
            errors.append(f"required source incomplete: {source.get('name', '<unnamed>')}")
        if source.get("required") and source.get("pagination_complete") is False:
            errors.append(f"pagination incomplete: {source.get('name', '<unnamed>')}")
        if source.get("status") == "resolved_missing" and not source.get("reason"):
            errors.append(f"resolved-missing source lacks reason: {source.get('name', '<unnamed>')}")

    coverage = data.get("coverage", {})
    for expected, actual in PAIRS:
        if not isinstance(coverage.get(expected), int) or not isinstance(coverage.get(actual), int):
            errors.append(f"coverage values must be integers: {expected}, {actual}")
        elif coverage[expected] != coverage[actual]:
            errors.append(f"coverage mismatch: {expected}={coverage[expected]} {actual}={coverage[actual]}")

    unresolved = [item for item in data.get("tool_errors", []) if not item.get("resolved", False)]
    if unresolved:
        errors.append(f"unresolved tool errors: {len(unresolved)}")

    if args.phase == "final":
        if data.get("status") != "delivered":
            errors.append("final validation requires status=delivered")
        task = data.get("task")
        if task == "morning_panel":
            delivery = data.get("delivery", {})
            if delivery.get("status") != "sent" or not delivery.get("message_id"):
                errors.append("morning panel was not verifiably delivered")
        elif task in {"daily_report", "weekly_summary", "monthly_summary"}:
            writeback = data.get("writeback", {})
            if writeback.get("status") != "verified" or not writeback.get("readback_ok"):
                errors.append("report writeback was not verified")
        else:
            errors.append(f"unknown task for final validation: {task}")

    if errors:
        print("INVALID")
        for error in errors:
            print(f"- {error}")
        return 1
    print("VALID")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

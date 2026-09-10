#!/usr/bin/env python3
"""Validate and enrich a 2, 6, 24, or 48-hour content metric snapshot JSON document."""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any


REQUIRED_TEXT = (
    "publication_id",
    "project_id",
    "platform",
    "account_id",
    "published_at",
    "collected_at",
    "scheduled_window",
    "target_doc_url",
)

WINDOW_HOURS = {"2h": 2, "6h": 6, "24h": 24, "48h": 48}


def parse_datetime(value: str, field: str) -> datetime:
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as exc:
        raise ValueError(f"{field} must be an ISO-8601 datetime") from exc
    if parsed.tzinfo is None or parsed.utcoffset() is None:
        raise ValueError(f"{field} must include a timezone offset")
    return parsed


def validate_metric(metric: Any, index: int) -> str:
    if not isinstance(metric, dict):
        raise ValueError(f"metrics[{index}] must be an object")
    for field in ("name", "raw_label", "unit", "availability"):
        if not isinstance(metric.get(field), str) or not metric[field].strip():
            raise ValueError(f"metrics[{index}].{field} must be non-empty text")
    availability = metric["availability"]
    if availability not in {"available", "unavailable", "collection_failed"}:
        raise ValueError(f"metrics[{index}].availability is invalid")
    if availability == "available":
        value = metric.get("value")
        if not isinstance(value, (int, float)) or isinstance(value, bool):
            raise ValueError(f"metrics[{index}].value must be numeric when available")
        if value < 0:
            raise ValueError(f"metrics[{index}].value must be non-negative")
        if metric["unit"] == "ratio" and value > 1:
            raise ValueError(f"metrics[{index}].value must be between 0 and 1 for ratio")
    return metric["name"]


def validate(payload: Any) -> dict[str, Any]:
    if not isinstance(payload, dict):
        raise ValueError("snapshot root must be an object")
    for field in REQUIRED_TEXT:
        if not isinstance(payload.get(field), str) or not payload[field].strip():
            raise ValueError(f"{field} must be non-empty text")
    scheduled_window = payload["scheduled_window"]
    if scheduled_window not in WINDOW_HOURS:
        raise ValueError("scheduled_window must be 2h, 6h, 24h, or 48h")
    if not payload.get("content_id") and not payload.get("canonical_url"):
        raise ValueError("content_id or canonical_url is required")

    published_at = parse_datetime(payload["published_at"], "published_at")
    collected_at = parse_datetime(payload["collected_at"], "collected_at")
    window_hours = WINDOW_HOURS[scheduled_window]
    due_at = published_at + timedelta(hours=window_hours)
    if collected_at < due_at:
        early_minutes = (due_at - collected_at).total_seconds() / 60
        raise ValueError(
            f"collection is {early_minutes:.1f} minutes earlier than the {scheduled_window} due time"
        )

    source = payload.get("source")
    if not isinstance(source, dict) or source.get("method") not in {"api", "connector", "export", "browser"}:
        raise ValueError("source.method must be api, connector, export, or browser")
    evidence = source.get("evidence")
    if not isinstance(evidence, list) or not evidence or not all(isinstance(item, str) and item.strip() for item in evidence):
        raise ValueError("source.evidence must contain at least one evidence reference")

    metrics = payload.get("metrics")
    if not isinstance(metrics, list) or not metrics:
        raise ValueError("metrics must contain at least one metric")
    names = [validate_metric(metric, index) for index, metric in enumerate(metrics)]
    if len(set(names)) != len(names):
        raise ValueError("metric names must be unique within a snapshot")

    idempotency_key = f'{payload["publication_id"]}:{scheduled_window}'
    snapshot_id = "ms_" + hashlib.sha256(idempotency_key.encode("utf-8")).hexdigest()[:16]
    snapshot_age_hours = (collected_at - published_at).total_seconds() / 3600
    result = dict(payload)
    result.update(
        {
            "due_at": due_at.isoformat(),
            "snapshot_age_hours": round(snapshot_age_hours, 4),
            "timeliness": "on_time" if snapshot_age_hours <= window_hours + 6 else "late",
            "idempotency_key": idempotency_key,
            "metric_snapshot_id": snapshot_id,
        }
    )
    return result


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", required=True, type=Path, help="Input snapshot JSON file")
    parser.add_argument("--output", type=Path, help="Optional enriched JSON output file")
    args = parser.parse_args()

    try:
        payload = json.loads(args.input.read_text(encoding="utf-8"))
        result = validate(payload)
    except (OSError, json.JSONDecodeError, ValueError) as exc:
        print(f"INVALID: {exc}", file=sys.stderr)
        return 1

    rendered = json.dumps(result, ensure_ascii=False, indent=2) + "\n"
    if args.output:
        args.output.write_text(rendered, encoding="utf-8")
    else:
        print(rendered, end="")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

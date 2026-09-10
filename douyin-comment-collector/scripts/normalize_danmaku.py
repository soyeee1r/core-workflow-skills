#!/usr/bin/env python3
"""Normalize, deduplicate, sort, and export Douyin danmaku records."""

from __future__ import annotations

import argparse
import csv
import json
import re
import sys
from pathlib import Path
from typing import Any, Optional


CSV_FIELDS = [
    "danmaku_id", "text", "offset_ms", "offset_label", "like_count",
    "source_order", "video_id", "source_url", "collected_at", "dedupe_key",
]


def clean_text(value: Any) -> Optional[str]:
    if value is None:
        return None
    result = re.sub(r"\s+", " ", str(value)).strip()
    return result or None


def parse_int(value: Any) -> Optional[int]:
    if value is None or value == "":
        return None
    try:
        return int(float(value))
    except (TypeError, ValueError):
        return None


def first_present(record: dict[str, Any], *keys: str) -> Any:
    for key in keys:
        if record.get(key) is not None and record.get(key) != "":
            return record[key]
    return None


def format_offset(value: Optional[int]) -> Optional[str]:
    if value is None or value < 0:
        return None
    seconds = value // 1000
    hours, remainder = divmod(seconds, 3600)
    minutes, seconds = divmod(remainder, 60)
    return f"{hours:02d}:{minutes:02d}:{seconds:02d}" if hours else f"{minutes:02d}:{seconds:02d}"


def read_payload(path: str) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    raw = sys.stdin.read() if path == "-" else Path(path).read_text(encoding="utf-8-sig")
    payload = json.loads(raw)
    if not isinstance(payload, dict) or not isinstance(payload.get("collection"), dict):
        raise ValueError("input must contain a collection object")
    rows = payload.get("danmaku")
    if not isinstance(rows, list) or not all(isinstance(row, dict) for row in rows):
        raise ValueError("input must contain a danmaku array")
    return payload["collection"], rows


def write_json(path: Path, value: Any) -> None:
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", required=True, help="raw-danmaku.json path, or - for stdin")
    parser.add_argument("--output-dir", required=True, help="output directory")
    args = parser.parse_args()

    try:
        collection, raw_rows = read_payload(args.input)
        unique: dict[str, dict[str, Any]] = {}
        for index, raw in enumerate(raw_rows, start=1):
            text = clean_text(first_present(raw, "text", "content", "danmaku_text"))
            offset_ms = parse_int(first_present(raw, "offset_ms", "offset_time", "show_time"))
            danmaku_id = clean_text(first_present(raw, "danmaku_id", "id"))
            key = f"id:{danmaku_id}" if danmaku_id else f"time-text:{offset_ms}\x1f{text or ''}"
            row = {
                "danmaku_id": danmaku_id,
                "text": text,
                "offset_ms": offset_ms,
                "offset_label": format_offset(offset_ms),
                "like_count": parse_int(raw.get("like_count") if raw.get("like_count") is not None else raw.get("digg_count")),
                "source_order": parse_int(raw.get("source_order")) or index,
                "video_id": clean_text(collection.get("video_id")),
                "source_url": clean_text(collection.get("source_url")),
                "collected_at": clean_text(collection.get("collected_at")),
                "dedupe_key": key,
            }
            if key not in unique:
                unique[key] = row
            else:
                current = unique[key]
                if (row.get("like_count") or 0) > (current.get("like_count") or 0):
                    current["like_count"] = row["like_count"]

        rows = sorted(
            unique.values(),
            key=lambda row: (
                row["offset_ms"] is None,
                row["offset_ms"] if row["offset_ms"] is not None else 0,
                row["source_order"],
            ),
        )
        for index, row in enumerate(rows, start=1):
            row["source_order"] = index

        duration_ms = parse_int(collection.get("duration_ms"))
        summary = {
            "platform": "douyin",
            "video_id": collection.get("video_id"),
            "source_url": collection.get("source_url"),
            "source_title": collection.get("source_title"),
            "collected_at": collection.get("collected_at"),
            "status": collection.get("status", "unspecified"),
            "stop_reason": collection.get("stop_reason"),
            "duration_ms": duration_ms,
            "segment_ms": parse_int(collection.get("segment_ms")),
            "segment_count": parse_int(collection.get("segment_count")),
            "input_records": len(raw_rows),
            "output_records": len(rows),
            "duplicates_removed": len(raw_rows) - len(rows),
            "missing_text": sum(row["text"] is None for row in rows),
            "total_likes": sum(row["like_count"] or 0 for row in rows),
            "first_offset_ms": rows[0]["offset_ms"] if rows else None,
            "last_offset_ms": rows[-1]["offset_ms"] if rows else None,
        }
        output_dir = Path(args.output_dir)
        output_dir.mkdir(parents=True, exist_ok=True)
        write_json(output_dir / "danmaku.json", {"collection": collection, "danmaku": rows})
        write_json(output_dir / "summary.json", summary)
        with (output_dir / "danmaku.csv").open("w", encoding="utf-8-sig", newline="") as handle:
            writer = csv.DictWriter(handle, fieldnames=CSV_FIELDS, extrasaction="ignore")
            writer.writeheader()
            writer.writerows(rows)
        print(json.dumps(summary, ensure_ascii=False))
        return 0
    except (OSError, ValueError, json.JSONDecodeError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())

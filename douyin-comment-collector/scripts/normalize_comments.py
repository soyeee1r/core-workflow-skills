#!/usr/bin/env python3
"""Normalize, deduplicate, cap, and export Douyin comment records."""

from __future__ import annotations

import argparse
import csv
import hashlib
import json
import re
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional


CSV_FIELDS = [
    "comment_id", "parent_comment_id", "author_name", "author_profile_url",
    "text", "like_count", "reply_count", "created_at", "location_label",
    "is_reply", "is_pinned", "is_creator", "source_order", "video_id",
    "source_url", "collected_at", "dedupe_key",
]


def first(record: dict[str, Any], *keys: str) -> Any:
    for key in keys:
        value = record.get(key)
        if value is not None and value != "":
            return value
    return None


def clean_text(value: Any) -> Optional[str]:
    if value is None:
        return None
    value = re.sub(r"\s+", " ", str(value)).strip()
    return value or None


def clean_id(value: Any) -> Optional[str]:
    value = clean_text(value)
    return value if value and value.lower() not in {"none", "null"} else None


def parse_count(value: Any) -> Optional[int]:
    if value is None or value == "":
        return None
    if isinstance(value, bool):
        return int(value)
    if isinstance(value, (int, float)):
        return int(value)
    value = str(value).strip().lower().replace(",", "").replace("+", "")
    value = value.replace("点赞", "").replace("回复", "").strip()
    match = re.search(r"(-?\d+(?:\.\d+)?)\s*([万千wk]?)", value)
    if not match:
        return None
    multiplier = {"万": 10_000, "w": 10_000, "千": 1_000, "k": 1_000}.get(
        match.group(2), 1
    )
    return int(float(match.group(1)) * multiplier)


def parse_bool(value: Any) -> bool:
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return value != 0
    return str(value).strip().lower() in {"1", "true", "yes", "y", "是"}


def normalize_record(
    record: dict[str, Any], collection: dict[str, Any], fallback_order: int
) -> dict[str, Any]:
    author = record.get("author") if isinstance(record.get("author"), dict) else {}
    comment_id = clean_id(first(record, "comment_id", "commentId", "cid", "id"))
    parent_id = clean_id(first(
        record, "parent_comment_id", "parentCommentId", "parent_id", "reply_to_id", "reply_id"
    ))
    if parent_id == "0":
        parent_id = None
    author_name = clean_text(
        first(record, "author_name", "nickname", "user_name", "username")
        or first(author, "name", "nickname", "display_name")
    )
    text = clean_text(first(record, "text", "content", "comment", "body"))
    created_at = clean_text(first(record, "created_at", "create_time", "time", "date"))
    fingerprint = "\x1f".join([author_name or "", text or "", created_at or "", parent_id or ""])
    dedupe_key = (
        f"id:{comment_id}" if comment_id
        else "fp:" + hashlib.sha256(fingerprint.encode("utf-8")).hexdigest()
    )
    source_order = parse_count(first(record, "source_order", "order", "index"))
    is_reply = parse_bool(first(record, "is_reply", "isReply")) or parent_id is not None
    return {
        "comment_id": comment_id,
        "parent_comment_id": parent_id,
        "author_name": author_name,
        "author_profile_url": clean_text(
            first(record, "author_profile_url", "profile_url") or first(author, "profile_url", "url")
        ),
        "text": text,
        "like_count": parse_count(first(record, "like_count", "likes", "digg_count")),
        "reply_count": parse_count(first(record, "reply_count", "replies", "sub_comment_count")),
        "created_at": created_at,
        "location_label": clean_text(first(record, "location_label", "ip_location", "location")),
        "is_reply": is_reply,
        "is_pinned": parse_bool(first(record, "is_pinned", "pinned")),
        "is_creator": parse_bool(first(record, "is_creator", "creator", "is_author")),
        "source_order": source_order if source_order is not None else fallback_order,
        "video_id": clean_id(first(record, "video_id", "aweme_id") or collection.get("video_id")),
        "source_url": clean_text(record.get("source_url") or collection.get("source_url")),
        "collected_at": clean_text(record.get("collected_at") or collection.get("collected_at")),
        "dedupe_key": dedupe_key,
    }


def merge_richer(left: dict[str, Any], right: dict[str, Any]) -> dict[str, Any]:
    merged = dict(left)
    for key, value in right.items():
        if merged.get(key) in (None, "", False) and value not in (None, "", False):
            merged[key] = value
    merged["source_order"] = min(left["source_order"], right["source_order"])
    return merged


def load_input(path: str) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    raw = sys.stdin.read() if path == "-" else Path(path).read_text(encoding="utf-8-sig")
    if not raw.strip():
        raise ValueError("input is empty")
    try:
        payload = json.loads(raw)
    except json.JSONDecodeError:
        payload = [json.loads(line) for line in raw.splitlines() if line.strip()]

    if isinstance(payload, list):
        collection: dict[str, Any] = {}
        comments = payload
    elif isinstance(payload, dict):
        collection = payload.get("collection") or {}
        comments = payload.get("comments")
        if comments is None and any(key in payload for key in ("text", "content", "comment")):
            comments = [payload]
        if not isinstance(collection, dict):
            raise ValueError("collection must be an object")
    else:
        raise ValueError("input must be a JSON array, object, or JSONL")

    if not isinstance(comments, list) or not all(isinstance(item, dict) for item in comments):
        raise ValueError("comments must be an array of objects")
    return collection, comments


def write_json(path: Path, value: Any) -> None:
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", required=True, help="JSON/JSONL path, or - for stdin")
    parser.add_argument("--output-dir", required=True, help="Output directory")
    parser.add_argument("--limit", type=int, default=500, help="Hard output cap, maximum 500")
    args = parser.parse_args()

    try:
        if not 1 <= args.limit <= 500:
            raise ValueError("--limit must be between 1 and 500")
        collection, raw_comments = load_input(args.input)
        collection.setdefault("platform", "douyin")
        collection.setdefault("requested_limit", args.limit)
        collection.setdefault("collected_at", datetime.now(timezone.utc).isoformat())
        if collection.get("platform") != "douyin":
            raise ValueError("this skill only accepts Douyin data")

        unique: dict[str, dict[str, Any]] = {}
        for index, raw_comment in enumerate(raw_comments, start=1):
            item = normalize_record(raw_comment, collection, index)
            key = item["dedupe_key"]
            unique[key] = merge_richer(unique[key], item) if key in unique else item

        all_unique = sorted(unique.values(), key=lambda item: item["source_order"])
        comments = all_unique[: args.limit]
        truncated = len(all_unique) - len(comments)
        if truncated:
            collection["status"] = "limit_reached"
            collection["stop_reason"] = f"normalized output reached hard limit {args.limit}"

        summary = {
            "platform": "douyin",
            "video_id": collection.get("video_id"),
            "source_url": collection.get("source_url"),
            "collected_at": collection.get("collected_at"),
            "status": collection.get("status", "unspecified"),
            "stop_reason": collection.get("stop_reason"),
            "requested_limit": args.limit,
            "input_records": len(raw_comments),
            "unique_records_before_limit": len(all_unique),
            "output_records": len(comments),
            "duplicates_removed": len(raw_comments) - len(all_unique),
            "truncated_records": truncated,
            "top_level_comments": sum(not item["is_reply"] for item in comments),
            "replies": sum(item["is_reply"] for item in comments),
            "missing_text": sum(item["text"] is None for item in comments),
            "missing_author_name": sum(item["author_name"] is None for item in comments),
        }
        output = {
            "collection": collection,
            "comments": comments,
            "normalization": {
                "input_records": len(raw_comments),
                "duplicates_removed": summary["duplicates_removed"],
                "truncated_records": truncated,
                "dedupe": "comment_id, otherwise SHA-256 fingerprint",
            },
        }

        output_dir = Path(args.output_dir)
        output_dir.mkdir(parents=True, exist_ok=True)
        write_json(output_dir / "comments.json", output)
        write_json(output_dir / "summary.json", summary)
        with (output_dir / "comments.csv").open("w", encoding="utf-8-sig", newline="") as handle:
            writer = csv.DictWriter(handle, fieldnames=CSV_FIELDS, extrasaction="ignore")
            writer.writeheader()
            writer.writerows(comments)
        print(json.dumps(summary, ensure_ascii=False))
        return 0
    except (OSError, ValueError, json.JSONDecodeError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())

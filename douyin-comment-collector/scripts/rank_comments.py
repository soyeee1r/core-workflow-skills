#!/usr/bin/env python3
"""Merge semantic annotations and build prioritized Douyin comment views."""

from __future__ import annotations

import argparse
import csv
import json
import math
import sys
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any


SENTIMENTS = {"positive", "negative", "mixed", "neutral"}
PROBLEM_LEVELS = {"explicit", "suspected", "none"}
EXTRA_CSV_FIELDS = [
    "sentiment", "problem_clarity", "problem_summary", "topic_key", "topic_frequency",
    "annotation_reason", "interaction_score", "priority_tier", "priority_rank", "priority_labels",
]


def read_json(path: str) -> Any:
    return json.loads(Path(path).read_text(encoding="utf-8-sig"))


def write_json(path: Path, value: Any) -> None:
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def comment_key(item: dict[str, Any]) -> str:
    return str(item.get("dedupe_key") or ("id:" + str(item["comment_id"])))


def load_annotations(path: str) -> dict[str, dict[str, Any]]:
    payload = read_json(path)
    rows = payload.get("annotations") if isinstance(payload, dict) else payload
    if not isinstance(rows, list) or not all(isinstance(row, dict) for row in rows):
        raise ValueError("annotations must be an array of objects")
    result: dict[str, dict[str, Any]] = {}
    for row in rows:
        key = row.get("dedupe_key") or (
            "id:" + str(row["comment_id"]) if row.get("comment_id") is not None else None
        )
        if not key:
            raise ValueError("each annotation needs comment_id or dedupe_key")
        if key in result:
            raise ValueError("duplicate annotation key: %s" % key)
        sentiment = row.get("sentiment", "neutral")
        problem = row.get("problem_clarity", "none")
        if sentiment not in SENTIMENTS:
            raise ValueError("invalid sentiment for %s: %s" % (key, sentiment))
        if problem not in PROBLEM_LEVELS:
            raise ValueError("invalid problem_clarity for %s: %s" % (key, problem))
        result[key] = {
            "sentiment": sentiment,
            "problem_clarity": problem,
            "problem_summary": row.get("problem_summary") if problem == "explicit" else None,
            "topic_key": row.get("topic_key") or None,
            "annotation_reason": row.get("reason") or None,
        }
    return result


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--comments", required=True, help="comments.json from normalize_comments.py")
    parser.add_argument("--annotations", required=True, help="semantic annotations JSON")
    parser.add_argument("--output-dir", required=True, help="output directory")
    args = parser.parse_args()

    try:
        payload = read_json(args.comments)
        comments = payload.get("comments") if isinstance(payload, dict) else None
        if not isinstance(comments, list) or not all(isinstance(item, dict) for item in comments):
            raise ValueError("comments input must contain a comments array")
        if len(comments) > 200:
            raise ValueError("comments input exceeds the 200-record hard limit")
        annotations = load_annotations(args.annotations)

        merged: list[dict[str, Any]] = []
        missing_annotations = 0
        for item in comments:
            row = dict(item)
            key = comment_key(row)
            annotation = annotations.get(key)
            if annotation is None:
                missing_annotations += 1
                annotation = {
                    "sentiment": "neutral", "problem_clarity": "none",
                    "problem_summary": None, "topic_key": None, "annotation_reason": None,
                }
            row.update(annotation)
            likes = max(0, int(row.get("like_count") or 0))
            replies = max(0, int(row.get("reply_count") or 0))
            row["interaction_score"] = round(10 * math.log1p(likes) + 15 * math.log1p(replies), 4)
            merged.append(row)

        topic_counts = Counter(row["topic_key"] for row in merged if row.get("topic_key"))
        interaction_candidates = sorted(
            (row for row in merged if (row.get("like_count") or 0) > 0 or (row.get("reply_count") or 0) > 0),
            key=lambda row: (-row["interaction_score"], row.get("source_order") or 0),
        )
        high_count = min(len(interaction_candidates), max(1, math.ceil(len(merged) * 0.2))) if merged else 0
        high_keys = {comment_key(row) for row in interaction_candidates[:high_count]}

        for row in merged:
            key = comment_key(row)
            frequency = topic_counts.get(row.get("topic_key"), 0)
            labels: list[str] = []
            if key in high_keys:
                labels.append("high_interaction")
            if row["sentiment"] == "positive":
                labels.append("positive")
            if row["problem_clarity"] == "explicit":
                labels.append("explicit_problem")
            if frequency >= 3:
                labels.append("repeated_topic")
            row["topic_frequency"] = frequency
            row["priority_labels"] = labels
            row["priority_tier"] = next(
                (index for index, label in enumerate(
                    ["high_interaction", "positive", "explicit_problem", "repeated_topic"], start=1
                ) if label in labels),
                5,
            )

        ranked = sorted(
            merged,
            key=lambda row: (
                row["priority_tier"], -row["interaction_score"],
                -row["topic_frequency"], row.get("source_order") or 0,
            ),
        )
        for index, row in enumerate(ranked, start=1):
            row["priority_rank"] = index

        topic_rows: dict[str, list[dict[str, Any]]] = defaultdict(list)
        for row in merged:
            if row.get("topic_key") and row["topic_frequency"] >= 3:
                topic_rows[row["topic_key"]].append(row)
        repeated_topics = []
        for topic, rows in topic_rows.items():
            examples = sorted(rows, key=lambda row: -row["interaction_score"])[:5]
            repeated_topics.append({
                "topic": topic,
                "frequency": len(rows),
                "interaction_score_sum": round(sum(row["interaction_score"] for row in rows), 4),
                "examples": [
                    {"key": comment_key(row), "text": row.get("text"), "like_count": row.get("like_count"),
                     "reply_count": row.get("reply_count")} for row in examples
                ],
            })
        repeated_topics.sort(key=lambda row: (-row["frequency"], -row["interaction_score_sum"], row["topic"]))

        views = {
            "high_interaction": [comment_key(row) for row in ranked if "high_interaction" in row["priority_labels"]],
            "positive": [comment_key(row) for row in ranked if "positive" in row["priority_labels"]],
            "explicit_problems": [comment_key(row) for row in ranked if "explicit_problem" in row["priority_labels"]],
            "repeated_topic_comments": [comment_key(row) for row in ranked if "repeated_topic" in row["priority_labels"]],
        }
        priority_summary = {
            "total_comments": len(ranked),
            "missing_annotations": missing_annotations,
            "counts": {name: len(keys) for name, keys in views.items()},
            "views": views,
            "repeated_topics": repeated_topics,
            "ranking_rule": "high_interaction > positive > explicit_problem > repeated_topic > other",
        }

        output_dir = Path(args.output_dir)
        output_dir.mkdir(parents=True, exist_ok=True)
        write_json(output_dir / "ranked-comments.json", {"comments": ranked})
        write_json(output_dir / "priority-summary.json", priority_summary)
        base_fields = list(comments[0].keys()) if comments else []
        fields = base_fields + [field for field in EXTRA_CSV_FIELDS if field not in base_fields]
        with (output_dir / "ranked-comments.csv").open("w", encoding="utf-8-sig", newline="") as handle:
            writer = csv.DictWriter(handle, fieldnames=fields, extrasaction="ignore")
            writer.writeheader()
            for row in ranked:
                csv_row = dict(row)
                csv_row["priority_labels"] = "|".join(row["priority_labels"])
                writer.writerow(csv_row)
        print(json.dumps(priority_summary, ensure_ascii=False))
        return 0
    except (OSError, ValueError, json.JSONDecodeError, KeyError, TypeError) as exc:
        print("error: %s" % exc, file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())

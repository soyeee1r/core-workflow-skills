#!/usr/bin/env python3
"""Validate the structural invariants of a Zhaoer Feishu weekly-report XML fragment."""

from __future__ import annotations

import argparse
import re
import sys
import xml.etree.ElementTree as ET
from pathlib import Path


REQUIRED_SECTIONS = ("上周遗留待办", "本周工作计划", "逐日待办及完成情况")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("report", type=Path)
    parser.add_argument("--mode", choices=("plan", "recap", "weekly", "monthly"), required=True)
    parser.add_argument("--expected-title", required=True)
    parser.add_argument("--expected-date", action="append", default=[])
    return parser.parse_args()


def fail(messages: list[str]) -> int:
    for message in messages:
        print(f"ERROR: {message}", file=sys.stderr)
    return 1


def normalized_text(element: ET.Element) -> str:
    return " ".join("".join(element.itertext()).split())


def main() -> int:
    args = parse_args()
    raw = args.report.read_text(encoding="utf-8")
    errors: list[str] = []

    try:
        root = ET.fromstring(f"<report-root>{raw}</report-root>")
    except ET.ParseError as exc:
        return fail([f"invalid XML fragment: {exc}"])

    all_text = normalized_text(root)
    title = root.find("title")
    actual_title = normalized_text(title) if title is not None else ""
    if actual_title != args.expected_title:
        errors.append(f"title mismatch: expected {args.expected_title!r}, got {actual_title!r}")

    for section in REQUIRED_SECTIONS:
        if section not in all_text:
            errors.append(f"missing required section: {section}")

    for date in args.expected_date:
        pattern = rf"(?<!\d){re.escape(date)}(?!\d)"
        if not re.search(pattern, all_text):
            errors.append(f"missing expected date: {date}")

    tables = root.findall(".//table")
    if not tables:
        errors.append("missing report table")
    else:
        widths = [col.get("width") for col in tables[0].findall("./colgroup/col")]
        if len(widths) != 3:
            errors.append(f"expected three table columns, found {len(widths)}")

    checkboxes = root.findall(".//checkbox")
    invalid_done = [box.get("done") for box in checkboxes if box.get("done") not in {"true", "false"}]
    if invalid_done:
        errors.append("checkbox done attributes must be true or false")
    if args.mode == "plan" and any(box.get("done") == "true" for box in checkboxes):
        errors.append("plan mode must not contain completed checkboxes")
    if args.mode == "weekly" and "本周任务总结" not in all_text:
        errors.append("weekly mode requires 本周任务总结")
    if args.mode == "monthly" and "月报总结" not in all_text:
        errors.append("monthly mode requires 月报总结")

    if errors:
        return fail(errors)

    print(
        f"OK: mode={args.mode} title={actual_title!r} "
        f"dates={len(args.expected_date)} checkboxes={len(checkboxes)}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

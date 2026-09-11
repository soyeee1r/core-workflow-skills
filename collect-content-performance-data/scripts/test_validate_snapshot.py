#!/usr/bin/env python3
"""Unit tests for validate_snapshot.py."""

from __future__ import annotations

import copy
import importlib.util
import unittest
from pathlib import Path


MODULE_PATH = Path(__file__).with_name("validate_snapshot.py")
SPEC = importlib.util.spec_from_file_location("validate_snapshot", MODULE_PATH)
MODULE = importlib.util.module_from_spec(SPEC)
assert SPEC and SPEC.loader
SPEC.loader.exec_module(MODULE)


def valid_payload() -> dict:
    return {
        "publication_id": "pub_demo_001",
        "project_id": "project_demo_001",
        "platform": "douyin",
        "account_id": "public-anonymous",
        "content_id": "video-001",
        "canonical_url": "https://example.com/video-001",
        "published_at": "2026-08-07T10:00:00+08:00",
        "scheduled_window": "24h",
        "collected_at": "2026-08-08T10:12:00+08:00",
        "source": {"method": "api", "evidence": ["file:/tmp/public-metrics.json"]},
        "metrics": [
            {
                "name": "views",
                "raw_label": "播放量",
                "value": 12345,
                "unit": "count",
                "availability": "available",
            }
        ],
        "target_doc_url": "https://example.feishu.cn/docx/demo",
    }


class SnapshotValidationTests(unittest.TestCase):
    def test_valid_snapshot_is_enriched(self) -> None:
        result = MODULE.validate(valid_payload())
        self.assertEqual(result["idempotency_key"], "pub_demo_001:24h")
        self.assertEqual(result["metric_snapshot_id"], "ms_2e17791c49f71d65")
        self.assertEqual(result["timeliness"], "on_time")

    def test_early_collection_is_rejected(self) -> None:
        payload = valid_payload()
        payload["collected_at"] = "2026-08-08T09:59:00+08:00"
        with self.assertRaisesRegex(ValueError, "earlier than the 24h due time"):
            MODULE.validate(payload)

    def test_supported_windows_have_distinct_ids(self) -> None:
        collected_times = {
            "2h": "2026-08-07T12:12:00+08:00",
            "6h": "2026-08-07T16:12:00+08:00",
            "48h": "2026-08-09T10:12:00+08:00",
        }
        snapshot_ids = set()
        for window, collected_at in collected_times.items():
            with self.subTest(window=window):
                payload = valid_payload()
                payload.update({"scheduled_window": window, "collected_at": collected_at})
                result = MODULE.validate(payload)
                self.assertEqual(result["idempotency_key"], f"pub_demo_001:{window}")
                self.assertEqual(result["timeliness"], "on_time")
                snapshot_ids.add(result["metric_snapshot_id"])
        self.assertEqual(len(snapshot_ids), 3)

    def test_early_collection_is_rejected_for_each_window(self) -> None:
        early_times = {
            "2h": "2026-08-07T11:59:00+08:00",
            "6h": "2026-08-07T15:59:00+08:00",
            "48h": "2026-08-09T09:59:00+08:00",
        }
        for window, collected_at in early_times.items():
            with self.subTest(window=window):
                payload = valid_payload()
                payload.update({"scheduled_window": window, "collected_at": collected_at})
                with self.assertRaisesRegex(ValueError, f"earlier than the {window} due time"):
                    MODULE.validate(payload)

    def test_unsupported_7d_window_is_rejected(self) -> None:
        payload = valid_payload()
        payload.update(
            {
                "scheduled_window": "7d",
                "collected_at": "2026-08-14T10:12:00+08:00",
            }
        )
        with self.assertRaisesRegex(ValueError, "must be 2h, 6h, 24h, or 48h"):
            MODULE.validate(payload)

    def test_late_collection_is_labeled(self) -> None:
        payload = valid_payload()
        payload["collected_at"] = "2026-08-08T17:00:00+08:00"
        self.assertEqual(MODULE.validate(payload)["timeliness"], "late")

    def test_missing_evidence_is_rejected(self) -> None:
        payload = valid_payload()
        payload["source"]["evidence"] = []
        with self.assertRaisesRegex(ValueError, "at least one evidence"):
            MODULE.validate(payload)

    def test_duplicate_metric_names_are_rejected(self) -> None:
        payload = valid_payload()
        payload["metrics"].append(copy.deepcopy(payload["metrics"][0]))
        with self.assertRaisesRegex(ValueError, "metric names must be unique"):
            MODULE.validate(payload)

    def test_ratio_above_one_is_rejected(self) -> None:
        payload = valid_payload()
        payload["metrics"][0].update({"unit": "ratio", "value": 1.01})
        with self.assertRaisesRegex(ValueError, "between 0 and 1"):
            MODULE.validate(payload)

    def test_browser_source_is_rejected(self) -> None:
        payload = valid_payload()
        payload["source"]["method"] = "browser"
        with self.assertRaisesRegex(ValueError, "no-browser mode"):
            MODULE.validate(payload)

    def test_public_play_count_zero_must_be_unavailable(self) -> None:
        payload = valid_payload()
        payload["metrics"][0]["value"] = 0
        with self.assertRaisesRegex(ValueError, "must be marked unavailable"):
            MODULE.validate(payload)


if __name__ == "__main__":
    unittest.main()

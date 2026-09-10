#!/usr/bin/env python3

import argparse
import fcntl
import json
import os
import socket
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlparse


DEFAULT_ROOT = Path("/Users/mac/Documents/迭代/vendor/MediaCrawler-main")
LOCK_FILE = Path("/private/tmp/0615-mediacrawler-douyin.lock")


def parse_args():
    parser = argparse.ArgumentParser()
    parser.add_argument("--url", required=True)
    parser.add_argument("--output-dir", required=True)
    parser.add_argument("--limit", type=int, default=100)
    parser.add_argument("--mediacrawler-root", default=str(DEFAULT_ROOT))
    parser.add_argument("--probe", action="store_true")
    return parser.parse_args()


def validate_url(value):
    parsed = urlparse(value)
    host = (parsed.hostname or "").lower()
    if parsed.scheme not in {"http", "https"} or not (
        host == "douyin.com" or host.endswith(".douyin.com") or host.endswith(".iesdouyin.com")
    ):
        raise ValueError("只支持抖音作品链接")
    return value


def port_ready(host="127.0.0.1", port=9222):
    try:
        with socket.create_connection((host, port), timeout=2):
            return True
    except OSError:
        return False


def read_jsonl(path):
    rows = []
    with path.open("r", encoding="utf-8") as handle:
        for line in handle:
            line = line.strip()
            if line:
                rows.append(json.loads(line))
    return rows


def newest(paths):
    matches = list(paths)
    return max(matches, key=lambda item: item.stat().st_mtime) if matches else None


def normalize_row(row, order):
    raw_time = row.get("create_time")
    created_at = None
    try:
        numeric = int(raw_time)
        if numeric > 0:
            created_at = datetime.fromtimestamp(numeric, tz=timezone.utc).isoformat()
    except (TypeError, ValueError, OSError):
        pass
    parent = row.get("parent_comment_id")
    parent = None if parent in (None, "", "0", 0) else str(parent)
    return {
        "comment_id": str(row.get("comment_id")) if row.get("comment_id") else None,
        "parent_comment_id": parent,
        "author_name": row.get("nickname") or None,
        "author_profile_url": None,
        "text": row.get("content") or None,
        "like_count": row.get("like_count") if row.get("like_count") is not None else None,
        "reply_count": row.get("sub_comment_count") if row.get("sub_comment_count") is not None else None,
        "created_at": created_at,
        "location_label": None,
        "is_reply": parent is not None,
        "is_pinned": False,
        "is_creator": False,
        "source_order": order,
    }


def main():
    args = parse_args()
    root = Path(args.mediacrawler_root).resolve()
    python = root / ".venv/bin/python"
    entry = root / "main.py"
    if not python.exists() or not entry.exists():
        raise RuntimeError(f"MediaCrawler 未完成安装：{root}")
    if args.probe:
        if not port_ready():
            print(json.dumps({"ok": False, "code": "cdp_port_unavailable", "backend": "mediacrawler_existing_chrome", "root": str(root)}, ensure_ascii=False))
            return 2
        probe_code = """
import asyncio, json
from playwright.async_api import async_playwright
async def main():
    driver = await async_playwright().start()
    browser = await driver.chromium.connect_over_cdp('ws://127.0.0.1:9222/devtools/browser', timeout=60000)
    print(json.dumps({'connected': browser.is_connected(), 'contexts': len(browser.contexts)}))
    await driver.stop()
asyncio.run(main())
"""
        probe = subprocess.run(
            [str(python), "-c", probe_code],
            cwd=root,
            capture_output=True,
            text=True,
            timeout=70,
        )
        if probe.returncode != 0:
            print(json.dumps({
                "ok": False,
                "code": "cdp_handshake_failed",
                "backend": "mediacrawler_existing_chrome",
                "error": (probe.stderr or probe.stdout)[-1200:],
                "root": str(root),
            }, ensure_ascii=False))
            return 2
        detail = json.loads(probe.stdout.strip().splitlines()[-1])
        print(json.dumps({"ok": True, "backend": "mediacrawler_existing_chrome", "root": str(root), **detail}, ensure_ascii=False))
        return 0
    source_url = validate_url(args.url)
    if args.limit < 1 or args.limit > 100:
        raise ValueError("limit 必须在 1–100 之间")
    output_dir = Path(args.output_dir).resolve()
    output_dir.mkdir(parents=True, exist_ok=True)
    log_file = output_dir / "mediacrawler.log"
    if not port_ready():
        raise RuntimeError("Chrome 的本机调试端口 9222 当前不可用")

    command = [
        str(python), str(entry),
        "--platform", "dy",
        "--type", "detail",
        "--lt", "qrcode",
        "--specified_id", source_url,
        "--get_comment", "yes",
        "--get_sub_comment", "yes",
        "--max_comments_count_singlenotes", str(args.limit),
        "--max_concurrency_num", "1",
        "--save_data_option", "jsonl",
        "--save_data_path", str(output_dir),
        "--enable_ip_proxy", "no",
        "--headless", "no",
    ]
    env = dict(os.environ)
    env["PYTHONUNBUFFERED"] = "1"
    env["MPLBACKEND"] = "Agg"
    env["MPLCONFIGDIR"] = str(output_dir / ".matplotlib")
    with LOCK_FILE.open("w") as lock_handle:
        fcntl.flock(lock_handle.fileno(), fcntl.LOCK_EX)
        with log_file.open("w", encoding="utf-8") as log_handle:
            completed = subprocess.run(
                command,
                cwd=root,
                env=env,
                stdout=log_handle,
                stderr=subprocess.STDOUT,
                text=True,
                timeout=900,
            )
    if completed.returncode != 0:
        tail = log_file.read_text(encoding="utf-8", errors="replace")[-3000:]
        raise RuntimeError(f"MediaCrawler 退出码 {completed.returncode}：{tail}")

    comments_file = newest(output_dir.glob("douyin/jsonl/detail_comments_*.jsonl"))
    contents_file = newest(output_dir.glob("douyin/jsonl/detail_contents_*.jsonl"))
    if not comments_file:
        raise RuntimeError("MediaCrawler 已结束，但没有生成评论文件")
    raw_rows = read_jsonl(comments_file)
    content_rows = read_jsonl(contents_file) if contents_file else []
    comments = [normalize_row(row, index + 1) for index, row in enumerate(raw_rows)]
    payload = {
        "collection": {
            "platform": "douyin",
            "video_id": str(content_rows[-1].get("aweme_id")) if content_rows and content_rows[-1].get("aweme_id") else None,
            "source_url": source_url,
            "source_title": content_rows[-1].get("title") if content_rows else None,
            "collected_at": datetime.now(timezone.utc).isoformat(),
            "status": "limit_reached" if len(comments) >= args.limit else "complete_visible_range",
            "stop_reason": "MediaCrawler completed its visible comment range",
            "requested_limit": args.limit,
            "backend": "mediacrawler_existing_chrome",
            "upstream_comments_file": str(comments_file),
            "nickname_note": "MediaCrawler output masks nicknames and hashes user IDs",
        },
        "comments": comments,
    }
    raw_output = output_dir / "raw-comments.json"
    raw_output.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({
        "ok": True,
        "backend": "mediacrawler_existing_chrome",
        "output_file": str(raw_output),
        "collected_count": len(comments),
        "video_id": payload["collection"]["video_id"],
    }, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except subprocess.TimeoutExpired:
        print(json.dumps({"ok": False, "code": "timeout", "error": "MediaCrawler 运行超过 15 分钟"}, ensure_ascii=False), file=sys.stderr)
        raise SystemExit(2)
    except Exception as error:
        print(json.dumps({"ok": False, "code": "collection_failed", "error": str(error)}, ensure_ascii=False), file=sys.stderr)
        raise SystemExit(2)

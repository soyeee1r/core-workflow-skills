#!/usr/bin/env python3
"""Fetch public X/Twitter post, thread, article, image, and video evidence.

This helper intentionally uses no account cookies or API credentials. It emits a
normalized content.json for a summarizing agent and optionally downloads public
images into the requested output directory.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import mimetypes
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import quote, urlparse
from urllib.request import Request, urlopen


API_ROOT = "https://api.fxtwitter.com/2"
USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/124 Safari/537.36"
INPUT_HOSTS = {"x.com", "www.x.com", "mobile.x.com", "twitter.com", "www.twitter.com", "mobile.twitter.com"}
IMAGE_HOSTS = {"pbs.twimg.com"}
VIDEO_HOSTS = {"video.twimg.com"}
STATUS_RE = re.compile(r"/(?:i/web/)?status(?:es)?/(\d{2,20})(?:\b|/)", re.IGNORECASE)
ARTICLE_RE = re.compile(r"/i/article/(\d{2,20})(?:\b|/)", re.IGNORECASE)
MAX_THREAD_ITEMS = 30
MAX_IMAGES = 16
MAX_IMAGE_BYTES = 20 * 1024 * 1024
MAX_VIDEOS = 3
MAX_VIDEO_BYTES = 80 * 1024 * 1024
MAX_VIDEO_FRAMES = 9
VIDEO_RANGE_BYTES = 1024 * 1024
MAX_ARTICLE_CHARS = 400_000
KNOWN_FFMPEG = Path(
    "/Users/mac/.local/share/content-ops-agent/voice-venv/"
    "lib/python3.9/site-packages/imageio_ffmpeg/binaries/"
    "ffmpeg-macos-aarch64-v7.1"
)


class FetchError(RuntimeError):
    pass


def clean_url(value: str) -> str:
    candidate = value.strip().strip("<>\"'")
    parsed = urlparse(candidate)
    if parsed.scheme not in {"http", "https"} or parsed.hostname not in INPUT_HOSTS:
        raise FetchError("仅支持 x.com 或 twitter.com 的公开链接")
    return candidate


def extract_ids(url: str) -> tuple[str | None, str | None]:
    parsed = urlparse(url)
    status_match = STATUS_RE.search(parsed.path)
    article_match = ARTICLE_RE.search(parsed.path)
    return (
        status_match.group(1) if status_match else None,
        article_match.group(1) if article_match else None,
    )


def request_bytes(url: str, *, max_bytes: int | None = None) -> tuple[bytes, str, str]:
    request = Request(url, headers={"User-Agent": USER_AGENT, "Accept": "application/json,image/*;q=0.9,*/*;q=0.1"})
    try:
        with urlopen(request, timeout=30) as response:
            final_url = response.geturl()
            content_type = response.headers.get_content_type()
            if max_bytes is None:
                return response.read(), final_url, content_type
            chunks: list[bytes] = []
            total = 0
            while True:
                chunk = response.read(min(1024 * 1024, max_bytes + 1 - total))
                if not chunk:
                    break
                total += len(chunk)
                if total > max_bytes:
                    raise FetchError(f"远程文件超过 {max_bytes} 字节上限")
                chunks.append(chunk)
            return b"".join(chunks), final_url, content_type
    except HTTPError as error:
        body = error.read(500).decode("utf-8", "replace")
        raise FetchError(f"HTTP {error.code}: {body or error.reason}") from error
    except URLError as error:
        raise FetchError(f"网络请求失败: {error.reason}") from error


def request_json(url: str) -> dict[str, Any]:
    raw, _, _ = request_bytes(url)
    try:
        value = json.loads(raw)
    except json.JSONDecodeError as error:
        raise FetchError("公开接口未返回合法 JSON") from error
    if not isinstance(value, dict):
        raise FetchError("公开接口返回结构异常")
    if int(value.get("code") or 0) != 200:
        raise FetchError(f"公开接口无法读取该内容（code={value.get('code')} ）")
    return value


def article_text(article: Any) -> str:
    if not isinstance(article, dict):
        return ""
    content = article.get("content")
    if not isinstance(content, dict):
        return str(article.get("preview_text") or "").strip()
    blocks = content.get("blocks")
    entity_map_raw = content.get("entityMap") or {}
    if isinstance(entity_map_raw, list):
        entity_map = {
            str(item.get("key")): item
            for item in entity_map_raw
            if isinstance(item, dict) and item.get("key") is not None
        }
    elif isinstance(entity_map_raw, dict):
        entity_map = entity_map_raw
    else:
        entity_map = {}
    if not isinstance(blocks, list):
        return str(article.get("preview_text") or "").strip()
    lines: list[str] = []
    for block in blocks:
        if not isinstance(block, dict):
            continue
        block_type = str(block.get("type") or "")
        text = str(block.get("text") or "").strip()
        if block_type == "atomic":
            for entity_range in block.get("entityRanges") or []:
                if not isinstance(entity_range, dict):
                    continue
                entity = entity_map.get(str(entity_range.get("key")))
                value = entity.get("value") if isinstance(entity, dict) else None
                data = value.get("data") if isinstance(value, dict) else None
                markdown = data.get("markdown") if isinstance(data, dict) else None
                if isinstance(markdown, str) and markdown.strip():
                    lines.append(markdown.strip())
            continue
        if not text:
            continue
        prefix = {
            "header-one": "# ",
            "header-two": "## ",
            "header-three": "### ",
            "unordered-list-item": "- ",
            "ordered-list-item": "1. ",
            "blockquote": "> ",
        }.get(block_type, "")
        lines.append(prefix + text)
    combined = "\n\n".join(lines).strip()
    return combined[:MAX_ARTICLE_CHARS]


def compact_author(author: Any) -> dict[str, Any] | None:
    if not isinstance(author, dict):
        return None
    return {
        "name": author.get("name"),
        "screen_name": author.get("screen_name"),
        "url": author.get("url"),
        "verified": (author.get("verification") or {}).get("verified") if isinstance(author.get("verification"), dict) else None,
    }


def compact_article(article: Any) -> dict[str, Any] | None:
    if not isinstance(article, dict):
        return None
    return {
        "id": article.get("id"),
        "title": article.get("title"),
        "preview_text": article.get("preview_text"),
        "created_at": article.get("created_at"),
        "modified_at": article.get("modified_at"),
        "text": article_text(article),
    }


def compact_media(media: Any) -> list[dict[str, Any]]:
    if not isinstance(media, dict):
        return []
    items = media.get("all")
    if not isinstance(items, list):
        items = []
        for key in ("photos", "videos"):
            if isinstance(media.get(key), list):
                items.extend(media[key])
    result = []
    seen: set[str] = set()
    for item in items:
        if not isinstance(item, dict):
            continue
        fingerprint = str(item.get("id") or item.get("url") or item.get("thumbnail_url") or "")
        if fingerprint in seen:
            continue
        seen.add(fingerprint)
        result.append({
            "id": item.get("id"),
            "type": item.get("type"),
            "url": item.get("url"),
            "thumbnail_url": item.get("thumbnail_url") or item.get("preview_image_url"),
            "width": item.get("width"),
            "height": item.get("height"),
            "duration_seconds": item.get("duration"),
            "alt_text": item.get("alt_text"),
        })
    return result


def compact_status(status: Any, *, include_quote: bool = True) -> dict[str, Any] | None:
    if not isinstance(status, dict):
        return None
    card = status.get("card") if isinstance(status.get("card"), dict) else None
    compact = {
        "id": status.get("id"),
        "url": status.get("url"),
        "author": compact_author(status.get("author")),
        "created_at": status.get("created_at"),
        "lang": status.get("lang"),
        "text": status.get("text") or (status.get("raw_text") or {}).get("text"),
        "is_note_tweet": status.get("is_note_tweet"),
        "community_note": status.get("community_note"),
        "metrics": {
            "views": status.get("views"),
            "likes": status.get("likes"),
            "reposts": status.get("reposts"),
            "quotes": status.get("quotes"),
            "replies": status.get("replies"),
            "bookmarks": status.get("bookmarks"),
        },
        "media": compact_media(status.get("media")),
        "card": ({
            "url": card.get("url"),
            "title": card.get("title"),
            "description": card.get("description"),
            "domain": card.get("domain"),
        } if card else None),
        "article": compact_article(status.get("article")),
    }
    compact["quote"] = compact_status(status.get("quote"), include_quote=False) if include_quote else None
    return compact


def has_sparse_article(status: Any) -> bool:
    if not isinstance(status, dict):
        return False
    for candidate in (status, status.get("quote")):
        if not isinstance(candidate, dict) or not isinstance(candidate.get("article"), dict):
            continue
        content = candidate["article"].get("content")
        blocks = content.get("blocks") if isinstance(content, dict) else None
        if not isinstance(blocks, list) or not blocks:
            return True
    return False


def collect_image_urls(value: Any, result: list[str], seen: set[str]) -> None:
    if len(result) >= MAX_IMAGES:
        return
    if isinstance(value, dict):
        for key, child in value.items():
            if isinstance(child, str):
                parsed = urlparse(child)
                if parsed.scheme == "https" and parsed.hostname in IMAGE_HOSTS and (
                    key in {"url", "thumbnail_url", "preview_image_url", "original_img_url"}
                    or "/media/" in parsed.path
                    or "_thumb/" in parsed.path
                ):
                    if child not in seen:
                        seen.add(child)
                        result.append(child)
            else:
                collect_image_urls(child, result, seen)
    elif isinstance(value, list):
        for child in value:
            collect_image_urls(child, result, seen)


def image_extension(content_type: str, url: str) -> str:
    guessed = mimetypes.guess_extension(content_type) if content_type else None
    if guessed in {".jpg", ".jpeg", ".png", ".gif", ".webp"}:
        return ".jpg" if guessed == ".jpeg" else guessed
    suffix = Path(urlparse(url).path).suffix.lower()
    return suffix if suffix in {".jpg", ".jpeg", ".png", ".gif", ".webp"} else ".jpg"


def download_images(urls: list[str], output_dir: Path) -> tuple[list[dict[str, Any]], list[dict[str, str]]]:
    image_dir = output_dir / "images"
    image_dir.mkdir(parents=True, exist_ok=True)
    downloaded: list[dict[str, Any]] = []
    failures: list[dict[str, str]] = []
    for index, url in enumerate(urls[:MAX_IMAGES], start=1):
        try:
            raw, final_url, content_type = request_bytes(url, max_bytes=MAX_IMAGE_BYTES)
            final_host = urlparse(final_url).hostname
            if final_host not in IMAGE_HOSTS:
                raise FetchError(f"图片重定向到不允许的域名: {final_host}")
            if not content_type.startswith("image/"):
                raise FetchError(f"返回内容不是图片: {content_type}")
            digest = hashlib.sha256(raw).hexdigest()
            filename = f"{index:02d}-{digest[:12]}{image_extension(content_type, final_url)}"
            target = image_dir / filename
            target.write_bytes(raw)
            downloaded.append({
                "source_url": url,
                "final_url": final_url,
                "local_path": str(target.resolve()),
                "content_type": content_type,
                "bytes": len(raw),
                "sha256": digest,
            })
        except FetchError as error:
            failures.append({"source_url": url, "error": str(error)})
    return downloaded, failures


def choose_video_url(item: dict[str, Any]) -> str | None:
    formats = item.get("formats")
    candidates: list[tuple[int, str]] = []
    if isinstance(formats, list):
        for video_format in formats:
            if not isinstance(video_format, dict) or video_format.get("container") != "mp4":
                continue
            url = video_format.get("url")
            if not isinstance(url, str) or urlparse(url).hostname not in VIDEO_HOSTS:
                continue
            bitrate = video_format.get("bitrate")
            candidates.append((int(bitrate) if isinstance(bitrate, (int, float)) else 0, url))
    if candidates:
        efficient = [candidate for candidate in candidates if 0 < candidate[0] <= 1_000_000]
        return max(efficient or candidates, key=lambda candidate: candidate[0])[1]
    fallback = item.get("url")
    if isinstance(fallback, str) and urlparse(fallback).hostname in VIDEO_HOSTS:
        return fallback
    return None


def collect_video_candidates(value: Any, result: list[dict[str, Any]], seen: set[str]) -> None:
    if len(result) >= MAX_VIDEOS:
        return
    if isinstance(value, dict):
        media_type = str(value.get("type") or "").lower()
        if media_type in {"video", "animated_gif", "gif"}:
            url = choose_video_url(value)
            fingerprint = str(value.get("id") or url or "")
            if url and fingerprint and fingerprint not in seen:
                seen.add(fingerprint)
                duration = value.get("duration")
                result.append({
                    "id": value.get("id"),
                    "url": url,
                    "duration_seconds": float(duration) if isinstance(duration, (int, float)) else None,
                })
        for child in value.values():
            collect_video_candidates(child, result, seen)
    elif isinstance(value, list):
        for child in value:
            collect_video_candidates(child, result, seen)


def resolve_ffmpeg() -> str:
    configured = os.getenv("FFMPEG_BINARY", "").strip()
    if configured and Path(configured).is_file():
        return configured
    discovered = shutil.which("ffmpeg")
    if discovered:
        return discovered
    if KNOWN_FFMPEG.is_file():
        return str(KNOWN_FFMPEG)
    raise FetchError("未找到 ffmpeg，无法对视频抽帧")


def stream_video_frames(
    url: str, frame_dir: Path, duration_seconds: float | None,
) -> tuple[str, str, int, list[str], str, float]:
    frame_dir.mkdir(parents=True, exist_ok=True)
    ffmpeg = resolve_ffmpeg()
    interval = max(1.0, (duration_seconds or 60.0) / MAX_VIDEO_FRAMES)
    frame_pattern = frame_dir / "frame-%02d.jpg"
    frame_filter = f"fps=1/{interval:.6f},scale=min(480\\,iw):-2"
    process = subprocess.Popen(
        [
            ffmpeg, "-hide_banner", "-loglevel", "error", "-y",
            "-i", "pipe:0", "-vf", frame_filter,
            "-frames:v", str(MAX_VIDEO_FRAMES), "-q:v", "3", str(frame_pattern),
        ],
        stdin=subprocess.PIPE,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.PIPE,
    )
    offset = 0
    total_size: int | None = None
    final_url = url
    content_type = "video/mp4"
    try:
        while total_size is None or offset < total_size:
            end = offset + VIDEO_RANGE_BYTES - 1
            request = Request(url, headers={
                "User-Agent": USER_AGENT,
                "Accept": "video/mp4,*/*;q=0.8",
                "Range": f"bytes={offset}-{end}",
                "Referer": "https://x.com/",
            })
            try:
                with urlopen(request, timeout=30) as response:
                    final_url = response.geturl()
                    final_host = urlparse(final_url).hostname
                    if final_host not in VIDEO_HOSTS:
                        raise FetchError(f"视频重定向到不允许的域名: {final_host}")
                    content_type = response.headers.get_content_type()
                    if not content_type.startswith("video/") and content_type != "application/octet-stream":
                        raise FetchError(f"返回内容不是视频: {content_type}")
                    raw = response.read(VIDEO_RANGE_BYTES + 1)
                    if len(raw) > VIDEO_RANGE_BYTES and response.status == 206:
                        raise FetchError("视频分段响应超过请求范围")
                    content_range = response.headers.get("Content-Range") or ""
                    match = re.match(r"bytes\s+(\d+)-(\d+)/(\d+|\*)", content_range)
                    if match and match.group(3) != "*":
                        total_size = int(match.group(3))
                    elif response.status == 200:
                        total_size = len(raw)
            except HTTPError as error:
                body = error.read(500).decode("utf-8", "replace")
                raise FetchError(f"视频流 HTTP {error.code}: {body or error.reason}") from error
            except URLError as error:
                raise FetchError(f"视频流读取失败: {error.reason}") from error
            if not raw:
                break
            if offset + len(raw) > MAX_VIDEO_BYTES or (total_size and total_size > MAX_VIDEO_BYTES):
                raise FetchError(f"视频流超过 {MAX_VIDEO_BYTES} 字节处理上限")
            if process.stdin is None:
                raise FetchError("视频抽帧进程没有输入管道")
            try:
                process.stdin.write(raw)
            except BrokenPipeError as error:
                raise FetchError("视频抽帧进程提前结束") from error
            offset += len(raw)
            if total_size is None and len(raw) < VIDEO_RANGE_BYTES:
                total_size = offset
        if offset == 0:
            raise FetchError("视频响应为空")
        if process.stdin:
            process.stdin.close()
        stderr = process.stderr.read().decode("utf-8", "replace") if process.stderr else ""
        return_code = process.wait(timeout=120)
        if return_code != 0:
            raise FetchError(f"视频抽帧失败: {stderr[-500:]}")
        frames = sorted(frame_dir.glob("frame-*.jpg"))
        if not frames:
            raise FetchError("视频抽帧没有生成画面")
        contact_sheet = build_contact_sheet(ffmpeg, frame_dir, frames)
        return (
            final_url,
            content_type,
            offset,
            [str(frame.resolve()) for frame in frames],
            str(contact_sheet.resolve()),
            interval,
        )
    except Exception:
        if process.stdin and not process.stdin.closed:
            process.stdin.close()
        if process.poll() is None:
            process.kill()
        process.wait()
        raise


def build_contact_sheet(ffmpeg: str, frame_dir: Path, frames: list[Path]) -> Path:
    contact_sheet = frame_dir / "contact-sheet.jpg"
    tile_command = [
        ffmpeg, "-hide_banner", "-loglevel", "error", "-y",
        "-pattern_type", "glob", "-i", str(frame_dir / "frame-*.jpg"),
        "-vf", "tile=3x3:padding=6:margin=6", "-frames:v", "1", str(contact_sheet),
    ]
    try:
        subprocess.run(tile_command, check=True, capture_output=True, text=True, timeout=60)
    except (subprocess.CalledProcessError, subprocess.TimeoutExpired):
        contact_sheet = frames[0]
    return contact_sheet


def stream_videos(
    candidates: list[dict[str, Any]], output_dir: Path,
) -> tuple[list[dict[str, Any]], list[dict[str, str]]]:
    video_dir = output_dir / "video-frames"
    processed: list[dict[str, Any]] = []
    failures: list[dict[str, str]] = []
    for index, candidate in enumerate(candidates[:MAX_VIDEOS], start=1):
        source_url = str(candidate.get("url") or "")
        video_id = re.sub(r"[^0-9A-Za-z_-]", "", str(candidate.get("id") or index))[:64]
        frame_dir = video_dir / f"{index:02d}-{video_id or index}"
        try:
            final_url, content_type, size, frame_paths, contact_sheet, interval = stream_video_frames(
                source_url, frame_dir, candidate.get("duration_seconds")
            )
            processed.append({
                "id": candidate.get("id"),
                "source_url": source_url,
                "final_url": final_url,
                "content_type": content_type,
                "streamed_bytes": size,
                "video_file_saved": False,
                "duration_seconds": candidate.get("duration_seconds"),
                "sample_interval_seconds": round(interval, 3),
                "frame_paths": frame_paths,
                "contact_sheet_path": contact_sheet,
                "audio_transcript": None,
            })
        except FetchError as error:
            failures.append({"source_url": source_url, "error": str(error)})
    return processed, failures


def build_payload(source_url: str, output_dir: Path) -> dict[str, Any]:
    status_id, bare_article_id = extract_ids(source_url)
    if bare_article_id and not status_id:
        return {
            "status": "needs_parent_status",
            "source_url": source_url,
            "article_id": bare_article_id,
            "message": "纯 X Article 链接没有父帖 ID，需先搜索对应的原始分享帖链接。",
            "thread": [],
            "downloaded_images": [],
            "image_failures": [],
        }
    if not status_id:
        raise FetchError("链接中未找到 X 帖子 ID")

    endpoint = f"{API_ROOT}/thread/{quote(status_id)}"
    thread_payload: dict[str, Any] | None = None
    try:
        thread_payload = request_json(endpoint)
    except FetchError:
        thread_payload = None

    status_payload: dict[str, Any] | None = None
    try:
        status_payload = request_json(f"{API_ROOT}/status/{quote(status_id)}")
    except FetchError:
        if thread_payload is None:
            raise

    raw = thread_payload or status_payload or {}
    primary_raw = status_payload.get("status") if isinstance(status_payload, dict) else None
    if not isinstance(primary_raw, dict):
        primary_raw = raw.get("status") if isinstance(raw.get("status"), dict) else None
    raw_items = list(raw.get("thread")) if isinstance(raw.get("thread"), list) else []
    if not raw_items and isinstance(primary_raw, dict):
        raw_items = [primary_raw]
    raw_items = raw_items[:MAX_THREAD_ITEMS]
    for index, item in enumerate(raw_items):
        if isinstance(item, dict) and str(item.get("id") or "") == status_id and isinstance(primary_raw, dict):
            raw_items[index] = primary_raw
    hydrated = 0
    for index, item in enumerate(raw_items):
        if not has_sparse_article(item) or str(item.get("id") or "") == status_id or hydrated >= 4:
            continue
        try:
            detail = request_json(f"{API_ROOT}/status/{quote(str(item.get('id') or ''))}")
            if isinstance(detail.get("status"), dict):
                raw_items[index] = detail["status"]
                hydrated += 1
        except FetchError:
            continue
    compact_items = [item for item in (compact_status(item) for item in raw_items) if item]
    if not compact_items:
        raise FetchError("公开接口未返回可摘要的帖子内容")

    video_candidates: list[dict[str, Any]] = []
    collect_video_candidates(raw_items, video_candidates, set())
    streamed_videos, video_failures = stream_videos(video_candidates, output_dir)
    image_urls: list[str] = []
    collect_image_urls(raw_items, image_urls, set())
    if streamed_videos:
        image_urls = [
            url for url in image_urls
            if "video_thumb" not in url and "amplify_video_thumb" not in url
        ]
    downloaded, failures = download_images(image_urls, output_dir)
    primary = compact_status(primary_raw) or compact_items[0]
    primary_id = str(primary.get("id") or "") if isinstance(primary, dict) else ""
    thread_continuations = [
        item for item in compact_items if str(item.get("id") or "") != primary_id
    ]
    return {
        "status": "ok" if not failures and not video_failures else "partial",
        "source_url": source_url,
        "resolved_url": primary.get("url") if isinstance(primary, dict) else source_url,
        "status_id": status_id,
        "provider": "FxEmbed public API",
        "primary": primary,
        "thread": thread_continuations,
        "thread_item_count": 1 + len(thread_continuations),
        "downloaded_images": downloaded,
        "image_failures": failures,
        "streamed_videos": streamed_videos,
        "video_failures": video_failures,
        "limits": {
            "comments_included": False,
            "external_links_followed": False,
            "thread_items_cap": MAX_THREAD_ITEMS,
            "images_cap": MAX_IMAGES,
            "videos_cap": MAX_VIDEOS,
            "frames_per_video_cap": MAX_VIDEO_FRAMES,
            "audio_transcription_available": False,
        },
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--url", required=True)
    parser.add_argument("--output-dir", required=True)
    args = parser.parse_args()

    output_dir = Path(args.output_dir).expanduser().resolve()
    output_dir.mkdir(parents=True, exist_ok=True)
    try:
        source_url = clean_url(args.url)
        payload = build_payload(source_url, output_dir)
        exit_code = 0
    except FetchError as error:
        payload = {
            "status": "failed",
            "source_url": args.url,
            "error": str(error),
            "thread": [],
            "downloaded_images": [],
            "image_failures": [],
            "streamed_videos": [],
            "video_failures": [],
        }
        exit_code = 2
    target = output_dir / "content.json"
    target.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({
        "status": payload.get("status"),
        "content_json": str(target),
        "downloaded_image_count": len(payload.get("downloaded_images") or []),
        "streamed_video_count": len(payload.get("streamed_videos") or []),
        "extracted_frame_count": sum(
            len(video.get("frame_paths") or [])
            for video in (payload.get("streamed_videos") or [])
            if isinstance(video, dict)
        ),
        "error": payload.get("error") or payload.get("message") or "",
    }, ensure_ascii=False))
    return exit_code


if __name__ == "__main__":
    sys.exit(main())

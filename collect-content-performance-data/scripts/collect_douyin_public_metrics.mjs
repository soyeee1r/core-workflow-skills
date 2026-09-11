#!/usr/bin/env node

import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const MOBILE_UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1";

const METRIC_FIELDS = [
  ["views", "播放量", ["play_count"], "count", true],
  ["likes", "点赞数", ["digg_count", "like_count"], "count"],
  ["comments", "评论数", ["comment_count"], "count"],
  ["shares", "分享数", ["share_count"], "count"],
  ["favorites", "收藏数", ["collect_count", "favorite_count"], "count"],
  ["platform.danmaku_count", "弹幕数", ["danmaku_count", "danmaku_total"], "count"],
];

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--url") result.url = argv[++index];
    else if (argv[index] === "--output") result.output = resolve(argv[++index]);
    else throw new Error(`未知参数：${argv[index]}`);
  }
  if (!result.url) throw new Error("--url 必填");
  if (!result.output) throw new Error("--output 必填");
  return result;
}

function extractVideoId(value) {
  const text = String(value || "");
  return text.match(/\/video\/([0-9]{12,})/)?.[1]
    || text.match(/[?&](?:modal_id|item_id|video_id)=([0-9]{12,})/)?.[1]
    || (/^[0-9]{12,}$/.test(text) ? text : "");
}

function extractJsonObject(text, startIndex) {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = startIndex; index < text.length; index += 1) {
    const character = text[index];
    if (escaped) { escaped = false; continue; }
    if (character === "\\" && inString) { escaped = true; continue; }
    if (character === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (character === "{") depth += 1;
    else if (character === "}" && --depth === 0) return text.slice(startIndex, index + 1);
  }
  return "";
}

function cookiePairs(headers) {
  return (headers.getSetCookie?.() || [])
    .map(value => String(value).split(";", 1)[0]?.trim())
    .filter(value => value?.includes("="));
}

function cookieMap(pairs) {
  const result = new Map();
  for (const pair of pairs) {
    const at = pair.indexOf("=");
    if (at > 0) result.set(pair.slice(0, at), pair.slice(at + 1));
  }
  return result;
}

function cookieHeader(cookies) {
  return [...cookies].map(([key, value]) => `${key}=${value}`).join("; ");
}

function firstFinite(source, names) {
  for (const name of names) {
    const value = Number(source?.[name]);
    if (Number.isFinite(value) && value >= 0) return value;
  }
  return null;
}

function findAwemeItem(router) {
  for (const loader of Object.values(router?.loaderData || {})) {
    const candidates = [
      loader?.videoInfoRes?.item_list?.[0],
      loader?.aweme?.detail,
      loader?.aweme_detail,
      loader?.itemInfo?.itemStruct,
    ];
    const item = candidates.find(Boolean);
    if (item) return item;
  }
  return null;
}

async function resolveVideoId(url) {
  const direct = extractVideoId(url);
  if (direct) return direct;
  const response = await fetch(url, {
    redirect: "follow",
    headers: { "User-Agent": MOBILE_UA, Accept: "text/html,*/*" },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`分享链接解析失败 HTTP ${response.status}`);
  const html = await response.text();
  const resolved = extractVideoId(response.url)
    || extractVideoId(html.match(/https?:\\?\/\\?\/[^"]+/)?.[0]?.replaceAll("\\/", "/"));
  if (!resolved) throw new Error("无法从链接解析抖音作品 ID");
  return resolved;
}

async function fetchPublicItem(videoId) {
  const registration = await fetch("https://ttwid.bytedance.com/ttwid/union/register/", {
    method: "POST",
    headers: { "Content-Type": "application/json", "User-Agent": MOBILE_UA },
    body: JSON.stringify({
      region: "cn",
      aid: 1128,
      needFid: false,
      service: "www.iesdouyin.com",
      migrate_info: { ticket: "", source: "node" },
      cbUrlProtocol: "https",
      union: true,
    }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!registration.ok) throw new Error(`匿名会话初始化失败 HTTP ${registration.status}`);
  const cookies = cookieMap(cookiePairs(registration.headers));
  const shareUrl = `https://www.iesdouyin.com/share/video/${videoId}`;
  const response = await fetch(shareUrl, {
    headers: {
      "User-Agent": MOBILE_UA,
      Accept: "text/html,*/*",
      Cookie: cookieHeader(cookies),
    },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`匿名分享页 HTTP ${response.status}`);
  const html = await response.text();
  const marker = html.match(/window\._ROUTER_DATA\s*=\s*/);
  if (!marker || marker.index == null) throw new Error("分享页缺少 _ROUTER_DATA");
  const start = html.indexOf("{", marker.index + marker[0].length);
  const raw = extractJsonObject(html, start);
  if (!raw) throw new Error("分享页公开数据不完整");
  const item = findAwemeItem(JSON.parse(raw));
  if (!item) throw new Error("分享页缺少作品详情");
  return { item, shareUrl };
}

function metricRows(statistics) {
  return METRIC_FIELDS.map(([name, rawLabel, aliases, unit, zeroMeansUnavailable = false]) => {
    const value = firstFinite(statistics, aliases);
    return value == null || (zeroMeansUnavailable && value === 0)
      ? {
        name,
        raw_label: rawLabel,
        value: null,
        unit,
        definition: zeroMeansUnavailable && value === 0
          ? "抖音匿名公开分享页以 0 作为未公开播放量的占位值"
          : "抖音匿名公开分享页当前未提供该字段",
        availability: "unavailable",
      }
      : {
        name,
        raw_label: rawLabel,
        value,
        unit,
        definition: "抖音匿名公开分享页当前显示口径",
        availability: "available",
      };
  });
}

async function atomicWrite(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporary, path);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const videoId = await resolveVideoId(options.url);
  const { item, shareUrl } = await fetchPublicItem(videoId);
  const statistics = item?.statistics && typeof item.statistics === "object"
    ? item.statistics
    : {};
  const collectedAt = new Date().toISOString();
  const publishedAt = Number(item?.create_time) > 0
    ? new Date(Number(item.create_time) * 1000).toISOString()
    : null;
  const output = {
    schema_version: 1,
    platform: "douyin",
    source_method: "anonymous_public_api",
    video_id: String(item?.aweme_id || videoId),
    canonical_url: `https://www.douyin.com/video/${videoId}`,
    share_url: shareUrl,
    title: item?.desc || null,
    author_name: item?.author?.nickname || null,
    published_at: publishedAt,
    collected_at: collectedAt,
    duration_ms: firstFinite(item, ["duration"]) ?? firstFinite(item?.video, ["duration"]),
    metrics: metricRows(statistics),
    raw_statistics: statistics,
    evidence: {
      kind: "api_response",
      collected_at: collectedAt,
      source_url: shareUrl,
      content_id: String(item?.aweme_id || videoId),
    },
    boundary: "仅包含采集时抖音匿名公开分享页可见数据，不包含曝光、完播率、平均播放时长、流量来源或观众画像等后台专属指标。",
  };
  await atomicWrite(options.output, output);
  process.stdout.write(`${JSON.stringify({
    ok: true,
    output: options.output,
    video_id: output.video_id,
    title: output.title,
    published_at: output.published_at,
    collected_at: output.collected_at,
    available_metrics: output.metrics.filter(metric => metric.availability === "available").map(metric => metric.name),
  })}\n`);
}

main().catch(error => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});

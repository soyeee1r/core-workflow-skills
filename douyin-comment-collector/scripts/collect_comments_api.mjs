#!/usr/bin/env node

import { readFile, mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const SIGNER_FILE = resolve(SCRIPT_DIR, "../third_party/MediaCrawler/douyin.js");
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36";
const MOBILE_UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1";

function parseArgs(argv) {
  const result = {
    limit: 200,
    probe: false,
    adaptive: false,
    minLimit: 100,
    batchSize: 50,
    staleBatchesRequired: 2,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--url") result.url = argv[++index];
    else if (value === "--output-dir") result.outputDir = argv[++index];
    else if (value === "--limit") result.limit = Number(argv[++index]);
    else if (value === "--adaptive") result.adaptive = true;
    else if (value === "--fixed-limit") result.adaptive = false;
    else if (value === "--min-limit") result.minLimit = Number(argv[++index]);
    else if (value === "--batch-size") result.batchSize = Number(argv[++index]);
    else if (value === "--stale-batches") result.staleBatchesRequired = Number(argv[++index]);
    else if (value === "--probe") result.probe = true;
    else if (value === "--self-test") result.selfTest = true;
    else throw new Error(`未知参数：${value}`);
  }
  return result;
}

const PROBLEM_SIGNAL = /(?:问题|错误|不对|不准|不合理|骗人|欺诈|BUG|bug|卡顿|崩溃|失效|不好用|难用|太贵|续航|发热|虚焊|强制|投诉|为什么|怎么|为何|能不能|有没有|是否|多少|哪里)/u;
const POSITIVE_SIGNAL = /(?:喜欢|好看|精彩|优秀|厉害|牛|支持|推荐|感谢|学到|有用|舒服|惊喜|靠谱|认可|致敬|真香)/u;

function normalizedText(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, "")
    .slice(0, 240);
}

function textFeatures(value) {
  const text = normalizedText(value);
  const features = new Set();
  for (let index = 0; index < text.length - 1; index += 1) {
    features.add(text.slice(index, index + 2));
  }
  return features;
}

function jaccard(left, right) {
  if (!left.size || !right.size) return 0;
  let intersection = 0;
  for (const item of left) if (right.has(item)) intersection += 1;
  return intersection / (left.size + right.size - intersection);
}

function isValuableCandidate(row) {
  const text = normalizedText(row?.text);
  if (text.length < 4) return false;
  const likes = Number(row?.like_count || 0);
  const replies = Number(row?.reply_count || 0);
  return likes >= 10
    || replies >= 2
    || Boolean(row?.is_pinned)
    || Boolean(row?.is_creator)
    || (text.length >= 8 && PROBLEM_SIGNAL.test(text))
    || (text.length >= 8 && POSITIVE_SIGNAL.test(text))
    || text.length >= 24;
}

function assessAdaptiveBatch(allRows, start, end) {
  const priorCandidates = allRows.slice(0, start).filter(isValuableCandidate);
  const batch = allRows.slice(start, end);
  const priorFeatures = priorCandidates.map(row => textFeatures(row.text));
  const acceptedFeatures = [];
  const novelOrders = [];
  let breakoutInteraction = false;
  for (const row of batch) {
    if (!isValuableCandidate(row)) continue;
    const likes = Number(row?.like_count || 0);
    const replies = Number(row?.reply_count || 0);
    if (likes >= 100 || replies >= 10) breakoutInteraction = true;
    const features = textFeatures(row.text);
    const similarToKnown = [...priorFeatures, ...acceptedFeatures]
      .some(known => jaccard(features, known) >= 0.55);
    if (!similarToKnown) {
      novelOrders.push(Number(row.source_order || 0));
      acceptedFeatures.push(features);
    }
  }
  return {
    start: start + 1,
    end,
    records: batch.length,
    valuable_candidates: batch.filter(isValuableCandidate).length,
    novel_value_count: novelOrders.length,
    breakout_interaction: breakoutInteraction,
    novel_source_orders: novelOrders,
    low_increment: novelOrders.length < 2 && !breakoutInteraction,
  };
}

function runSelfTest() {
  const prior = Array.from({ length: 100 }, (_, index) => ({
    text: `普通重复评论${index % 2}`,
    like_count: 0,
    reply_count: 0,
    source_order: index + 1,
  }));
  const staleBatch = Array.from({ length: 50 }, (_, index) => ({
    text: `普通重复评论${index % 2}`,
    like_count: 0,
    reply_count: 0,
    source_order: 101 + index,
  }));
  const valuableBatch = Array.from({ length: 50 }, (_, index) => ({
    text: index === 0 ? "为什么这个产品续航这么差，充电也太频繁了" : "路过看看",
    like_count: index === 0 ? 180 : 0,
    reply_count: index === 0 ? 12 : 0,
    source_order: 151 + index,
  }));
  const stale = assessAdaptiveBatch([...prior, ...staleBatch], 100, 150);
  const valuable = assessAdaptiveBatch([...prior, ...staleBatch, ...valuableBatch], 150, 200);
  if (!stale.low_increment || stale.novel_value_count !== 0) {
    throw new Error("自适应低增量批次判断失败");
  }
  if (valuable.low_increment || !valuable.breakout_interaction || valuable.novel_value_count < 1) {
    throw new Error("自适应新增价值批次判断失败");
  }
  return { ok: true, self_test: "passed", stale, valuable };
}

function parseCookie(cookie) {
  const values = new Map();
  for (const part of cookie.split(";")) {
    const separator = part.indexOf("=");
    if (separator <= 0) continue;
    values.set(part.slice(0, separator).trim(), part.slice(separator + 1).trim());
  }
  return values;
}

function cookiePairs(setCookies) {
  const pairs = [];
  for (const item of setCookies) {
    const pair = String(item).split(";", 1)[0]?.trim();
    if (pair?.includes("=")) pairs.push(pair);
  }
  return pairs;
}

async function loadSigner() {
  const source = await readFile(SIGNER_FILE, "utf8");
  const context = vm.createContext({ console: { log() {}, warn() {}, error() {} } });
  vm.runInContext(source, context, { filename: SIGNER_FILE, timeout: 3000 });
  if (typeof context.sign_datail !== "function" || typeof context.sign_reply !== "function") {
    throw new Error("MediaCrawler 抖音签名器加载失败");
  }
  return context;
}

function videoIdFromUrl(value) {
  const text = String(value || "");
  return text.match(/[?&](?:modal_id|item_id|video_id)=([0-9]+)/i)?.[1]
    || text.match(/\/video\/([0-9]+)/i)?.[1]
    || (/^[0-9]{12,}$/.test(text) ? text : null);
}

function webId() {
  let value = "7";
  for (let index = 1; index < 19; index += 1) value += Math.floor(Math.random() * 10);
  return value;
}

function commonParams(cookieValues, sessionWebId = null) {
  const values = {
    device_platform: "webapp",
    aid: "6383",
    channel: "channel_pc_web",
    version_code: "190600",
    version_name: "19.6.0",
    update_version_code: "170400",
    pc_client_type: "1",
    cookie_enabled: "true",
    browser_language: "zh-CN",
    browser_platform: "MacIntel",
    browser_name: "Chrome",
    browser_version: "151.0.0.0",
    browser_online: "true",
    engine_name: "Blink",
    os_name: "Mac OS",
    os_version: "10.15.7",
    cpu_core_num: "8",
    device_memory: "8",
    engine_version: "151.0",
    platform: "PC",
    screen_width: "2560",
    screen_height: "1440",
    effective_type: "4g",
    round_trip_time: "50",
    webid: sessionWebId || webId(),
  };
  const msToken = cookieValues.get("msToken");
  if (msToken) values.msToken = msToken;
  return values;
}

async function requestComments({ uri, params, signer, cookie, cookieValues, referer, sessionWebId }) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries({ ...params, ...commonParams(cookieValues, sessionWebId) })) {
    if (value !== undefined && value !== null && value !== "") query.set(key, String(value));
  }
  const sign = uri.includes("/reply/") ? signer.sign_reply : signer.sign_datail;
  query.set("a_bogus", sign(query.toString(), UA));
  const response = await fetch(`https://www.douyin.com${uri}?${query}`, {
    method: "GET",
    headers: {
      Accept: "application/json, text/plain, */*",
      Cookie: cookie,
      Referer: referer,
      "User-Agent": UA,
    },
    redirect: "error",
    signal: AbortSignal.timeout(30_000),
  });
  const body = await response.text();
  if (!response.ok) {
    const error = new Error(`抖音评论接口返回 HTTP ${response.status}`);
    error.code = response.status === 401 || response.status === 403 ? "cookie_invalid_or_denied" : "http_error";
    throw error;
  }
  let payload;
  try {
    payload = JSON.parse(body);
  } catch {
    const sample = body.replace(/\s+/g, " ").slice(0, 160);
    const contentType = response.headers.get("content-type") || "unknown";
    const error = new Error(`抖音评论接口没有返回 JSON（type=${contentType}, bytes=${body.length}, sample=${sample}）`);
    error.code = "cookie_invalid_or_denied";
    throw error;
  }
  if (payload?.status_code && Number(payload.status_code) !== 0) {
    const error = new Error(`抖音评论接口状态异常：${payload.status_code}`);
    error.code = "cookie_invalid_or_denied";
    throw error;
  }
  return payload;
}

function extractJsonObject(text, startIndex) {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = startIndex; index < text.length; index += 1) {
    const character = text[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === "\\" && inString) {
      escaped = true;
      continue;
    }
    if (character === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (character === "{") depth += 1;
    else if (character === "}" && --depth === 0) return text.slice(startIndex, index + 1);
  }
  return null;
}

async function createAnonymousSession(videoId) {
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
  const cookieMap = parseCookie(cookiePairs(registration.headers.getSetCookie?.() || []).join("; "));
  const response = await fetch(`https://www.iesdouyin.com/share/video/${videoId}`, {
    headers: {
      "User-Agent": MOBILE_UA,
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "zh-CN,zh;q=0.9",
      Cookie: [...cookieMap].map(([name, value]) => `${name}=${value}`).join("; "),
    },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`抖音匿名分享页返回 HTTP ${response.status}`);
  for (const pair of cookiePairs(response.headers.getSetCookie?.() || [])) {
    const separator = pair.indexOf("=");
    if (separator > 0) cookieMap.set(pair.slice(0, separator), pair.slice(separator + 1));
  }
  const html = await response.text();
  const marker = html.match(/window\._ROUTER_DATA\s*=\s*/);
  if (!marker || marker.index == null) throw new Error("抖音匿名分享页缺少 _ROUTER_DATA");
  const start = html.indexOf("{", marker.index + marker[0].length);
  if (start < 0) throw new Error("抖音匿名分享页数据不完整");
  const json = extractJsonObject(html, start);
  if (!json) throw new Error("抖音匿名分享页数据解析失败");
  const routerData = JSON.parse(json);
  let title = null;
  let sessionWebId = null;
  for (const loader of Object.values(routerData?.loaderData || {})) {
    if (!sessionWebId && loader?.webId) sessionWebId = String(loader.webId);
    const candidate = loader?.videoInfoRes?.item_list?.[0]?.desc;
    if (!title && typeof candidate === "string" && candidate.trim()) title = candidate.trim();
  }
  if (!sessionWebId) throw new Error("抖音匿名分享页缺少 webId");
  return {
    title,
    webId: sessionWebId,
    cookie: [...cookieMap].map(([name, value]) => `${name}=${value}`).join("; "),
  };
}

function normalizeComment(item, order, forcedParent = null) {
  const parent = forcedParent || (item?.reply_id && String(item.reply_id) !== "0" ? String(item.reply_id) : null);
  const created = Number(item?.create_time);
  return {
    comment_id: item?.cid == null ? null : String(item.cid),
    parent_comment_id: parent,
    author_name: item?.user?.nickname || null,
    author_profile_url: null,
    text: item?.text || null,
    like_count: item?.digg_count ?? null,
    reply_count: item?.reply_comment_total ?? null,
    created_at: Number.isFinite(created) && created > 0 ? new Date(created * 1000).toISOString() : null,
    location_label: item?.ip_label || null,
    is_reply: parent !== null,
    is_pinned: Boolean(item?.stick_position),
    is_creator: Boolean(item?.is_author),
    source_order: order,
  };
}

function dedupe(rows) {
  const seen = new Set();
  return rows.filter(row => {
    const key = row.comment_id
      ? `id:${row.comment_id}`
      : `text:${row.parent_comment_id || ""}\u001f${row.author_name || ""}\u001f${row.text || ""}\u001f${row.created_at || ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).map((row, index) => ({ ...row, source_order: index + 1 }));
}

async function collect(options) {
  if (!options.url || !options.outputDir) throw new Error("--url 和 --output-dir 必填");
  if (!Number.isInteger(options.limit) || options.limit < 1 || options.limit > 500) throw new Error("limit 必须在 1–500 之间");
  if (!Number.isInteger(options.minLimit) || options.minLimit < 1 || options.minLimit > options.limit) {
    throw new Error("min-limit 必须在 1 和 limit 之间");
  }
  if (!Number.isInteger(options.batchSize) || options.batchSize < 10 || options.batchSize > 100) {
    throw new Error("batch-size 必须在 10–100 之间");
  }
  if (!Number.isInteger(options.staleBatchesRequired) || options.staleBatchesRequired < 1 || options.staleBatchesRequired > 5) {
    throw new Error("stale-batches 必须在 1–5 之间");
  }
  const sourceUrl = String(options.url);
  const videoId = videoIdFromUrl(sourceUrl);
  if (!videoId) throw new Error("无法从链接解析抖音作品 ID；请提供完整作品链接");
  const signer = await loadSigner();
  const session = await createAnonymousSession(videoId);
  const cookieValues = parseCookie(session.cookie);
  const rows = [];
  const rootComments = [];
  let cursor = 0;
  let hasMore = true;
  let rootPages = 0;
  let replyPages = 0;
  let nextAdaptiveCheckpoint = options.minLimit + options.batchSize;
  let consecutiveLowIncrementBatches = 0;
  let adaptiveStopAt = null;
  const adaptiveBatches = [];
  const assessAdaptiveProgress = () => {
    if (!options.adaptive || adaptiveStopAt != null) return;
    const uniqueRows = dedupe(rows);
    while (uniqueRows.length >= nextAdaptiveCheckpoint && adaptiveStopAt == null) {
      const assessment = assessAdaptiveBatch(
        uniqueRows,
        nextAdaptiveCheckpoint - options.batchSize,
        nextAdaptiveCheckpoint,
      );
      consecutiveLowIncrementBatches = assessment.low_increment
        ? consecutiveLowIncrementBatches + 1
        : 0;
      adaptiveBatches.push({
        ...assessment,
        consecutive_low_increment_batches: consecutiveLowIncrementBatches,
      });
      if (consecutiveLowIncrementBatches >= options.staleBatchesRequired) {
        adaptiveStopAt = nextAdaptiveCheckpoint;
      }
      nextAdaptiveCheckpoint += options.batchSize;
    }
  };
  const seenCursors = new Set();
  while (hasMore && dedupe(rows).length < options.limit && !seenCursors.has(cursor) && adaptiveStopAt == null) {
    seenCursors.add(cursor);
    const payload = await requestComments({
      uri: "/aweme/v1/web/comment/list/",
      params: { aweme_id: videoId, cursor, count: 20, item_type: 0 },
      signer,
      cookie: session.cookie,
      cookieValues,
      referer: `https://www.douyin.com/video/${videoId}`,
      sessionWebId: session.webId,
    });
    for (const comment of (Array.isArray(payload?.comments) ? payload.comments : [])) {
      rootComments.push(comment);
      rows.push(normalizeComment(comment, rows.length + 1));
    }
    rootPages += 1;
    assessAdaptiveProgress();
    hasMore = Boolean(payload?.has_more);
    const nextCursor = Number(payload?.cursor || 0);
    if (hasMore && nextCursor === cursor) break;
    cursor = nextCursor;
    if (hasMore && dedupe(rows).length < options.limit && adaptiveStopAt == null) {
      await new Promise(resolveDelay => setTimeout(resolveDelay, 700));
    }
  }
  // Anonymous top-level pagination may expose a finite visible window even when
  // a work has many more total comments. Continue through replies that belong
  // to the collected top-level comments so the requested sample is real rather
  // than padding or repeating the legacy ten-comment hot list.
  for (const root of rootComments) {
    if (dedupe(rows).length >= options.limit || adaptiveStopAt != null) break;
    const rootId = String(root?.cid || "");
    const replyTotal = Number(root?.reply_comment_total || 0);
    if (!rootId || replyTotal < 1) continue;
    let replyCursor = 0;
    let replyHasMore = true;
    const seenReplyCursors = new Set();
    while (replyHasMore && dedupe(rows).length < options.limit
        && !seenReplyCursors.has(replyCursor) && adaptiveStopAt == null) {
      seenReplyCursors.add(replyCursor);
      const payload = await requestComments({
        uri: "/aweme/v1/web/comment/list/reply/",
        params: { comment_id: rootId, cursor: replyCursor, count: 20, item_type: 0, item_id: videoId },
        signer,
        cookie: session.cookie,
        cookieValues,
        referer: `https://www.douyin.com/video/${videoId}`,
        sessionWebId: session.webId,
      });
      for (const reply of (Array.isArray(payload?.comments) ? payload.comments : [])) {
        const normalized = normalizeComment(reply, rows.length + 1);
        rows.push({ ...normalized, parent_comment_id: normalized.parent_comment_id || rootId, is_reply: true });
      }
      replyPages += 1;
      assessAdaptiveProgress();
      replyHasMore = Boolean(payload?.has_more);
      const nextReplyCursor = Number(payload?.cursor || 0);
      if (replyHasMore && nextReplyCursor === replyCursor) break;
      replyCursor = nextReplyCursor;
      if (replyHasMore && dedupe(rows).length < options.limit && adaptiveStopAt == null) {
        await new Promise(resolveDelay => setTimeout(resolveDelay, 700));
      }
    }
  }
  const effectiveLimit = adaptiveStopAt || options.limit;
  const comments = dedupe(rows).slice(0, effectiveLimit);
  const reachedHardLimit = comments.length >= options.limit && adaptiveStopAt == null;
  const status = adaptiveStopAt != null
    ? "adaptive_saturation"
    : (reachedHardLimit ? "limit_reached" : "complete_visible_range");
  const stopReason = adaptiveStopAt != null
    ? `two consecutive ${options.batchSize}-comment batches added fewer than two novel valuable signals`
    : (reachedHardLimit ? "reached requested hard limit" : "paginated comment API visible range ended");
  const sourceTitle = session.title;
  const outputDir = resolve(options.outputDir);
  await mkdir(outputDir, { recursive: true });
  const outputFile = resolve(outputDir, "raw-comments.json");
  await writeFile(outputFile, JSON.stringify({
    collection: {
      platform: "douyin",
      video_id: videoId,
      source_url: sourceUrl,
      source_title: sourceTitle,
      collected_at: new Date().toISOString(),
      status,
      stop_reason: stopReason,
      requested_limit: options.limit,
      adaptive: options.adaptive,
      adaptive_min_limit: options.minLimit,
      adaptive_batch_size: options.batchSize,
      adaptive_stale_batches_required: options.staleBatchesRequired,
      adaptive_stop_at: adaptiveStopAt,
      adaptive_batches: adaptiveBatches,
      backend: "anonymous_paginated_api",
      replies_available: true,
      replies_collected: rows.some(row => row.is_reply),
      root_comment_count: comments.filter(row => !row.is_reply).length,
      reply_comment_count: comments.filter(row => row.is_reply).length,
      root_pages: rootPages,
      reply_pages: replyPages,
    },
    comments,
  }, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
  return { ok: true, backend: "anonymous_paginated_api", output_file: outputFile, video_id: videoId, collected_count: comments.length };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.selfTest) return runSelfTest();
  if (options.probe) {
    return { ok: true, backend: "anonymous_paginated_api", configured: true, browser_required: false, account_cookie_required: false };
  }
  return collect(options);
}

main().then(result => process.stdout.write(JSON.stringify(result) + "\n")).catch(error => {
  process.stderr.write(JSON.stringify({ ok: false, code: error.code || "collection_failed", error: error.message }) + "\n");
  process.exitCode = 2;
});

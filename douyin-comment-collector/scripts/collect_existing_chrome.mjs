#!/usr/bin/env node

import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium } from "/Users/mac/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs";

const DEFAULT_ENDPOINT = process.env.DOUYIN_CDP_ENDPOINT || "ws://127.0.0.1:9222/devtools/browser";
const COMMENT_API = /\/aweme\/v1\/web\/comment\/(?:list|list\/reply)/i;
const BLOCKED_TEXT = /验证码|滑块|访问频繁|操作频繁|安全验证|登录后查看|扫码登录|网络错误|页面不存在|内容暂时无法查看/i;
const EMPTY_TEXT = /暂无评论|还没有评论|评论为空/i;

function parseArgs(argv) {
  const result = { limit: 100, endpoint: DEFAULT_ENDPOINT, probe: false, selfTest: false };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--probe") result.probe = true;
    else if (value === "--self-test") result.selfTest = true;
    else if (value === "--url") result.url = argv[++index];
    else if (value === "--output-dir") result.outputDir = argv[++index];
    else if (value === "--limit") result.limit = Number(argv[++index]);
    else if (value === "--endpoint") result.endpoint = argv[++index];
    else throw new Error(`unknown argument: ${value}`);
  }
  return result;
}

function assertDouyinUrl(value) {
  const url = new URL(String(value || ""));
  if (!/(^|\.)douyin\.com$|(^|\.)iesdouyin\.com$/i.test(url.hostname)) {
    throw new Error("only douyin.com links are supported");
  }
  return url.toString();
}

function firstValue(object, keys) {
  for (const key of keys) {
    if (object?.[key] !== undefined && object?.[key] !== null && object?.[key] !== "") {
      return object[key];
    }
  }
  return null;
}

function normalizeApiComment(item, parentCommentId, sourceOrder) {
  const user = item?.user && typeof item.user === "object" ? item.user : {};
  const commentId = firstValue(item, ["cid", "comment_id", "id"]);
  const replyId = firstValue(item, ["reply_id", "reply_to_reply_id"]);
  const parentId = parentCommentId || (replyId && String(replyId) !== "0" ? replyId : null);
  const createTime = Number(firstValue(item, ["create_time", "created_at"]));
  return {
    comment_id: commentId == null ? null : String(commentId),
    parent_comment_id: parentId == null ? null : String(parentId),
    author_name: firstValue(user, ["nickname", "display_name", "name"]),
    author_profile_url: null,
    text: firstValue(item, ["text", "content"]),
    like_count: firstValue(item, ["digg_count", "like_count"]),
    reply_count: firstValue(item, ["reply_comment_total", "reply_count"]),
    created_at: Number.isFinite(createTime) && createTime > 0
      ? new Date(createTime * 1000).toISOString()
      : null,
    location_label: firstValue(item, ["ip_label", "ip_location"]),
    is_reply: parentId !== null,
    is_pinned: Boolean(firstValue(item, ["stick_position", "is_pinned"])),
    is_creator: Boolean(firstValue(item, ["is_author", "is_creator"])),
    source_order: sourceOrder,
  };
}

function commentsFromPayload(payload, startOrder = 1) {
  const output = [];
  let order = startOrder;
  const visit = (item, parentId = null) => {
    if (!item || typeof item !== "object") return;
    const normalized = normalizeApiComment(item, parentId, order++);
    output.push(normalized);
    const childParent = normalized.comment_id || parentId;
    for (const key of ["reply_comment", "reply_comments", "replies", "sub_comments"]) {
      if (Array.isArray(item[key])) {
        for (const child of item[key]) visit(child, childParent);
      }
    }
  };
  const roots = Array.isArray(payload?.comments)
    ? payload.comments
    : (Array.isArray(payload?.data?.comments) ? payload.data.comments : []);
  for (const item of roots) visit(item);
  return output;
}

function dedupeComments(rows) {
  const seen = new Set();
  const output = [];
  for (const row of rows) {
    const key = row.comment_id
      ? `id:${row.comment_id}`
      : `text:${row.parent_comment_id || ""}\u001f${row.author_name || ""}\u001f${row.text || ""}\u001f${row.created_at || ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    output.push({ ...row, source_order: output.length + 1 });
  }
  return output;
}

async function fallbackDomComments(page, startOrder) {
  const selectors = [
    '[data-e2e="comment-item"]',
    '[data-e2e*="comment-item"]',
    '[data-comment-id]',
    'div[class*="comment-item"]',
    'div[class*="CommentItem"]',
  ];
  for (const selector of selectors) {
    const locator = page.locator(selector);
    const count = Math.min(await locator.count().catch(() => 0), 150);
    if (!count) continue;
    const rows = [];
    for (let index = 0; index < count; index += 1) {
      const node = locator.nth(index);
      const text = String(await node.innerText({ timeout: 1000 }).catch(() => "")).trim();
      if (!text) continue;
      const lines = text.split(/\n+/).map(value => value.trim()).filter(Boolean);
      rows.push({
        comment_id: await node.getAttribute("data-comment-id").catch(() => null),
        parent_comment_id: null,
        author_name: lines[0] || null,
        author_profile_url: null,
        text: lines.slice(1).join(" ") || lines[0],
        like_count: null,
        reply_count: null,
        created_at: null,
        location_label: null,
        is_reply: false,
        is_pinned: false,
        is_creator: false,
        source_order: startOrder + rows.length,
      });
    }
    if (rows.length) return rows;
  }
  return [];
}

async function clickReplyExpanders(page) {
  const patterns = [/展开.*回复/, /查看.*回复/, /更多回复/, /展开更多/];
  let clicked = 0;
  for (const pattern of patterns) {
    const locator = page.getByText(pattern);
    const count = Math.min(await locator.count().catch(() => 0), 12);
    for (let index = 0; index < count; index += 1) {
      const target = locator.nth(index);
      if (await target.isVisible().catch(() => false)) {
        await target.click({ timeout: 1200 }).catch(() => {});
        clicked += 1;
      }
    }
  }
  return clicked;
}

async function connectExisting(endpoint) {
  const candidates = String(endpoint).startsWith("http")
    ? ["ws://127.0.0.1:9222/devtools/browser", endpoint]
    : [endpoint, "http://127.0.0.1:9222"];
  const failures = [];
  for (const candidate of [...new Set(candidates)]) {
    try {
      return await chromium.connectOverCDP(candidate, { timeout: 60_000 });
    } catch (error) {
      failures.push(`${candidate}: ${String(error?.message || error).split("\n")[0]}`);
    }
  }
  try {
    throw new Error(failures.join(" | "));
  } catch (error) {
    const wrapped = new Error(
      "无法连接现有 Chrome CDP。请确认 chrome://inspect/#remote-debugging 已开启，并在 Chrome 弹出的连接确认框点击允许；0615 不会启动新浏览器或读取 Cookie。",
    );
    wrapped.code = "cdp_unavailable";
    wrapped.cause = error;
    throw wrapped;
  }
}

async function collect(options) {
  const sourceUrl = assertDouyinUrl(options.url);
  if (!Number.isInteger(options.limit) || options.limit < 1 || options.limit > 100) {
    throw new Error("--limit must be an integer between 1 and 100");
  }
  if (!options.outputDir) throw new Error("--output-dir is required");

  const browser = await connectExisting(options.endpoint);
  const contexts = browser.contexts();
  if (!contexts.length) {
    const error = new Error("Chrome 已连接，但没有可用的现有浏览上下文");
    error.code = "cdp_no_context";
    throw error;
  }
  const context = contexts[0];
  const page = await context.newPage();
  const captured = [];
  let responseCount = 0;
  let lastHasMore = null;
  const responseTasks = new Set();

  await page.route("**/*", async route => {
    const type = route.request().resourceType();
    if (["image", "media", "font"].includes(type)) await route.abort();
    else await route.continue();
  });

  page.on("response", response => {
    if (!COMMENT_API.test(response.url())) return;
    const task = response.json()
      .then(payload => {
        responseCount += 1;
        captured.push(...commentsFromPayload(payload, captured.length + 1));
        const hasMore = firstValue(payload, ["has_more"]) ?? firstValue(payload?.data, ["has_more"]);
        if (hasMore !== null) lastHasMore = Boolean(hasMore);
      })
      .catch(() => {})
      .finally(() => responseTasks.delete(task));
    responseTasks.add(task);
  });

  let finalUrl = sourceUrl;
  let title = "";
  let bodyText = "";
  try {
    await page.goto(sourceUrl, { waitUntil: "domcontentloaded", timeout: 35_000 });
    await page.waitForTimeout(2500);
    finalUrl = page.url();
    title = await page.title().catch(() => "");
    bodyText = String(await page.locator("body").innerText({ timeout: 5000 }).catch(() => ""));
    if (BLOCKED_TEXT.test(bodyText)) {
      const error = new Error(`抖音页面需要人工处理：${bodyText.match(BLOCKED_TEXT)?.[0] || "访问受限"}`);
      error.code = /登录|扫码/.test(bodyText) ? "auth_required" : "verification_required";
      throw error;
    }

    let stalled = 0;
    let previousCount = -1;
    for (let pass = 0; pass < 24 && dedupeComments(captured).length < options.limit; pass += 1) {
      await clickReplyExpanders(page);
      await page.mouse.wheel(0, 1000);
      await page.evaluate(() => {
        const candidates = [...document.querySelectorAll("div")]
          .filter(node => node.scrollHeight > node.clientHeight + 400)
          .sort((left, right) => right.scrollHeight - left.scrollHeight);
        for (const node of candidates.slice(0, 3)) node.scrollTop += Math.max(700, node.clientHeight * 0.8);
      }).catch(() => {});
      await page.waitForTimeout(900);
      await Promise.allSettled([...responseTasks]);
      const currentCount = dedupeComments(captured).length;
      stalled = currentCount === previousCount ? stalled + 1 : 0;
      previousCount = currentCount;
      if (lastHasMore === false || stalled >= 3) break;
    }

    await Promise.allSettled([...responseTasks]);
    if (!captured.length) captured.push(...await fallbackDomComments(page, 1));
  } finally {
    await page.close({ runBeforeUnload: false }).catch(() => {});
  }

  const unique = dedupeComments(captured);
  const videoId = finalUrl.match(/[?&](?:modal_id|item_id|video_id)=([0-9]+)/i)?.[1]
    || finalUrl.match(/\/video\/([0-9]+)/i)?.[1]
    || sourceUrl.match(/[?&](?:modal_id|item_id|video_id)=([0-9]+)/i)?.[1]
    || sourceUrl.match(/\/video\/([0-9]+)/i)?.[1]
    || null;
  const reachedLimit = unique.length >= options.limit;
  const confirmedEmpty = unique.length === 0 && EMPTY_TEXT.test(bodyText);
  const status = reachedLimit
    ? "limit_reached"
    : (confirmedEmpty || lastHasMore === false ? "complete_visible_range" : "stalled_after_3_passes");
  const stopReason = reachedLimit
    ? `captured at least ${options.limit} unique visible comments`
    : (confirmedEmpty ? "page explicitly showed no comments" : "comment loading stopped after three passes without new records");
  const payload = {
    collection: {
      platform: "douyin",
      video_id: videoId,
      source_url: finalUrl,
      source_title: title || null,
      collected_at: new Date().toISOString(),
      status,
      stop_reason: stopReason,
      requested_limit: options.limit,
      backend: "existing_chrome_cdp",
      comment_api_responses: responseCount,
    },
    comments: unique.slice(0, options.limit),
  };
  const outputDir = resolve(options.outputDir);
  await mkdir(outputDir, { recursive: true });
  const outputFile = resolve(outputDir, "raw-comments.json");
  await writeFile(outputFile, JSON.stringify(payload, null, 2) + "\n", "utf8");
  return { ok: true, output_file: outputFile, ...payload.collection, collected_count: payload.comments.length };
}

async function probe(endpoint) {
  const browser = await connectExisting(endpoint);
  const contexts = browser.contexts();
  return {
    ok: true,
    backend: "existing_chrome_cdp",
    contexts: contexts.length,
    pages: contexts.reduce((sum, context) => sum + context.pages().length, 0),
  };
}

function selfTest() {
  const fixture = {
    comments: [{
      cid: "c1",
      text: "讲得很清楚",
      digg_count: 9,
      reply_comment_total: 1,
      create_time: 1700000000,
      ip_label: "上海",
      user: { nickname: "用户甲" },
      reply_comment: [{ cid: "c2", text: "确实", user: { nickname: "用户乙" } }],
    }],
  };
  const rows = commentsFromPayload(fixture);
  if (rows.length !== 2
      || rows[0].comment_id !== "c1"
      || rows[1].parent_comment_id !== "c1"
      || dedupeComments([...rows, rows[0]]).length !== 2
      || !assertDouyinUrl("https://www.douyin.com/video/123").includes("douyin.com")) {
    throw new Error("self-test failed");
  }
  return { ok: true, test: "parser" };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const result = options.selfTest
    ? selfTest()
    : (options.probe ? await probe(options.endpoint) : await collect(options));
  process.stdout.write(JSON.stringify(result) + "\n");
}

main().catch(error => {
  process.stderr.write(JSON.stringify({
    ok: false,
    code: error.code || "collection_failed",
    error: error.message,
  }) + "\n");
  process.exitCode = 2;
});

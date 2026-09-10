#!/usr/bin/env node

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const HERE = dirname(fileURLToPath(import.meta.url));

function parseArgs(argv) {
  const options = {
    commentLimit: null,
    minCommentLimit: 100,
    maxCommentLimit: 500,
    commentBatchSize: 50,
    staleBatchesRequired: 2,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--url") options.url = argv[++index];
    else if (value === "--output-dir") options.outputDir = argv[++index];
    else if (value === "--comment-limit") options.commentLimit = Number(argv[++index]);
    else throw new Error(`未知参数：${value}`);
  }
  if (!options.url || !options.outputDir) throw new Error("--url 和 --output-dir 必填");
  if (options.commentLimit !== null
      && (!Number.isInteger(options.commentLimit) || options.commentLimit < 100 || options.commentLimit > 500)) {
    throw new Error("显式 --comment-limit 必须在 100–500 之间");
  }
  options.outputDir = resolve(options.outputDir);
  return options;
}

async function run(program, args, label) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(program, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", chunk => { stdout += chunk; });
    child.stderr.on("data", chunk => { stderr += chunk; });
    child.on("error", rejectRun);
    child.on("close", code => {
      if (code === 0) {
        resolveRun(stdout.trim());
      } else {
        const error = new Error(`${label}失败（exit ${code}）：${stderr.trim() || stdout.trim() || "无输出"}`);
        error.stage = label;
        rejectRun(error);
      }
    });
  });
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const rawCommentsDir = resolve(options.outputDir, "raw/comments");
  const rawDanmakuDir = resolve(options.outputDir, "raw/danmaku");
  const commentsDir = resolve(options.outputDir, "comments");
  const danmakuDir = resolve(options.outputDir, "danmaku");
  await mkdir(options.outputDir, { recursive: true });

  const adaptiveComments = options.commentLimit === null;
  const effectiveCommentLimit = options.commentLimit || options.maxCommentLimit;
  const commentArgs = [
    resolve(HERE, "collect_comments_api.mjs"),
    "--url", options.url,
    "--output-dir", rawCommentsDir,
    "--limit", String(effectiveCommentLimit),
  ];
  if (adaptiveComments) {
    commentArgs.push(
      "--adaptive",
      "--min-limit", String(options.minCommentLimit),
      "--batch-size", String(options.commentBatchSize),
      "--stale-batches", String(options.staleBatchesRequired),
    );
  } else {
    commentArgs.push("--fixed-limit");
  }
  await run(process.execPath, commentArgs, "评论采集");

  await run(process.execPath, [
    resolve(HERE, "collect_danmaku_api.mjs"),
    "--url", options.url,
    "--output-dir", rawDanmakuDir,
  ], "弹幕采集");

  await run("python3", [
    resolve(HERE, "normalize_comments.py"),
    "--input", resolve(rawCommentsDir, "raw-comments.json"),
    "--output-dir", commentsDir,
    "--limit", String(effectiveCommentLimit),
  ], "评论标准化");

  await run("python3", [
    resolve(HERE, "normalize_danmaku.py"),
    "--input", resolve(rawDanmakuDir, "raw-danmaku.json"),
    "--output-dir", danmakuDir,
  ], "弹幕标准化");

  const rawComments = await readJson(resolve(rawCommentsDir, "raw-comments.json"));
  const rawDanmaku = await readJson(resolve(rawDanmakuDir, "raw-danmaku.json"));
  const commentsSummary = await readJson(resolve(commentsDir, "summary.json"));
  const danmakuSummary = await readJson(resolve(danmakuDir, "summary.json"));
  const commentsCollection = rawComments.collection || {};
  const danmakuCollection = rawDanmaku.collection || {};

  if (String(commentsCollection.video_id) !== String(danmakuCollection.video_id)) {
    throw new Error("评论与弹幕作品 ID 不一致，停止合并");
  }

  const summary = {
    platform: "douyin",
    video_id: commentsCollection.video_id,
    source_url: options.url,
    source_title: commentsCollection.source_title || danmakuCollection.source_title || null,
    duration_ms: danmakuCollection.duration_ms || null,
    collected_at: new Date().toISOString(),
    status: "collection_complete",
    comments: {
      status: commentsSummary.status,
      stop_reason: commentsSummary.stop_reason,
      selection_mode: adaptiveComments ? "adaptive" : "fixed_limit",
      requested_limit: options.commentLimit,
      min_limit: adaptiveComments ? options.minCommentLimit : options.commentLimit,
      hard_limit: effectiveCommentLimit,
      batch_size: adaptiveComments ? options.commentBatchSize : null,
      stale_batches_required: adaptiveComments ? options.staleBatchesRequired : null,
      adaptive_stop_at: commentsCollection.adaptive_stop_at || null,
      adaptive_batches: commentsCollection.adaptive_batches || [],
      read: commentsSummary.output_records,
      top_level: commentsSummary.top_level_comments,
      replies: commentsSummary.replies,
      duplicates_removed: commentsSummary.duplicates_removed,
    },
    danmaku: {
      status: danmakuSummary.status,
      stop_reason: danmakuSummary.stop_reason,
      read: danmakuSummary.output_records,
      duplicates_removed: danmakuSummary.duplicates_removed,
      segment_ms: danmakuSummary.segment_ms,
      segment_count: danmakuSummary.segment_count,
      total_likes: danmakuSummary.total_likes,
    },
    outputs: {
      comments_json: resolve(commentsDir, "comments.json"),
      comments_csv: resolve(commentsDir, "comments.csv"),
      danmaku_json: resolve(danmakuDir, "danmaku.json"),
      danmaku_csv: resolve(danmakuDir, "danmaku.csv"),
    },
  };
  const summaryFile = resolve(options.outputDir, "sweep-summary.json");
  await writeFile(summaryFile, JSON.stringify(summary, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
  process.stdout.write(JSON.stringify({ ok: true, summary_file: summaryFile, ...summary }) + "\n");
}

main().catch(error => {
  process.stderr.write(JSON.stringify({
    ok: false,
    stage: error.stage || "unified_pipeline",
    error: error.message,
  }) + "\n");
  process.exitCode = 2;
});

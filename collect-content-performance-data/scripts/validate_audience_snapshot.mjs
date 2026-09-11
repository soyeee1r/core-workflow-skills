#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--input") options.input = resolve(argv[++index]);
    else if (argv[index] === "--sweep-summary") options.summary = resolve(argv[++index]);
    else throw new Error(`未知参数：${argv[index]}`);
  }
  if (!options.input || !options.summary) throw new Error("--input 和 --sweep-summary 必填");
  return options;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function validateChannel(channel, expectedRead, kind) {
  assert(channel && typeof channel === "object", `${kind} 缺失`);
  assert(Number.isInteger(channel.read) && channel.read >= 0, `${kind}.read 非法`);
  assert(channel.read === expectedRead, `${kind}.read 与 sweep-summary 不一致`);
  assert(channel.new_since_previous === null
    || (Number.isInteger(channel.new_since_previous) && channel.new_since_previous >= 0), `${kind}.new_since_previous 非法`);
  assert(channel.sentiment === null || typeof channel.sentiment === "object", `${kind}.sentiment 非法`);
  if (channel.sentiment) {
    for (const name of ["positive", "negative", "mixed", "neutral"]) {
      assert(Number.isInteger(channel.sentiment[name]) && channel.sentiment[name] >= 0, `${kind}.sentiment.${name} 非法`);
    }
  }
  assert(Array.isArray(channel.top_topics), `${kind}.top_topics 必须是数组`);
  for (const topic of channel.top_topics) {
    assert(typeof topic.topic === "string" && topic.topic.trim(), `${kind} 话题名称缺失`);
    assert(Number.isInteger(topic.count) && topic.count >= 3, `${kind} 高频话题不足 3 条`);
    assert(topic.change === null || Number.isInteger(topic.change), `${kind} 话题变化非法`);
  }
  assert(Array.isArray(channel.highlights), `${kind}.highlights 必须是数组`);
  for (const item of channel.highlights) {
    assert(typeof item.text === "string" && item.text.trim(), `${kind} 代表文本缺失`);
    assert(typeof item.label === "string" && item.label.trim(), `${kind} 代表文本分类缺失`);
    const serialized = JSON.stringify(item);
    assert(!/(?:author|user|comment_id|danmaku_id|dedupe|profile|主页)/i.test(serialized), `${kind} 输出含身份或内部标识`);
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const snapshot = JSON.parse(await readFile(options.input, "utf8"));
  const summary = JSON.parse(await readFile(options.summary, "utf8"));
  assert(snapshot.schema_version === 1, "schema_version 必须为 1");
  assert(String(snapshot.video_id) === String(summary.video_id), "作品 ID 与 sweep-summary 不一致");
  assert(["2h", "6h", "24h", "48h", "baseline"].includes(snapshot.window), "窗口非法");
  assert(Number.isFinite(Date.parse(snapshot.collected_at)), "collected_at 非法");
  validateChannel(snapshot.comments, Number(summary.comments?.read), "comments");
  validateChannel(snapshot.danmaku, Number(summary.danmaku?.read), "danmaku");
  assert(Array.isArray(snapshot.danmaku.density), "danmaku.density 必须是数组");
  assert(Array.isArray(snapshot.change_summary), "change_summary 必须是数组");
  process.stdout.write(`${JSON.stringify({ ok: true, input: options.input, video_id: snapshot.video_id, window: snapshot.window })}\n`);
}

main().catch(error => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 2;
});

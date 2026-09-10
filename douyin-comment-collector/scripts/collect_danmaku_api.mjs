#!/usr/bin/env node

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";
import vm from "node:vm";

const HERE = dirname(fileURLToPath(import.meta.url));
const SIGNER_FILE = resolve(HERE, "../third_party/MediaCrawler/douyin.js");
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36";
const DANMAKU_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36";
const MOBILE_UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1";

function args(argv) {
  const result = { outputDir: resolve(HERE, "../tmp-danmaku") };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--url") result.url = argv[++i];
    else if (argv[i] === "--output-dir") result.outputDir = resolve(argv[++i]);
    else throw new Error(`未知参数：${argv[i]}`);
  }
  if (!result.url) throw new Error("--url 必填");
  return result;
}

function videoId(value) {
  return String(value).match(/\/video\/([0-9]+)/)?.[1]
    || String(value).match(/[?&](?:modal_id|item_id|video_id)=([0-9]+)/)?.[1]
    || (/^[0-9]{12,}$/.test(String(value)) ? String(value) : null);
}

function parseCookie(text) {
  const map = new Map();
  for (const part of String(text || "").split(";")) {
    const at = part.indexOf("=");
    if (at > 0) map.set(part.slice(0, at).trim(), part.slice(at + 1).trim());
  }
  return map;
}

function cookiePairs(headers) {
  return (headers.getSetCookie?.() || [])
    .map(value => String(value).split(";", 1)[0]?.trim())
    .filter(value => value?.includes("="));
}

function cookieString(map) {
  return [...map].map(([key, value]) => `${key}=${value}`).join("; ");
}

function verifyFp() {
  const chars = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
  const time = Date.now().toString(36);
  const value = Array(36).fill("");
  value[8] = value[13] = value[18] = value[23] = "_";
  value[14] = "4";
  for (let i = 0; i < 36; i += 1) {
    if (value[i]) continue;
    const random = Math.floor(Math.random() * chars.length);
    value[i] = chars[i === 19 ? (random & 3) | 8 : random];
  }
  return `verify_${time}_${value.join("")}`;
}

function extractJsonObject(text, startIndex) {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = startIndex; i < text.length; i += 1) {
    const ch = text[i];
    if (escaped) { escaped = false; continue; }
    if (ch === "\\" && inString) { escaped = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === "{") depth += 1;
    else if (ch === "}" && --depth === 0) return text.slice(startIndex, i + 1);
  }
  return null;
}

async function signer() {
  const source = await readFile(SIGNER_FILE, "utf8");
  const context = vm.createContext({ console: { log() {}, warn() {}, error() {} } });
  vm.runInContext(source, context, { filename: SIGNER_FILE, timeout: 3000 });
  if (typeof context.sign_datail !== "function") throw new Error("签名器加载失败");
  return context.sign_datail;
}

async function session(id) {
  const registration = await fetch("https://ttwid.bytedance.com/ttwid/union/register/", {
    method: "POST",
    headers: { "Content-Type": "application/json", "User-Agent": MOBILE_UA },
    body: JSON.stringify({
      region: "cn", aid: 1128, needFid: false, service: "www.iesdouyin.com",
      migrate_info: { ticket: "", source: "node" }, cbUrlProtocol: "https", union: true,
    }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!registration.ok) throw new Error(`匿名会话初始化失败 HTTP ${registration.status}`);
  const cookies = parseCookie(cookiePairs(registration.headers).join("; "));
  const share = await fetch(`https://www.iesdouyin.com/share/video/${id}`, {
    headers: { "User-Agent": MOBILE_UA, Accept: "text/html,*/*", Cookie: cookieString(cookies) },
    signal: AbortSignal.timeout(30_000),
  });
  if (!share.ok) throw new Error(`匿名分享页 HTTP ${share.status}`);
  for (const pair of cookiePairs(share.headers)) {
    const at = pair.indexOf("=");
    cookies.set(pair.slice(0, at), pair.slice(at + 1));
  }
  const html = await share.text();
  const marker = html.match(/window\._ROUTER_DATA\s*=\s*/);
  if (!marker || marker.index == null) throw new Error("分享页缺少 _ROUTER_DATA");
  const start = html.indexOf("{", marker.index + marker[0].length);
  const raw = extractJsonObject(html, start);
  if (!raw) throw new Error("分享页数据不完整");
  const router = JSON.parse(raw);
  let item = null;
  let webId = null;
  for (const loader of Object.values(router?.loaderData || {})) {
    if (!webId && loader?.webId) webId = String(loader.webId);
    if (!item && loader?.videoInfoRes?.item_list?.[0]) item = loader.videoInfoRes.item_list[0];
  }
  if (!webId) throw new Error("分享页缺少 webId");
  const home = await fetch("https://www.douyin.com/", {
    headers: { "User-Agent": UA, Cookie: cookieString(cookies) },
    signal: AbortSignal.timeout(30_000),
  });
  for (const pair of cookiePairs(home.headers)) {
    const at = pair.indexOf("=");
    cookies.set(pair.slice(0, at), pair.slice(at + 1));
  }
  await home.body?.cancel();
  if (!cookies.has("msToken")) cookies.set("msToken", crypto.randomBytes(138).toString("base64url").slice(0, 184));
  return {
    cookies,
    webId,
    title: item?.desc || null,
    duration: Number(item?.duration || item?.video?.duration || 0),
    fp: verifyFp(),
    itemSummary: {
      aweme_id: item?.aweme_id || null,
      duration: Number(item?.duration || item?.video?.duration || 0),
      danmaku_count: item?.statistics?.danmaku_count ?? item?.statistics?.danmaku_total ?? null,
      has_danmaku_control: Boolean(item?.video?.danmaku_control || item?.danmaku_control),
    },
  };
}

function commonParams(s) {
  return {
    device_platform: "webapp", aid: "6383", channel: "channel_pc_web",
    version_code: "170400", version_name: "17.4.0", update_version_code: "170400",
    pc_client_type: "1", cookie_enabled: "true", browser_language: "zh-CN",
    browser_platform: "Win32", browser_name: "Edge", browser_version: "140.0.0.0",
    browser_online: "true", engine_name: "Blink", engine_version: "140.0.0.0",
    os_name: "Windows", os_version: "10", cpu_core_num: "16", device_memory: "8",
    platform: "PC", screen_width: "2328", screen_height: "1310", effective_type: "4g",
    downlink: "1.55", round_trip_time: "200", webid: s.webId,
    msToken: s.cookies.get("msToken"), verifyFp: s.fp, fp: s.fp,
  };
}

function normalize(item, index) {
  const text = item?.text ?? item?.content ?? item?.danmaku_text ?? null;
  const offset = Number(item?.offset_time ?? item?.show_time ?? item?.time ?? item?.position ?? 0);
  return {
    source_order: index + 1,
    danmaku_id: item?.danmaku_id == null && item?.id == null ? null : String(item?.danmaku_id ?? item?.id),
    text: typeof text === "string" ? text.trim() : null,
    offset_ms: Number.isFinite(offset) ? offset : null,
    like_count: item?.digg_count ?? item?.like_count ?? null,
  };
}

async function requestDanmaku({ id, duration, s, sign, host, uri, startTime, endTime }) {
  const params = new URLSearchParams();
  const values = {
    ...commonParams(s), app_name: "aweme", format: "json", group_id: id, item_id: id,
    duration, start_time: startTime, end_time: endTime,
    pc_libra_divert: "Windows", support_h265: "1", support_dash: "1",
  };
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined && value !== null && value !== "") params.set(key, String(value));
  }
  params.set("a_bogus", sign(params.toString(), DANMAKU_UA));
  const response = await fetch(`${host}${uri}?${params}`, {
    headers: {
      Accept: "application/json, text/plain, */*", "Accept-Language": "zh-CN,zh;q=0.9",
      Cookie: cookieString(s.cookies), Referer: "https://www.douyin.com/", "User-Agent": DANMAKU_UA,
      "Sec-Ch-Ua": '"Not_A Brand";v="99", "Chromium";v="125", "Google Chrome";v="125"',
      "Sec-Ch-Ua-Mobile": "?0", "Sec-Ch-Ua-Platform": '"Windows"',
      "Sec-Fetch-Dest": "empty", "Sec-Fetch-Mode": "cors", "Sec-Fetch-Site": "same-origin",
    },
    signal: AbortSignal.timeout(30_000), redirect: "error",
  });
  const body = await response.text();
  let payload = null;
  try { payload = JSON.parse(body); } catch {}
  const list = Array.isArray(payload?.danmaku_list) ? payload.danmaku_list
    : Array.isArray(payload?.data) ? payload.data
    : Array.isArray(payload?.data?.danmaku_list) ? payload.data.danmaku_list : [];
  return {
    probe: {
      host, uri, start_time: startTime, end_time: endTime,
      http_status: response.status, content_type: response.headers.get("content-type"), body_bytes: body.length,
    },
    payloadSummary: payload ? {
      status_code: payload.status_code ?? null,
      status_msg: payload.status_msg ?? null,
      top_level_keys: Object.keys(payload).slice(0, 30),
      list_count: list.length,
    } : { json: false, sample: body.replace(/\s+/g, " ").slice(0, 160) },
    rows: list.map(normalize).filter(row => row.text),
  };
}

async function main() {
  const options = args(process.argv.slice(2));
  const id = videoId(options.url);
  if (!id) throw new Error("无法识别作品 ID");
  const sign = await signer();
  const s = await session(id);
  const duration = s.duration;
  if (!Number.isFinite(duration) || duration <= 0) throw new Error("分享页缺少有效视频时长");
  const segmentMs = 32_000;
  const attempts = [];
  for (let start = 0; start < duration; start += segmentMs) {
    const end = Math.min(start + segmentMs, duration);
    const result = await requestDanmaku({
      id, duration, s, sign, host: "https://www-hj.douyin.com",
      uri: "/aweme/v1/web/danmaku/get_v2/", startTime: start, endTime: end,
    });
    attempts.push(result);
    if (result.probe.http_status !== 200
        || result.payloadSummary?.json === false
        || Number(result.payloadSummary?.status_code ?? 0) !== 0) {
      throw new Error(
        `弹幕分段采集失败：${start}-${end}ms，HTTP ${result.probe.http_status}，`
        + `status_code=${result.payloadSummary?.status_code ?? "non-json"}`,
      );
    }
    if (end < duration) await new Promise(resolveDelay => setTimeout(resolveDelay, 350));
  }
  const rows = [];
  const seen = new Set();
  for (const row of attempts.flatMap(attempt => attempt.rows)) {
    const key = row.danmaku_id ? `id:${row.danmaku_id}` : `${row.offset_ms}\u001f${row.text}`;
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push({ ...row, source_order: rows.length + 1 });
  }
  const output = {
    collection: {
      platform: "douyin", video_id: id, source_url: options.url, source_title: s.title,
      duration_ms: duration, collected_at: new Date().toISOString(), backend: "anonymous_public_danmaku_api",
      browser_required: false, account_cookie_required: false, collected_count: rows.length,
      status: "complete_visible_range", stop_reason: "all duration segments completed",
      segment_ms: segmentMs, segment_count: attempts.length,
      item_summary: s.itemSummary, probes: attempts.map(attempt => ({ ...attempt.probe, ...attempt.payloadSummary })),
    },
    danmaku: rows,
  };
  await mkdir(options.outputDir, { recursive: true });
  const outputFile = resolve(options.outputDir, "raw-danmaku.json");
  await writeFile(outputFile, JSON.stringify(output, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
  process.stdout.write(JSON.stringify({ ok: true, output_file: outputFile, collected_count: rows.length, probes: output.collection.probes }) + "\n");
}

main().catch(error => {
  process.stderr.write(JSON.stringify({ ok: false, error: error.message }) + "\n");
  process.exitCode = 2;
});

#!/usr/bin/env node

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

const WINDOWS = ["2h", "6h", "24h", "48h"];
const METRICS = [
  { key: "views", label: "播放", color: "#ef476f" },
  { key: "likes", label: "点赞", color: "#8b5cf6" },
  { key: "comments", label: "评论", color: "#22c55e" },
  { key: "shares", label: "分享", color: "#38bdf8" },
  { key: "favorites", label: "收藏", color: "#f59e0b" },
];

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--evidence-root") options.evidenceRoot = resolve(argv[++index]);
    else if (value === "--output") options.output = resolve(argv[++index]);
    else if (value === "--title") options.title = argv[++index];
    else if (value === "--current-window") options.currentWindow = argv[++index];
    else if (value === "--video-url") options.videoUrl = argv[++index];
    else if (value === "--doc-url") options.docUrl = argv[++index];
    else throw new Error(`未知参数：${value}`);
  }
  for (const name of ["evidenceRoot", "output", "title", "currentWindow", "videoUrl", "docUrl"]) {
    if (!options[name]) throw new Error(`--${name.replace(/[A-Z]/g, match => `-${match.toLowerCase()}`)} 必填`);
  }
  return options;
}

async function optionalJson(path) {
  try { return JSON.parse(await readFile(path, "utf8")); } catch { return null; }
}

function metricValue(snapshot, name) {
  const metric = snapshot?.metrics?.find(item => item.name === name && item.availability === "available");
  return Number.isFinite(Number(metric?.value)) ? Number(metric.value) : null;
}

function safeJson(value) {
  return JSON.stringify(value).replace(/<\//g, "<\\/").replace(/<!--/g, "<\\!--");
}

function htmlTemplate(data, clientScript) {
  const playbackBadge = data.latestPlayback
    ? `播放补采：${data.latestPlayback.display_value}`
    : "播放量尚未补采";
  const playbackNote = data.latestPlayback
    ? `夸克创作者中心于 ${data.latestPlayback.collected_at_label} 显示播放量 ${data.latestPlayback.display_value}（约 ${new Intl.NumberFormat("zh-CN").format(data.latestPlayback.estimated_count)}）；页面为缩写展示，不是精确整数。`
    : "播放量需由夸克已登录的抖音创作者中心补采，未补采不影响公开数据窗口完成。";
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${data.title}｜互动数据看板</title>
  <style>
    :root{--bg:#f6f7fb;--paper:#fff;--ink:#171927;--muted:#6d7285;--line:#e5e7ef;--accent:#6d4aff;--accent2:#b8ff65;--negative:#f05252;--positive:#18a76b;--radius:22px}*{box-sizing:border-box}body{margin:0;background:linear-gradient(140deg,#f4f1ff 0,#f8fafc 32%,#effcf6 100%);color:var(--ink);font:15px/1.55 Inter,ui-sans-serif,system-ui,-apple-system,"PingFang SC",sans-serif}.wrap{max-width:1180px;margin:auto;padding:34px 20px 72px}.hero{position:relative;overflow:hidden;padding:32px;border-radius:30px;background:#171927;color:#fff}.hero:after{content:"";position:absolute;width:300px;height:300px;border-radius:50%;right:-90px;top:-160px;background:radial-gradient(circle,#b8ff65 0,transparent 68%);opacity:.55}.eyebrow{color:var(--accent2);letter-spacing:.14em;font-size:12px;font-weight:850}.hero h1{position:relative;z-index:1;max-width:860px;margin:9px 0 12px;font-size:clamp(30px,5vw,58px);line-height:1.08}.hero-meta{display:flex;flex-wrap:wrap;gap:10px;position:relative;z-index:1}.badge{border:1px solid #ffffff2b;border-radius:99px;padding:7px 11px;color:#d8dcf2}.layout{display:grid;grid-template-columns:minmax(0,1.65fr) minmax(300px,.9fr);gap:18px;margin-top:18px}.panel{background:var(--paper);border:1px solid #ffffff;border-radius:var(--radius);padding:22px;box-shadow:0 14px 45px #2d285014}.panel h2{margin:0;font-size:20px}.panel-head{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:18px}.control-row{display:flex;flex-wrap:wrap;gap:8px}.chip,.tab,.window-pill{appearance:none;border:1px solid var(--line);background:#fff;color:var(--muted);border-radius:99px;padding:8px 12px;font:inherit;font-weight:720;cursor:pointer;transition:.18s}.chip:hover,.tab:hover,.window-pill:hover{transform:translateY(-1px);border-color:#c8c1ff}.chip.active,.tab.active,.window-pill.active{background:#171927;color:#fff;border-color:#171927}.chart-wrap{position:relative;min-height:320px}.chart-wrap svg{width:100%;height:320px;overflow:visible}.chart-tip{position:absolute;display:none;pointer-events:none;background:#171927;color:#fff;padding:8px 10px;border-radius:10px;font-size:12px;box-shadow:0 8px 24px #0003;z-index:3}.gridline{stroke:#ececf3;stroke-width:1}.axis-label{fill:#8b90a2;font-size:12px}.trend-line{fill:none;stroke-width:4;stroke-linecap:round;stroke-linejoin:round}.trend-area{opacity:.12}.point{stroke:#fff;stroke-width:3;cursor:pointer}.metric-cards{display:grid;grid-template-columns:1fr 1fr;gap:10px}.metric-card{border:1px solid var(--line);border-radius:16px;padding:14px;cursor:pointer}.metric-card.active{border-color:var(--accent);box-shadow:0 0 0 2px #6d4aff16}.metric-card small{color:var(--muted)}.metric-card strong{display:block;font-size:24px;margin-top:3px}.delta{font-size:12px;color:var(--positive)}.delta.negative{color:var(--negative)}.full{grid-column:1/-1}.audience-top{display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap}.summary-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin:16px 0}.summary-cell{background:#f7f8fb;border-radius:14px;padding:13px}.summary-cell span{color:var(--muted);font-size:12px}.summary-cell strong{display:block;font-size:22px;margin-top:3px}.sentiment{display:grid;grid-template-columns:repeat(4,1fr);height:14px;border-radius:99px;overflow:hidden;background:#eee;margin:12px 0 4px}.sentiment i{display:block;height:100%}.legend{display:flex;gap:13px;flex-wrap:wrap;color:var(--muted);font-size:12px}.topic-list{display:grid;gap:10px;margin-top:18px}.topic-row{display:grid;grid-template-columns:120px 1fr 54px;gap:10px;align-items:center}.topic-bar{height:10px;background:#eef0f6;border-radius:99px;overflow:hidden}.topic-bar i{display:block;height:100%;background:linear-gradient(90deg,var(--accent),#a994ff);border-radius:inherit}.highlights{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-top:18px}.quote{border:1px solid var(--line);border-radius:16px;padding:14px;background:#fbfbfd}.quote p{margin:7px 0 0}.quote-tag{display:inline-flex;border-radius:99px;padding:3px 8px;background:#eeeaff;color:#5a3ee5;font-size:11px;font-weight:800}.quote-meta{color:var(--muted);font-size:12px}.density{display:flex;align-items:flex-end;gap:5px;height:100px;margin-top:16px;padding-top:12px;border-bottom:1px solid var(--line)}.density button{flex:1;min-width:5px;border:0;border-radius:5px 5px 0 0;background:#73d7aa;cursor:pointer;position:relative}.density button:hover{background:#20a66c}.density button span{display:none;position:absolute;bottom:calc(100% + 6px);left:50%;transform:translateX(-50%);white-space:nowrap;background:#171927;color:#fff;padding:5px 7px;border-radius:7px;font-size:11px}.density button:hover span{display:block}.change-notes{margin:16px 0 0;padding-left:20px}.boundary{background:#171927;color:#fff}.boundary p{color:#c5cadc}.links{display:flex;gap:10px;flex-wrap:wrap;margin-top:16px}.links a{color:#171927;background:var(--accent2);padding:9px 13px;border-radius:99px;text-decoration:none;font-weight:800}.empty{color:var(--muted);padding:30px 0;text-align:center}.hidden{display:none!important}@media(max-width:900px){.layout{grid-template-columns:1fr}.summary-grid{grid-template-columns:1fr 1fr}}@media(max-width:620px){.wrap{padding:16px 12px 48px}.hero,.panel{padding:18px}.metric-cards,.highlights{grid-template-columns:1fr}.topic-row{grid-template-columns:92px 1fr 42px}.chart-wrap,.chart-wrap svg{height:260px}.summary-grid{grid-template-columns:1fr 1fr}}
  </style>
</head>
<body><main class="wrap">
  <header class="hero"><div class="eyebrow">DOUYIN · DATA RECOVERY+</div><h1>${data.title}</h1><div class="hero-meta"><span class="badge">当前：${data.currentWindow}</span><span class="badge">${data.completedWindowCount}/4 个公开指标窗口</span><span class="badge">${playbackBadge}</span><span class="badge">评论 / 弹幕变化已启用</span></div></header>
  <section class="layout">
    <article class="panel"><div class="panel-head"><h2>增长趋势</h2><div class="control-row"><button class="chip active" data-mode="total">累计</button><button class="chip" data-mode="delta">净增</button></div></div><div class="control-row" id="metric-controls"></div><div class="chart-wrap" data-chart="metric-trend"><svg id="trend-chart" viewBox="0 0 760 320" role="img" aria-label="公开互动指标趋势图"></svg><div class="chart-tip" id="chart-tip"></div></div></article>
    <aside class="panel"><div class="panel-head"><h2>当前可用指标</h2></div><div class="metric-cards" id="metric-cards"></div><p class="playback-note">${playbackNote}</p></aside>
    <article class="panel full" id="audience-panel"><div class="audience-top"><h2>评论与弹幕变化</h2><div class="control-row" id="audience-windows"></div></div><div class="control-row" style="margin-top:12px"><button class="tab active" data-channel="comments">评论</button><button class="tab" data-channel="danmaku">弹幕</button></div><div id="audience-content"></div></article>
    <article class="panel boundary full"><h2>数据边界</h2><p>点赞、评论、分享、收藏以及评论/弹幕变化来自无浏览器匿名公开链路；播放量仅从本机已登录夸克中的抖音创作者中心可见文本补采。不保存 Cookie、登录信息或截图，也不采集完播率、播放时长、流量来源等其他后台指标。历史未采集窗口不补造。</p><div class="links"><a href="${data.videoUrl}" target="_blank" rel="noreferrer">打开抖音作品</a><a href="${data.docUrl}" target="_blank" rel="noreferrer">查看飞书文档</a></div></article>
  </section>
</main>
<script id="report-data" type="application/json">${safeJson(data)}</script>
<script>${clientScript}</script></body></html>`;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const metricWindows = [];
  const audienceWindows = [];
  for (const window of WINDOWS) {
    const base = resolve(options.evidenceRoot, window);
    const metric = await optionalJson(resolve(base, "validated-snapshot.json"));
    if (metric) {
      metricWindows.push({
        window,
        kind: "public_window",
        collected_at: metric.collected_at,
        snapshot_age_hours: metric.snapshot_age_hours,
        metrics: Object.fromEntries(METRICS.map(item => [item.key, metricValue(metric, item.key)])),
      });
    }
  }
  const playbackFile = await optionalJson(resolve(options.evidenceRoot, "playback-observations.json"));
  const playbackObservations = Array.isArray(playbackFile?.observations)
    ? playbackFile.observations.filter(item => Number.isFinite(Number(item?.estimated_count)))
    : [];
  for (const observation of playbackObservations) {
    metricWindows.push({
      window: `播放@${Number(observation.snapshot_age_hours).toFixed(1)}h`,
      kind: "playback_observation",
      collected_at: observation.collected_at,
      snapshot_age_hours: observation.snapshot_age_hours,
      metrics: Object.fromEntries(METRICS.map(item => [item.key,
        item.key === "views" ? Number(observation.estimated_count) : null])),
      display_value: observation.display_value,
      precision: observation.precision,
    });
  }
  metricWindows.sort((left, right) => Number(left.snapshot_age_hours) - Number(right.snapshot_age_hours));
  for (const window of ["baseline", ...WINDOWS]) {
    const base = resolve(options.evidenceRoot, window);
    const audience = await optionalJson(resolve(base, "audience-snapshot.json"));
    if (audience) audienceWindows.push(audience);
  }
  if (!metricWindows.length) throw new Error("未找到任何 validated-snapshot.json");
  const data = {
    schemaVersion: 1,
    title: options.title,
    currentWindow: options.currentWindow,
    videoUrl: options.videoUrl,
    docUrl: options.docUrl,
    metricDefs: METRICS,
    metricWindows,
    completedWindowCount: metricWindows.filter(item => item.kind === "public_window").length,
    playbackObservations,
    latestPlayback: playbackObservations.length ? {
      ...playbackObservations[playbackObservations.length - 1],
      collected_at_label: new Date(playbackObservations[playbackObservations.length - 1].collected_at)
        .toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false }),
    } : null,
    audienceWindows,
    generatedAt: new Date().toISOString(),
  };
  const clientScript = await readFile(resolve(HERE, "../assets/interactive-report-client.js"), "utf8");
  await mkdir(dirname(options.output), { recursive: true });
  await writeFile(options.output, htmlTemplate(data, clientScript), "utf8");
  process.stdout.write(`${JSON.stringify({ ok: true, output: options.output, metric_windows: metricWindows.length, audience_windows: audienceWindows.length })}\n`);
}

main().catch(error => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 2;
});

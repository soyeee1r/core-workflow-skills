const D = JSON.parse(document.getElementById("report-data").textContent);
let metric = "views";
let mode = "total";
let channel = "comments";
let audienceIndex = Math.max(0, D.audienceWindows.length - 1);
const fmt = value => value == null
  ? "—"
  : new Intl.NumberFormat("zh-CN", {
    notation: value >= 100000 ? "compact" : "standard",
    maximumFractionDigits: 1,
  }).format(value);
const esc = value => String(value ?? "").replace(/[&<>"']/g, character => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#039;",
})[character]);

function windowsForMetric() {
  return D.metricWindows.filter(window => window.metrics[metric] != null);
}

function series(windows = windowsForMetric()) {
  const values = windows.map(window => window.metrics[metric]);
  return values.map((value, index) => mode === "delta"
    ? (index === 0 || value == null || values[index - 1] == null
      ? null
      : value - values[index - 1])
    : value);
}

function renderControls() {
  const root = document.getElementById("metric-controls");
  root.innerHTML = D.metricDefs.map(item => `
    <button class="chip ${item.key === metric ? "active" : ""}" data-metric="${item.key}">
      ${item.label}
    </button>`).join("");
  root.querySelectorAll("[data-metric]").forEach(button => {
    button.onclick = () => { metric = button.dataset.metric; renderAll(); };
  });
  document.querySelectorAll("[data-mode]").forEach(button => {
    button.classList.toggle("active", button.dataset.mode === mode);
  });
}

function renderChart() {
  const svg = document.getElementById("trend-chart");
  const tip = document.getElementById("chart-tip");
  const windows = windowsForMetric();
  const values = series(windows);
  const valid = values.filter(value => value != null);
  const max = Math.max(...valid, 1);
  const min = Math.min(0, ...valid);
  const range = max - min || 1;
  const width = 760;
  const height = 320;
  const padding = { left: 58, right: 20, top: 24, bottom: 42 };
  const x = index => padding.left + index * (
    (width - padding.left - padding.right) / Math.max(1, windows.length - 1)
  );
  const y = value => padding.top + (max - value) / range * (
    height - padding.top - padding.bottom
  );
  let markup = "";
  for (let index = 0; index < 5; index += 1) {
    const value = max - range * index / 4;
    const position = y(value);
    markup += `<line class="gridline" x1="${padding.left}" y1="${position}" x2="${width - padding.right}" y2="${position}"/>`;
    markup += `<text class="axis-label" x="${padding.left - 9}" y="${position + 4}" text-anchor="end">${fmt(Math.round(value))}</text>`;
  }
  windows.forEach((window, index) => {
    markup += `<text class="axis-label" x="${x(index)}" y="${height - 14}" text-anchor="middle">${window.window}</text>`;
  });
  const points = values.map((value, index) => value == null
    ? null
    : [x(index), y(value), value, index]).filter(Boolean);
  if (points.length) {
    const path = points.map((point, index) => (
      `${index ? "L" : "M"}${point[0]},${point[1]}`
    )).join(" ");
    const color = D.metricDefs.find(item => item.key === metric).color;
    markup += `<path class="trend-line" stroke="${color}" d="${path}"/>`;
    points.forEach(point => {
      markup += `<circle class="point" data-index="${point[3]}" cx="${point[0]}" cy="${point[1]}" r="7" fill="${color}"/>`;
    });
  }
  svg.innerHTML = markup;
  svg.querySelectorAll(".point").forEach(point => {
    point.onmouseenter = event => {
      const index = Number(point.dataset.index);
      const window = windows[index];
      const value = values[index];
      const label = D.metricDefs.find(item => item.key === metric).label;
      const shownValue = metric === "views" && window.display_value && mode === "total"
        ? `${esc(window.display_value)}（页面约数）`
        : fmt(value);
      tip.innerHTML = `<b>${window.window}</b><br>${label} ${mode === "delta" ? "净增 " : ""}${shownValue}`;
      tip.style.display = "block";
      tip.style.left = `${event.offsetX + 12}px`;
      tip.style.top = `${event.offsetY - 12}px`;
    };
    point.onmouseleave = () => { tip.style.display = "none"; };
  });
}

function renderCards() {
  document.getElementById("metric-cards").innerHTML = D.metricDefs.map(item => {
    const available = D.metricWindows.filter(window => window.metrics[item.key] != null);
    const latest = available[available.length - 1];
    const previous = available[available.length - 2];
    const value = latest?.metrics[item.key];
    const previousValue = previous?.metrics[item.key];
    const delta = value != null && previousValue != null ? value - previousValue : null;
    const rate = delta != null && previousValue ? delta / previousValue * 100 : null;
    const deltaLabel = delta == null
      ? (item.key === "views" && latest?.display_value ? `夸克补采 · ${esc(latest.display_value)}（约）` : "首个有效窗口")
      : `${delta >= 0 ? "+" : ""}${fmt(delta)} · ${rate == null ? "—" : `${rate >= 0 ? "+" : ""}${rate.toFixed(1)}%`}`;
    return `<div class="metric-card ${item.key === metric ? "active" : ""}" data-card="${item.key}">
      <small>${item.label}</small><strong>${fmt(value)}</strong>
      <span class="delta ${delta < 0 ? "negative" : ""}">${deltaLabel}</span>
    </div>`;
  }).join("");
  document.querySelectorAll("[data-card]").forEach(card => {
    card.onclick = () => { metric = card.dataset.card; renderAll(); };
  });
}

function sentimentBar(sentiment) {
  if (!sentiment) return '<div class="empty">该窗口未做可靠情绪标注</div>';
  const colors = { positive: "#22c55e", negative: "#ef4444", mixed: "#f59e0b", neutral: "#cbd5e1" };
  const labels = { positive: "好评", negative: "差评", mixed: "混合", neutral: "中性" };
  const total = Object.values(sentiment).reduce((sum, value) => sum + value, 0) || 1;
  return `<div class="sentiment">${Object.entries(sentiment).map(([key, value]) => (
    `<i style="width:${value / total * 100}%;background:${colors[key]}"></i>`
  )).join("")}</div><div class="legend">${Object.entries(sentiment).map(([key, value]) => (
    `<span>● ${labels[key]} ${value}</span>`
  )).join("")}</div>`;
}

function renderAudience() {
  document.querySelectorAll("[data-channel]").forEach(tab => {
    tab.classList.toggle("active", tab.dataset.channel === channel);
  });
  const windowsRoot = document.getElementById("audience-windows");
  windowsRoot.innerHTML = D.audienceWindows.map((window, index) => (
    `<button class="window-pill ${index === audienceIndex ? "active" : ""}" data-audience-index="${index}">${window.window === "baseline" ? "当前基线" : window.window}</button>`
  )).join("");
  windowsRoot.querySelectorAll("[data-audience-index]").forEach(button => {
    button.onclick = () => { audienceIndex = Number(button.dataset.audienceIndex); renderAudience(); };
  });
  const snapshot = D.audienceWindows[audienceIndex];
  const data = snapshot?.[channel];
  const root = document.getElementById("audience-content");
  if (!data) {
    root.innerHTML = '<div class="empty">该窗口尚未采集评论与弹幕快照</div>';
    return;
  }
  const maxTopic = Math.max(1, ...data.top_topics.map(topic => topic.count));
  const density = channel === "danmaku" && data.density?.length
    ? `<h3>全片弹幕密度</h3><div class="density">${data.density.map(item => {
      const maxDensity = Math.max(...data.density.map(value => value.count), 1);
      return `<button style="height:${Math.max(6, item.count / maxDensity * 100)}%"><span>${esc(item.label)} · ${item.count} 条</span></button>`;
    }).join("")}</div>`
    : "";
  const topics = data.top_topics.length
    ? data.top_topics.map(topic => `<div class="topic-row"><b>${esc(topic.topic)}</b><div class="topic-bar"><i style="width:${topic.count / maxTopic * 100}%"></i></div><span>${topic.count}${topic.change == null ? "" : ` · ${topic.change >= 0 ? "+" : ""}${topic.change}`}</span></div>`).join("")
    : '<div class="empty">暂无达到三条门槛的话题</div>';
  const highlights = data.highlights.length
    ? data.highlights.map(item => `<div class="quote"><span class="quote-tag">${esc(item.label)}${item.is_new ? " · 新增" : ""}</span><p>${channel === "danmaku" && item.offset_label ? `<b>${esc(item.offset_label)}</b> · ` : ""}${esc(item.text)}</p><span class="quote-meta">${item.likes != null ? `赞 ${item.likes}` : ""}${item.replies != null ? ` · 回复 ${item.replies}` : ""}</span></div>`).join("")
    : '<div class="empty">暂无达到展示门槛的内容</div>';
  root.innerHTML = `<div class="summary-grid">
    <div class="summary-cell"><span>实际读取</span><strong>${fmt(data.read)}</strong></div>
    <div class="summary-cell"><span>较上次新增</span><strong>${data.new_since_previous == null ? "基线" : `+${fmt(data.new_since_previous)}`}</strong></div>
    <div class="summary-cell"><span>明确问题</span><strong>${data.explicit_problem_count ?? "—"}</strong></div>
    <div class="summary-cell"><span>对比基准</span><strong>${snapshot.comparison_base_window ?? "首次"}</strong></div>
  </div>${sentimentBar(data.sentiment)}<h3>高频话题变化</h3><div class="topic-list">${topics}</div>${density}<h3>本窗口代表内容</h3><div class="highlights">${highlights}</div><ul class="change-notes">${(snapshot.change_summary || []).map(note => `<li>${esc(note)}</li>`).join("")}</ul>`;
}

function renderAll() {
  renderControls();
  renderChart();
  renderCards();
  renderAudience();
}

document.querySelectorAll("[data-mode]").forEach(button => {
  button.onclick = () => { mode = button.dataset.mode; renderAll(); };
});
document.querySelectorAll("[data-channel]").forEach(button => {
  button.onclick = () => { channel = button.dataset.channel; renderAudience(); };
});
renderAll();

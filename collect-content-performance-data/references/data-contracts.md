# 数据契约

## Publication 最低字段

```json
{
  "publication_id": "pub_<stable-id>",
  "project_id": "project_<stable-id>",
  "platform": "platform-key",
  "account_id": "internal-account-alias",
  "content_id": "platform-content-id",
  "canonical_url": "https://...",
  "published_at": "2026-08-07T10:00:00+08:00",
  "publication_evidence": ["message:<id>", "platform:<url>"],
  "target_doc_title": "正式项目名-数据回收",
  "target_doc_url": "https://.../docx/..."
}
```

`account_id` 只保存内部账号别名，不保存登录凭据。`content_id` 与 `canonical_url` 至少有一个。创建 Publication 时允许 `target_doc_url` 暂空，但必须生成唯一 `target_doc_title`；自动建文档成功后立即回填 URL/token。

## MetricSnapshot

```json
{
  "publication_id": "pub_<stable-id>",
  "project_id": "project_<stable-id>",
  "platform": "platform-key",
  "account_id": "internal-account-alias",
  "content_id": "platform-content-id",
  "canonical_url": "https://...",
  "published_at": "2026-08-07T10:00:00+08:00",
  "scheduled_window": "2h|6h|24h|48h",
  "collected_at": "2026-08-08T10:12:00+08:00",
  "source": {
    "method": "api|connector|export|browser",
    "backend_url": "https://...",
    "evidence": ["screenshot:<path-or-doc-block>"]
  },
  "metrics": [
    {
      "name": "views",
      "raw_label": "播放量",
      "value": 12345,
      "unit": "count",
      "definition": "平台页面显示口径",
      "availability": "available"
    }
  ],
  "target_doc_url": "https://.../docx/..."
}
```

校验器补充：

- `due_at`
- `snapshot_age_hours`
- `timeliness`: `on_time|late`
- `idempotency_key`: `<publication_id>:<scheduled_window>`
- `metric_snapshot_id`: `ms_<sha256(idempotency_key) 前 16 位>`

## 标准指标

优先尝试映射以下指标；平台没有或定义不兼容时保留原始指标，不强行映射。

- `impressions`：曝光/展现
- `views`：播放
- `unique_viewers`：独立观看人数
- `avg_watch_duration_seconds`：平均观看时长
- `completion_rate`：完播率
- `bounce_rate_2s`：2 秒跳出率
- `completion_rate_5s`：5 秒完播率
- `rewatch_rate`：回看率；只有平台给出精确数值时才标准化，只有曲线/峰值片段时保留为平台原始指标
- `skip_rate`：跳过率；只有平台给出精确数值时才标准化
- `likes`、`comments`、`shares`、`favorites`
- `profile_visits`、`follows_gained`
- `link_clicks`、`conversions`

比例统一保存为 `ratio`，取值 0–1；时长统一为秒；计数保存非负整数。无法确认平台定义时，`name` 使用 `platform.<raw-key>` 并保留说明。

作品详情页采集需在 `source.pages_checked` 保存已检查页面数组；抖音至少包含 `overview`、`traffic_analysis`、`audience_analysis`、`comment_hotwords`、`comment_management`。观看趋势仅能从截图读取时，在 `source.evidence` 保存截图，并用平台原始字段记录“回看率最高片段”“跳过率最高片段”等可确认信息。不同详情页冲突值写入 `source.conflicts`，保留页面、值和采集时间。

## 运行记录

至少保存：`run_id`、触发消息 ID、触发时间、`due_at`、尝试次数、数据源、验证结果、文档写入位置、最终状态、失败原因和下次动作。状态取值：`scheduled`、`collecting`、`needs_login`、`needs_human`、`write_conflict`、`completed`。

精确延迟任务持久化状态固定保存每个平台 Publication、每个窗口、原始触发消息、`due_at/run_at`、目标文档 token、最后登录提醒时间和状态；分别使用 `publication_id:2h/:6h/:24h/:48h` 去重。状态文件不得保存任何登录凭据。窗口任务完成或进入人工接管后不得再次周期唤醒。

项目文档映射保存 `doc_token/url` 与目标目录标识。每个窗口保存阶段回执幂等键与 `message_id`；48h 的阶段回执同时保存 `is_final=true`，不另建第五条最终消息。

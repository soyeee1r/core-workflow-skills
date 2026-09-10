# 评论与弹幕数据结构

仅在整理采集结果或解释内部导出字段时读取本文件。

## 评论

评论标准输入为包含 `collection` 与 `comments` 的对象。评论记录可包含：`comment_id`、`parent_comment_id`、`author_name`、`text`、`like_count`、`reply_count`、`created_at`、`location_label`、`is_reply`、`is_pinned`、`is_creator` 和 `source_order`。

`normalize_comments.py` 输出：

- `comments.json`：去重后的标准化对象。
- `comments.csv`：UTF-8 with BOM 的扁平记录。
- `summary.json`：原始数、唯一数、截断数、顶层/回复数、缺失字段和停止原因。

优先按 `comment_id` 去重；没有 ID 时，用作者显示名、正文、时间和父评论 ID 的 SHA-256 指纹。去重键仅限内部使用。

## 弹幕

弹幕标准输入：

```json
{
  "collection": {
    "platform": "douyin",
    "video_id": "作品 ID",
    "source_url": "作品 URL",
    "source_title": "视频名称",
    "duration_ms": 513494,
    "collected_at": "RFC 3339 时间",
    "segment_ms": 32000,
    "segment_count": 17,
    "status": "complete_visible_range"
  },
  "danmaku": [
    {
      "danmaku_id": "仅内部去重使用",
      "text": "弹幕正文",
      "offset_ms": 12345,
      "like_count": 8,
      "source_order": 1
    }
  ]
}
```

`normalize_danmaku.py` 输出：

- `danmaku.json`：去重并按时间点排序的标准化结果。
- `danmaku.csv`：UTF-8 with BOM 的扁平记录。
- `summary.json`：读取数、唯一数、重复数、视频时长、分段数、时间覆盖和点赞合计。

优先按 `danmaku_id` 去重；没有 ID 时使用“时间点 + 正文”。`offset_label` 仅用于报告显示，格式为 `MM:SS` 或 `HH:MM:SS`。

## 联合摘要

`collect_sweep.mjs` 生成 `sweep-summary.json`，至少包含：视频 ID、视频标题、规范链接、时长、评论与回复读取量、弹幕读取量、弹幕分段数、各阶段状态和输出路径。

飞书交付只使用公开文本、时间点和互动数。禁止展示 `comment_id`、`parent_comment_id`、`danmaku_id`、`uid`、`sec_uid`、主页 URL、去重键、匿名 Cookie、签名参数或其他账号标识。

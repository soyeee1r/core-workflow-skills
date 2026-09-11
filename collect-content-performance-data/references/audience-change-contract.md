# 评论与弹幕变化契约

每个 2h、6h、24h、48h 窗口都要在指标采集后，用 `douyin-comment-collector` 的匿名联合入口重新读取当前公开可见的评论与全时长弹幕，并保存到当前窗口的 `audience/` 目录。历史窗口不可追溯时不得伪造；从第一个实际采集到的窗口建立基线，后续窗口只与最近一个真实基线比较。

## audience-snapshot.json

```json
{
  "schema_version": 1,
  "publication_id": "pub_douyin_<video_id>",
  "video_id": "<video_id>",
  "window": "2h|6h|24h|48h|baseline",
  "collected_at": "ISO-8601",
  "comparison_base_window": "2h|6h|24h|48h|baseline|null",
  "comments": {
    "read": 299,
    "new_since_previous": null,
    "sentiment": {"positive": 0, "negative": 0, "mixed": 0, "neutral": 0},
    "explicit_problem_count": 0,
    "top_topics": [{"topic": "具体主题", "count": 8, "change": null}],
    "highlights": [{"text": "公开评论原文", "label": "高互动|好评|差评|明确问题|高频话题", "likes": 12, "replies": 2, "is_new": true}]
  },
  "danmaku": {
    "read": 61,
    "new_since_previous": null,
    "sentiment": {"positive": 0, "negative": 0, "mixed": 0, "neutral": 0},
    "explicit_problem_count": 0,
    "top_topics": [{"topic": "具体主题", "count": 5, "change": null}],
    "density": [{"label": "00:00–00:32", "count": 15}],
    "highlights": [{"text": "公开弹幕原文", "offset_label": "00:25", "label": "高互动|好评|差评|明确问题|高频话题", "likes": 3, "is_new": true}]
  },
  "change_summary": ["只写可由当前与上一真实快照直接支持的变化"],
  "boundary": "评论和弹幕只代表采集时匿名公开可见范围。"
}
```

## 生成规则

- `read` 与 `sweep-summary.json` 完全一致；评论与弹幕作品 ID 必须与 Publication 一致。
- 评论语义仍按高互动、好评、差评、明确问题、重复话题五类判断；差评不能被遗漏或并入好评。
- 每条原文只保留正文和公开互动数，不得输出作者名、用户 ID、评论 ID、弹幕 ID、主页 URL 或去重键。
- `new_since_previous` 通过内部稳定记录键集合求差，但键只用于本地比较，不能写入 `audience-snapshot.json` 或网页。
- 情绪计数覆盖实际分析集合；未进行语义标注时必须写 `null`，不得用关键词粗暴冒充精确分类。
- `top_topics` 至少 3 条独立文本才成立；`change` 是相对上一真实窗口的频次净增，基线为 `null`。
- `density` 按全时长 32 秒区间聚合，不得把未成功请求的区间记为 0。
- `highlights` 展示量由质量决定，不固定条数；同义重复只保留少量代表。

保存后运行：

```bash
node scripts/validate_audience_snapshot.mjs \
  --input '<window-evidence>/audience-snapshot.json' \
  --sweep-summary '<window-evidence>/audience/sweep-summary.json'
```

只有验证通过，才允许把该窗口评论/弹幕变化写入文档和互动网页。

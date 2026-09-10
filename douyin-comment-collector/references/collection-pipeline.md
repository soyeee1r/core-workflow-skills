# 评论 + 弹幕联合采集链路

仅在执行实际扫楼时读取本文件。

## 单作品输入与目录

输入必须是能解析出稳定作品 ID 的完整抖音作品链接。每次运行使用新的输出目录；不要复用另一个作品的临时目录。

联合入口：

```bash
node scripts/collect_sweep.mjs \
  --url '<douyin-video-url>' \
  --output-dir '<new-output-directory>'
```

默认不要传 `--comment-limit`。评论与回复先读取 100 条，之后按 50 条批次评估新增高互动观点、明确问题、正向信号与新话题；连续两批新增价值都低于门槛时以 `adaptive_saturation` 停止，硬上限 500 条。用户明确指定条数时才传 `--comment-limit <100–500>`，此时按指定值作为固定上限。弹幕没有人为条数上限，按全时长分段读取当前公开可见范围。

自适应批次结果保存在 `raw/comments/raw-comments.json` 的 `collection.adaptive_batches`，并汇总到 `sweep-summary.json.comments`。每批至少记录范围、新增价值数、是否出现爆发互动、是否属于低增量和连续低增量批次数；不能只凭模型主观描述停止。

## 产物

- `raw/comments/raw-comments.json`：评论与回复原始结构化结果。
- `raw/danmaku/raw-danmaku.json`：全时长分段弹幕原始结构化结果。
- `comments/comments.json`、`comments/comments.csv`、`comments/summary.json`：评论标准化结果。
- `danmaku/danmaku.json`、`danmaku/danmaku.csv`、`danmaku/summary.json`：弹幕标准化结果。
- `sweep-summary.json`：作品标题、时长、评论/回复/弹幕读取量、弹幕分段数、停止原因和路径清单。

内部文件可保留稳定记录键用于去重，但任何 ID、主页链接、指纹或匿名会话信息都不得进入飞书文档、卡片或群消息。

## 验证

1. 回读 `sweep-summary.json`，确认评论和弹幕的 `video_id` 相同，视频标题不为空或已使用 ID 兜底。
2. 抽查评论和弹幕 JSON 的首条与末条；中文应完整，计数与各自 `summary.json` 一致。
3. 弹幕区间必须从 0 覆盖到 `duration_ms`，除最后一段外单段不超过 32,000 毫秒；若中途 HTTP 或接口状态异常，不能把后续未读区间写成空弹幕。
4. 评论总数不足 100 时，必须有明确的公开可见范围结束或访问失败原因；`adaptive_saturation` 最早只能发生在完成两个 50 条增量批次之后；不得用重复内容、旧十条热评或虚构记录补足。
5. 同一作品重复执行时，采集可重跑，但飞书交付必须按 `video_id` 更新既有文档。

## 失败状态

- `complete_visible_range`：接口已到当前公开可见范围末尾。
- `adaptive_saturation`：100 条基础样本后连续两个 50 条批次均无足够新增价值。
- `limit_reached`：评论达到用户明确指定的上限，或默认 500 条硬上限。
- `verification_required`、`access_denied`：接口要求验证或拒绝访问；停止，不回退浏览器。
- `collection_failed`：解析、网络、签名或接口结构发生其他失败。

任一采集阶段失败时保留已完成的本地结构化产物，并向原群报告准确阶段。只有评论、弹幕、文档回读和卡片回执全部满足任务要求时，才标记完整成功。

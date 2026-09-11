---
name: collect-content-performance-data
description: 在群内出现可信的抖音实际发布确认和唯一作品链接后，建立 Publication，并在发布后 2h、6h、24h、48h 回收公开互动指标、评论与弹幕变化；仅播放量可通过用户电脑上已登录的夸克读取抖音创作者中心当前显示值。两路数据保存可验证快照，幂等更新同一份飞书文档和可交互图表网页。禁止 Chrome、Cookie 导出、远程调试、截图依赖和其他后台指标采集。
---

# 抖音发布后数据回收+

只完成“发布事实 → 2h/6h/24h/48h 四个公开数据快照 → 夸克补采播放量 → 同一飞书文档与互动网页”的闭环。除播放量外全程使用非浏览器公开链路；不得把公开接口没有提供的指标写成 0。

## 开始前

1. 完整读取 [business-rules.md](references/business-rules.md) 和 [data-contracts.md](references/data-contracts.md)。
2. 完整读取 [data-sources.md](references/data-sources.md)。
3. 写文档和网页前完整读取 [output-contracts.md](references/output-contracts.md)。
4. 采集或展示评论、弹幕变化前完整读取 [audience-change-contract.md](references/audience-change-contract.md)，并完整读取 `douyin-comment-collector` Skill 的采集与价值筛选规则。
5. 测试、恢复失败或处理边界情况时完整读取 [test-cases.md](references/test-cases.md)。

修改采集器后用一条已知公开抖音链接运行 `collect_douyin_public_metrics.mjs`，并运行 `python3 scripts/test_validate_snapshot.py`。
修改评论/弹幕变化或网页生成器后，还要运行 `validate_audience_snapshot.mjs` 和 `build_interactive_report.mjs`，回读 HTML 并确认真实存在图表与交互控件。

## 输入与触发

- 群内可识别人类真实 `@0615`，同一条消息明确说明某期视频已经发布，并附唯一抖音作品链接时，立即创建 2h、6h、24h、48h 四个窗口任务，不二次确认。
- 当前仅支持抖音；不自动补建视频号、B 站、小红书或快手任务。
- `project_id` 使用正式项目名或视频标题生成的稳定键；`publication_id` 使用抖音 `video_id` 生成，重复发布消息只合并证据，不重复建任务。
- `published_at` 优先采用公开作品数据中的 `create_time`。排程阶段尚未读取到时，可暂用触发消息时间；第一次采集后校正实际快照龄，绝不提前伪造窗口。

## 定时与幂等

- 固定四个单次窗口：`published_at + 2h/+6h/+24h/+48h`，禁止周期轮询。
- 幂等键固定为 `publication_id:2h`、`:6h`、`:24h`、`:48h`。
- 旧快照只读保留；同一快照重跑时内容一致则跳过，不一致则返回 `write_conflict`，不得覆盖。

## 到期采集

每个窗口建立独立证据目录并执行：

```bash
node scripts/collect_douyin_public_metrics.mjs \
  --url '<douyin-video-url>' \
  --output '<evidence-directory>/public-metrics.json'
```

公开链路硬规则：

- 点赞、评论、分享、收藏、评论与弹幕只允许匿名公开请求；禁止 Chrome、Playwright、用户 Cookie、账号后台和登录回退。
- 采集器实际可回收点赞、评论、分享、收藏以及接口当时确实公开的其他计数。
- 抖音公开分享页经常用 `play_count=0` 表示不公开播放量；这种占位值必须标为 `unavailable`，不能当成真实 0。
- 曝光、独立观看、平均播放时长、完播率、跳出率、流量来源、观众画像、新增关注等后台专属指标统一保留为 `unavailable`，不得采集、猜测或用前台指标换算。
- API 失败写 `collection_failed`，不得写 0；每个窗口保存带采集时间的原始 JSON 作为证据。

## 评论与弹幕变化

- 每个到期窗口在公开指标采集后，使用 `douyin-comment-collector/scripts/collect_sweep.mjs` 匿名重采当前公开可见评论、回复和全时长弹幕；不得使用浏览器或用户 Cookie。
- 每个窗口保存 `audience/sweep-summary.json` 和经过验证的 `audience-snapshot.json`。第一次真实采集建立基线；后续窗口比较新增文本、好评/差评/明确问题、重复话题频次和弹幕密度变化。
- 历史窗口没有文本快照时不能回填或推测；在网页和文档明确写“从首个真实基线开始比较”。
- 展示量由质量决定，必须同时保留差评和明确问题，不展示任何用户、评论或弹幕 ID。

## 夸克播放量补采

- 仅播放量允许使用用户电脑上现有的夸克登录态，直接打开 `creator.douyin.com/creator-micro/work-management/work-detail/<video_id>` 的作品总览页，以可见页面文本中的“播放量”为准。
- 禁止使用 Chrome、禁止导出/读取 Cookie、Local Storage、历史记录或浏览器会话文件，禁止远程调试，禁止要求用户截图。不接受下载、摄像头、麦克风、媒体等权限。
- 只读“播放量”和作品 ID/标题用于匹配；完播率、平均播放时长、流量来源、观众画像等即使同页可见也不写入数据回收。
- 页面若显示 `38.86万` 之类缩写，同时保存 `display_value="38.86万"`、`estimated_count=388600`、`precision="rounded_to_nearest_100"`；网页和文档都必须标明“页面显示约数”，不写成精确整数。
- 每次成功读取追加到作品证据根目录的 `playback-observations.json`，至少保存 `collected_at`、`snapshot_age_hours`、`display_value`、`estimated_count`、`precision`、`content_id`和创作者中心作品页 URL；不保存账号信息、Cookie 或截图。
- 已登录夸克不可用时，公开指标与评论/弹幕回收仍正常完成，播放量标记“未补采”；不得转用 Chrome，也不得因播放量缺失把整个窗口判定失败。

## 快照

1. 根据 `public-metrics.json` 组装 [data-contracts.md](references/data-contracts.md) 的 `MetricSnapshot`，`source.method=api`，`source.backend_url` 写匿名公开分享页地址，`source.evidence` 写真实原始 JSON 路径。
2. 公开作品时间与暂定发布时间不同，以公开 `create_time` 计算 `snapshot_age_hours`；若当前采集早于窗口到期，保持任务未完成，不写文档。
3. 运行：`python3 scripts/validate_snapshot.py --input <snapshot.json> --output <validated-snapshot.json>`。
4. 校验失败、内容 ID 不一致或证据缺失时停止，不生成完成回执。

## 飞书文档与互动网页

- 每个项目只维护一篇 `<项目名>-数据回收` 飞书文档，归档到用户“我的文档库/数据回收”；四个窗口追加到同一张对比表，不覆盖旧列。
- 每个抖音 `video_id` 只维护一个独立的飞书妙搭 HTML 应用；首次创建并保存 `web_app_id`，后续窗口只更新该应用。
- 网页必须由 `build_interactive_report.mjs` 生成，至少包含：指标折线图、累计/净增切换、指标选择、窗口筛选、评论/弹幕页签、重复话题频次条、弹幕时段密度和代表内容；不能只放静态数字卡与文字环比。
- 网页展示四窗口公开指标、夸克播放量补采点、相邻净增/增幅、评论与弹幕变化和数据边界；页面不得展示用户 ID、Cookie、签名或其他隐藏标识。
- 妙搭运行权限设为公开且不要求登录。发布后必须用未登录 HTTP 请求回读，确认作品标题、当前窗口和数据边界存在；失败时不得标记完成。
- 文档和网页都回读一致后，才可完成当前窗口。2h、6h、24h、48h 各在原发布群发送一次阶段回执；48h 同时作为最终复盘回执，不另发第五条。

## 状态与输出

持久化账本使用 `/Users/mac/.local/share/content-ops-agent/evidence-ledger/content-performance-state.json`，保存 Publication、四个单次任务、文档映射、`web_app_id/web_url`、快照、证据路径和群回执。禁止保存任何凭据。

窗口最终状态为 `scheduled`、`collecting`、`needs_human`、`write_conflict`、`failed` 或 `completed`。公开接口暂时失败可在 6 小时内最多重试 3 次；仍失败则如实说明接口失败，不切换浏览器。夸克播放量是独立增强项，不使用 `needs_login`，不阻断公开数据窗口完成。

## 完成条件

单个窗口必须同时满足：作品与 `video_id` 匹配；采集时间不早于窗口；原始 API 证据已保存；指标快照校验通过；评论/弹幕公开采集及变化快照校验通过；同一文档写入并回读一致；互动网页含真实交互图表且公开免登录、匿名回读成功；对应群回执幂等发送。只有四个窗口均完成，Publication 才算整体完成。

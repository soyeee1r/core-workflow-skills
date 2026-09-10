# 连接现有 Chrome 的 CDP 后端

此后端是默认采集方式。它复用用户已经登录的 Chrome 会话，但不读取、导出或保存 Cookie，也不启动独立浏览器。

## 前置状态

- Chrome 版本需支持现有会话远程调试。当前机器使用 Chrome 151。
- 用户需要在 Chrome 打开 `chrome://inspect/#remote-debugging`，启用 Remote Debugging。
- Chrome 首次弹出连接确认时由用户点击允许。不要代替用户接受，也不要申请下载、摄像头、麦克风、媒体或系统辅助权限。

CDP 技术上能接触整个浏览器会话，因此脚本必须遵守最小范围：不枚举或读取其他标签页内容，不调用 cookies/localStorage/history API，只在第一个现有 context 中新开目标抖音页，结束后只关闭该任务页，不关闭浏览器。

## 探测

```bash
/Users/mac/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node \
  /Users/mac/.agents/skills/douyin-comment-collector/scripts/collect_existing_chrome.mjs \
  --probe
```

`cdp_unavailable` 表示尚未开启 Remote Debugging 或用户没有允许本次连接。只告诉用户开启上述 Chrome 页面的一项开关；不要启动新的 Chrome 或索取 Cookie。

## 单作品采集

输出目录必须是本次任务的新目录：

```bash
/Users/mac/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node \
  /Users/mac/.agents/skills/douyin-comment-collector/scripts/collect_existing_chrome.mjs \
  --url '<douyin-url>' \
  --output-dir '<new-output-directory>' \
  --limit 100
```

脚本会：

- 连接 `127.0.0.1:9222` 的现有 Chrome；可用 `DOUYIN_CDP_ENDPOINT` 覆盖端点。
- 在现有会话中新开目标抖音页，并阻止图片、视频和字体加载以降低干扰。
- 捕获页面自身发出的评论列表与回复列表响应，滚动并展开回复；必要时才从 DOM 降级提取。
- 写入 `<output-dir>/raw-comments.json`，不会下载媒体或写入浏览器配置。

随后必须运行 `normalize_comments.py --limit 100`。脚本的 DOM 降级结果可能缺少点赞或作者字段；这些字段保留为 `null`，不能猜测成 0。

## 状态映射

- `cdp_unavailable`：`needs_human`，提示开启 Remote Debugging。
- `auth_required`：`needs_login`，提示用户在当前 Chrome 的抖音页面完成登录。
- `verification_required`：`needs_human`，提示用户在当前 Chrome 手动完成抖音验证。
- `limit_reached`、`complete_visible_range`、`stalled_after_3_passes`：继续规范化、分析和飞书交付。
- 其他错误：`failed`，保留精确阶段与原链接。

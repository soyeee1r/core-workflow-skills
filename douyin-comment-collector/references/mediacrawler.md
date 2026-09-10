# MediaCrawler 可选后端

用户已明确要使用本地 MediaCrawler，并确认当前用途为非商业时读取。

## 使用判断

MediaCrawler 支持抖音指定作品、一级评论、二级评论、二维码/已有 Chrome 登录态和多种导出格式。仓库采用 `NON-COMMERCIAL LEARNING LICENSE 1.1`，仅允许非商业学习/研究，并禁止大规模采集。用途不满足时不要安装、复制或运行该项目，改用浏览器读取用户有权访问的可见评论。

不要自动从网络安装仓库或依赖。若本地没有可用 checkout，先取得用户授权，并把仓库作为独立第三方依赖保留其许可证；不要把源码复制进本技能。

## 已部署调用

部署目录为 `/Users/mac/Documents/迭代/vendor/MediaCrawler-main`。使用包装脚本输出到本次任务的新目录：

```bash
python3 scripts/collect_mediacrawler.py \
  --url '<douyin-url>' \
  --output-dir '<new-output-directory>' \
  --limit 100
```

包装脚本会通过 CDP 复用现有 Chrome，不在命令行传 Cookie；MediaCrawler 仅在任务进程内临时读取 `www.douyin.com` 域 Cookie 生成评论请求，禁止把 Cookie 写入输出、日志、飞书或任何持久化文件。脚本禁用 IP 代理和媒体下载；多链接之间使用本机文件锁串行连接 Chrome；并把 MediaCrawler JSONL 转成 `raw-comments.json`。运行中出现 Chrome 连接确认、登录、验证码或风控时让用户手动处理，不尝试绕过。

## 100 条硬上限

上游的 `max_comments_count_singlenotes` 主要约束一级评论；开启二级评论后，总记录数可能超过 100。因此必须把生成的抖音评论 JSONL 再交给 `scripts/normalize_comments.py --limit 100`，最终以 `summary.json` 的 `output_records` 与 `truncated_records` 为准。

MediaCrawler 当前输出会对用户 ID 做匿名哈希、对昵称做脱敏；不要把脱敏后的昵称描述成原始昵称。

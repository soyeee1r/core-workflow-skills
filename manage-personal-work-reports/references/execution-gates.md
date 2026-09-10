# 个人工作自动化完整性门禁

本规则适用于 10:10 个人晨间面板和 19:00 日报/周月总结。它把数据抓取与最终交付分成两个可验证阶段。

## 运行回执

保存到 `/Users/mac/.local/share/content-ops-agent/evidence-ledger/personal-run-receipts/YYYY-MM-DD/<task>.json`。开始时读取 `operator-corrections.ndjson`，并把 active correction_id 写入 `corrections_read`。

回执至少包含：

- `schema_version=1`、`run_id`、`task`、`cutoff_at`、`status`；
- `sources`：使用 `kind=weekly_report|messages|project_facts|calendar` 标明周报、每个白名单会话、项目事实和日历；必要来源记录 `complete`、带原因的 `resolved_missing` 或失败状态，消息源同时记录分页是否结束；
- `coverage`：`chats_expected/chats_scanned`、`threads_expected/threads_expanded`、`reports_expected/reports_resolved`、`calendar_expected/calendar_resolved`；
- `tool_errors`：失败调用及 `resolved`；
- `delivery`：晨间面板使用 `pending|sent|failed` 与 message_id；
- `writeback`：日报使用 `pending|verified|failed`、文档 token、写前/写后 revision 和回读验收结果。

白名单会话必须翻页到 `has_more=false`；返回的回复串必须展开。周报必须读取目标日期正文，标题/目录/正则命中不算。日历读取失败不能用“暂无日程”代替。

## 两阶段验证

生成内容、发送或写回前运行：

`python3 /Users/mac/.codex/skills/manage-personal-work-reports/scripts/validate_personal_run_receipt.py RECEIPT --phase preflight`

预检不通过时不发送、不写周报，并将任务标为失败/不完整。交付后更新同一回执，再运行：

`python3 /Users/mac/.codex/skills/manage-personal-work-reports/scripts/validate_personal_run_receipt.py RECEIPT --phase final`

晨间面板只有 `delivery.status=sent` 且存在 message_id 才算完成。日报只有 `writeback.status=verified` 且回读通过才算完成。安全检查拦截、发送失败、revision 冲突或写后未回读都必须显示为失败，不能把“已生成内容”称为已交付。

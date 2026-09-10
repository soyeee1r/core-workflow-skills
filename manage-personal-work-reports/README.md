# 个人工作助理

![工作流程](assets/workflow.svg)

入口：[SKILL.md](SKILL.md)。这是现用技能的个人私有备份；原技能、脚本与规则按原字节保留，打包新增本说明与工作流程图。

## 安装

将本目录整体复制到目标环境的技能目录（如 `~/.codex/skills/manage-personal-work-reports`），保持目录结构。已有同名技能时先比较、备份再决定是否替换。仓库根目录也提供不会覆盖现有目录的安装脚本。

安装只复制文件，不登录账号、不修改在线文档、不发送消息、不启用自动化。

## 依赖

Python 3.10+；lark-shared、lark-im、lark-wiki、lark-doc、read-content-project-board、read-content-progress-reports、lark-minutes 或 lark-vc、lark-calendar；需要飞书任务时另需 lark-task。

这些外部技能、工具、平台登录态和调度服务没有捆绑在本目录中，需在目标环境单独准备。

## 配置与使用边界

references/feishu-scope.md 保存当前用户、白名单会话和周报库配置。SKILL.md 和 execution-gates.md 保存本地账本路径。只适用于配置中对应的本人工作系统；迁移到其他账号须先更新范围和身份，源文中的历史授权不自动授权新环境。

包含个人规则和资源定位信息，仓库保持私有。没有打包 Cookie、认证令牌、浏览器资料、历史群消息、采集结果或运行账本。脚本中的固定本机路径保留原值；在不同目录或电脑使用时，应改为目标环境实际位置。执行任何外部动作前，以目标会话中的真实用户授权为准。

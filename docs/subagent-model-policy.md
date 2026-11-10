<!-- 职责：原 providers 子代理功能的迁移入口与历史链接兼容；不写：独立插件的现行设计、存储与执行契约。 -->

# 子代理统一模型已迁出

本功能曾是 providers 的内置能力，现已从 providers 源码移除，成为独立项目
[opencode-subagent-model](https://github.com/Just-Silver/opencode-subagent-model)。

现行[策略契约](https://github.com/Just-Silver/opencode-subagent-model/blob/main/docs/subagent-model-policy.md)
与[使用及迁移说明](https://github.com/Just-Silver/opencode-subagent-model#从-providers-内置版本迁移)
由独立项目维护；本地对应仓库为相邻的 `opencode-subagent-model/`。链接内容需新仓提交/推送后才在线可见。

Providers 已移除该功能的源码、命令、RPC 和测试，npm 版本线保持在已稳定的 `0.3.4`，不为此另发版本。
新插件本地加载之前，本机已安装的旧 beta 副本仍会继续加载，必须先切换来源或停用。

本仓历史实现计划保留当时记录，不代表当前 providers 仍注册该命令、RPC 或工具钩子。
原 npm beta 的撤包事实和后续版本处置见[npm 分发文档](npm-distribution-and-testing.md#子代理功能拆分的预发布处置)。

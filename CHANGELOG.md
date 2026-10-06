# Changelog

本项目所有值得注意的变更都记录在此文件。

格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [Unreleased]

## [0.1.0-beta.0] - 2026-10-07

> 首个**预发布**版本：先发到 npm 的 `next` dist-tag 试装，稳定后再发 `latest`。
> 装上后不需要写 `opencode.json`，在 `/connect-providers` 里贴一次 API Key 即可用。

### Added

- `registry.json` + `registry.schema.json`：自维护供应商注册表（共享 `models` 表 + provider `base` 引用 + 覆盖），带 `schemaVersion`
- server 入口 `plugin/opencode-providers/index.ts`：拉注册表（6h TTL + `ETag` + 失败沿用旧缓存）→ 注册 integration（`key`）与 provider（`activation: "auto"`）及其模型；**不 import 任何 `@opencode/*`**
- TUI 入口 `plugin/opencode-providers/tui.ts` + `view/connect.ts`：`/connect-providers` 命令（选供应商 → 贴 API Key / 切换账号），与内置 `/connect` 共用同一张凭据表。**无 JSX、不依赖 Solid**，因此 npm / 配置安装不会踩「双 Solid 运行时」
- `registry/` 纯逻辑：schema 校验 / `Model.Info` 映射 / 拉取缓存；`node --test` 覆盖（含「随仓注册表能通过校验」）
- `package.json`：npm 包形态（`type: module`；`exports["./server"]` / `["./tui"]`；`files` 白名单；`publishConfig.tag = next`），可 `"plugins": ["@justsilver/opencode-providers"]` 配置安装
- `install.sh` / `install.ps1` / `uninstall.sh` / `uninstall.ps1`：脚本安装（最新 Release 优先、回退 `main`、同文件系统原子替换）；`--local` / `-Local` 从工作树部署
- `.github/workflows/ci.yml`（跑 `node --test` + 版本一致性）与 `release.yml`（tag 触发；预发布发 `next`，正式版必须手动勾选才发 `latest`；Release 内容取自本文件）

### Changed

- 插件源码从 `.opencode/plugins/opencode-providers/` 移到 `plugin/opencode-providers/`：仓库自身不再是插件发现根，避免在仓库里跑 opencode 时与全局安装的同 id 副本相撞（`Duplicate plugin ID` → 面板里一条 `failed`）
- 安装后**通常无需重启**（插件目录被文件监视热重载），不再要求 `opencode service restart`

[Unreleased]: https://github.com/Just-Silver/opencode-providers/compare/v0.1.0-beta.0...HEAD
[0.1.0-beta.0]: https://github.com/Just-Silver/opencode-providers/releases/tag/v0.1.0-beta.0

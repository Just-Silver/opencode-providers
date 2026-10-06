# Changelog

本项目所有值得注意的变更都记录在此文件。

格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [Unreleased]

## [0.1.0] - 2026-10-07

### Added

- `registry.json` + `registry.schema.json`：自维护供应商注册表（共享 `models` 表 + provider `base` 引用 + 覆盖），带 `schemaVersion`
- server 入口 `index.ts`：拉注册表（6h TTL + `ETag` + 失败沿用旧缓存）→ 注册 integration（`key`）与 provider（`activation: "auto"`）及其模型；**不 import 任何 `@opencode/*`**
- TUI 入口 `tui.tsx` + `view/connect.ts`：`/connect-providers` 命令（选供应商 → 贴 API Key / 切换账号），与内置 `/connect` 共用同一张凭据表
- `registry/` 纯逻辑：schema 校验 / `Model.Info` 映射 / 拉取缓存；`node --test` 覆盖（含「随仓注册表能通过校验」）
- `install.sh` / `install.ps1` / `uninstall.sh` / `uninstall.ps1`：最新 Release 优先、回退 `main`、同文件系统原子替换
- `.github/workflows/ci.yml`（跑单测）与 `release.yml`（tag 触发发版，Release 内容取自本文件）

[Unreleased]: https://github.com/Just-Silver/opencode-providers/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/Just-Silver/opencode-providers/releases/tag/v0.1.0

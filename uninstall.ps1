#Requires -Version 7.0
# opencode-providers 卸载脚本（PowerShell 7+）
# 用法: irm https://raw.githubusercontent.com/Just-Silver/opencode-providers/main/uninstall.ps1 | iex
$ErrorActionPreference = "Stop"

function Get-GlobalPluginsDir {
  $base = if ($env:XDG_CONFIG_HOME -and $env:XDG_CONFIG_HOME.Trim()) { $env:XDG_CONFIG_HOME } else { Join-Path $HOME ".config" }
  return Join-Path $base "opencode\plugins"
}

$pluginsDir = Get-GlobalPluginsDir
$targets = @(
  (Join-Path $pluginsDir "opencode-providers"),
  (Join-Path $pluginsDir ".tmp.opencode-providers")
)

$removed = $false
foreach ($target in $targets) {
  if (Test-Path $target) {
    Remove-Item -Recurse -Force $target
    Write-Host "✓ 已删除 $target" -ForegroundColor Green
    $removed = $true
  }
}

if (-not $removed) {
  Write-Host "未找到已安装的插件（$(Join-Path $pluginsDir 'opencode-providers')）" -ForegroundColor Yellow
}

Write-Host "重启 opencode（或 opencode service restart）后生效。"
Write-Host "凭据仍保留在 opencode 的 SQLite 里；如需清除，用 /connect 或 opencode auth 管理。"

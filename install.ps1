#Requires -Version 7.0
<#
.SYNOPSIS
  opencode-providers 全局安装脚本（PowerShell 7+）
.DESCRIPTION
  默认从 GitHub 安装：优先「最新 Release」的 tag，仓库尚无 Release 时回退 main。
  -Local 则直接从本仓库工作树安装（含未提交改动），用于开发时把改动快速部署到全局插件目录。
.EXAMPLE
  irm https://raw.githubusercontent.com/Just-Silver/opencode-providers/main/install.ps1 | iex
.EXAMPLE
  pwsh -NoProfile -File .\install.ps1 -Local
#>
param([switch]$Local)

$ErrorActionPreference = "Stop"
$Repo = "Just-Silver/opencode-providers"
$RepoUrl = "https://github.com/$Repo.git"
# releases/latest 是 302 跳转：读最终 URL 尾部即最新 tag（不用 api.github.com，避免限流/403）
$LatestUrl = "https://github.com/$Repo/releases/latest"
# 仓库内插件源码目录（**故意不放在 .opencode/plugins/ 下**：否则在仓库里跑 opencode 时，
# 仓库副本会与全局安装副本撞同一个插件 id，被 supervisor 判为 Duplicate plugin ID 而显示失败）
$PluginSubPath = "plugin\opencode-providers"

function Get-GlobalPluginsDir {
  $base = if ($env:XDG_CONFIG_HOME -and $env:XDG_CONFIG_HOME.Trim()) { $env:XDG_CONFIG_HOME } else { Join-Path $HOME ".config" }
  return Join-Path $base "opencode\plugins"
}

function Test-Command($name) { $null -ne (Get-Command $name -ErrorAction SilentlyContinue) }

# 解析安装 ref：最新 Release 的 tag，回退 main
function Resolve-Ref {
  if (Test-Command curl.exe) {
    $final = curl.exe -fsSL -o NUL -w '%{url_effective}' $LatestUrl 2>$null
    if ("$final" -match '/releases/tag/([^/?#]+)') { return $Matches[1] }
  }
  if (Test-Command git) {
    $line = git ls-remote --tags --refs --sort=-v:refname $RepoUrl 2>$null | Select-Object -First 1
    if ("$line" -match 'refs/tags/(\S+)') { return $Matches[1] }
  }
  return "main"
}

# 目录型插件：tui.ts = TUI 入口，index.ts = server 入口；本插件两者都需要
function Test-Entries($dir) {
  $tui = (Test-Path (Join-Path $dir "tui.ts")) -or (Test-Path (Join-Path $dir "tui.tsx"))
  return (Test-Path (Join-Path $dir "index.ts")) -and $tui
}

$pluginsDir = Get-GlobalPluginsDir
$dest = Join-Path $pluginsDir "opencode-providers"
# STAGE 必须与 dest 同文件系统才原子（同目录必同 FS）；固定名 + 复制前先清理
$stage = Join-Path $pluginsDir ".tmp.opencode-providers"
$tmp = Join-Path ([IO.Path]::GetTempPath()) ("opencode-providers-" + [Guid]::NewGuid().ToString("N"))

try {
  if ($Local) {
    $srcDir = Join-Path $PSScriptRoot $PluginSubPath
    Write-Host "→ 本地模式：$srcDir"
    if (-not (Test-Entries $srcDir)) { throw "未找到 $srcDir 的 index.ts / tui.ts" }
  } else {
    $ref = Resolve-Ref
    $archiveUrl = if ($ref -eq "main") {
      "https://github.com/$Repo/archive/refs/heads/main.tar.gz"
    } else {
      "https://github.com/$Repo/archive/refs/tags/$ref.tar.gz"
    }

    Write-Host "→ 安装版本: $ref"
    New-Item -ItemType Directory -Force -Path $pluginsDir | Out-Null

    $fetched = $false
    if (Test-Command git) {
      Write-Host "→ git clone --depth 1 --branch $ref $RepoUrl"
      git clone --depth 1 --branch $ref $RepoUrl $tmp 2>&1 | Out-Null
      if ($LASTEXITCODE -eq 0 -and (Test-Entries (Join-Path $tmp $PluginSubPath))) {
        $fetched = $true
      } else {
        Write-Warning "git clone 失败，尝试 curl 回退"
        if (Test-Path $tmp) { Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue }
        New-Item -ItemType Directory -Force -Path $tmp | Out-Null
      }
    }

    if (-not $fetched) {
      if (-not (Test-Command curl.exe)) { throw "需要 git 或 curl 之一" }
      if (Test-Path $tmp) { Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue }
      New-Item -ItemType Directory -Force -Path $tmp | Out-Null
      $tar = Join-Path $tmp "archive.tar.gz"
      Write-Host "→ curl.exe $archiveUrl"
      curl.exe -fsSL "$archiveUrl" -o $tar 2>&1 | Out-Null
      if ($LASTEXITCODE -ne 0) { throw "curl 下载失败 (exit $LASTEXITCODE)" }
      tar -xzf $tar -C $tmp --strip-components=1 2>&1 | Out-Null
      if ($LASTEXITCODE -ne 0) { throw "tar 解压失败 (exit $LASTEXITCODE)" }
    }

    $srcDir = Join-Path $tmp $PluginSubPath
    if (-not (Test-Entries $srcDir)) { throw "未找到 $srcDir 的 index.ts / tui.ts" }
  }

  Write-Host "→ 目标目录: $dest"
  New-Item -ItemType Directory -Force -Path $pluginsDir | Out-Null

  # 原子替换：整目录 Copy 到同文件系统的 STAGE，再 Move 覆盖 dest
  if (Test-Path $stage) { Remove-Item -Recurse -Force $stage -ErrorAction SilentlyContinue }
  Copy-Item -Recurse -Force $srcDir $stage
  if (-not (Test-Entries $stage)) { throw "staging 失败：$stage" }
  if (Test-Path $dest) { Remove-Item -Recurse -Force $dest }
  Move-Item $stage $dest

  if (-not (Test-Entries $dest)) { throw "安装失败：$dest 缺少入口" }
  Write-Host "✓ 已安装到 $dest" -ForegroundColor Green
  Write-Host "  通常无需重启（插件目录被文件监视，会自动热重载）；必要时 opencode service restart" -ForegroundColor Green
  Write-Host "  然后在 TUI 里运行 /connect-providers" -ForegroundColor Green
} finally {
  if (Test-Path $tmp) { Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue }
  if (Test-Path $stage) { Remove-Item -Recurse -Force $stage -ErrorAction SilentlyContinue }
}

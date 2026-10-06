#!/usr/bin/env bash
# opencode-providers 全局安装脚本（bash）
# 用法: curl -fsSL https://raw.githubusercontent.com/Just-Silver/opencode-providers/main/install.sh | bash
# 说明: 优先安装「最新 Release」；仓库尚无 Release 时回退到 main。
set -euo pipefail
REPO="Just-Silver/opencode-providers"
REPO_URL="https://github.com/$REPO.git"
# releases/latest 是 302 跳转：读最终 URL 尾部即最新 tag（不用 api.github.com，避免限流/403）
LATEST_URL="https://github.com/$REPO/releases/latest"
XDG_BASE="${XDG_CONFIG_HOME:-$HOME/.config}"
PLUGINS_DIR="$XDG_BASE/opencode/plugins"
# 发现器只认 plugins/ 的直接子项；目录型插件以 tui.tsx 为 TUI 入口、index.ts/server.ts 为 server 入口。
# 本插件两者都需要：整目录落在 plugins/opencode-providers/。
DEST="$PLUGINS_DIR/opencode-providers"
TMP="$(mktemp -d)"
# STAGE 必须与 DEST 同文件系统才原子（同目录必同 FS）；固定名 + 复制前先清理，异常残留也不影响下次
STAGE="$PLUGINS_DIR/.tmp.opencode-providers"
trap 'rm -rf "$TMP" "$STAGE"' EXIT

# 颜色：成功绿 失败红 警告黄（非 TTY 自动禁用）
if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then
  GREEN='\033[32m'; RED='\033[31m'; YELLOW='\033[33m'; RESET='\033[0m'
else
  GREEN=''; RED=''; YELLOW=''; RESET=''
fi

# 解析安装 ref：优先最新 Release 的 tag，回退 main
resolve_ref() {
  if command -v curl >/dev/null 2>&1; then
    local url
    url="$(curl -fsSL -o /dev/null -w '%{url_effective}' "$LATEST_URL" 2>/dev/null || true)"
    case "$url" in
      */releases/tag/*) printf '%s' "${url##*/releases/tag/}"; return 0 ;;
    esac
  fi
  if command -v git >/dev/null 2>&1; then
    local tag
    tag="$(git ls-remote --tags --refs --sort=-v:refname "$REPO_URL" 2>/dev/null | head -n1 | sed -n 's#.*refs/tags/##p')"
    if [ -n "$tag" ]; then printf '%s' "$tag"; return 0; fi
  fi
  printf 'main'
}

REF="$(resolve_ref)"
case "$REF" in
  main) ARCHIVE_URL="https://github.com/$REPO/archive/refs/heads/main.tar.gz" ;;
  *)    ARCHIVE_URL="https://github.com/$REPO/archive/refs/tags/$REF.tar.gz" ;;
esac

echo "→ 安装版本: $REF"
echo "→ 目标目录: $DEST"
mkdir -p "$PLUGINS_DIR"

has_entries() { [ -f "$1/index.ts" ] && [ -f "$1/tui.tsx" ]; }

cloned=0
if command -v git >/dev/null 2>&1; then
  echo "→ git clone --depth 1 --branch $REF $REPO_URL"
  if git clone --depth 1 --branch "$REF" "$REPO_URL" "$TMP" 2>/dev/null && has_entries "$TMP/.opencode/plugins/opencode-providers"; then
    cloned=1
  else
    printf "${YELLOW}warn: git clone 失败，尝试 curl 回退${RESET}\n" >&2
    rm -rf "$TMP"
    mkdir -p "$TMP"
  fi
fi

if [ "$cloned" -eq 0 ]; then
  command -v curl >/dev/null 2>&1 || { printf "${RED}需要 git 或 curl${RESET}\n" >&2; exit 1; }
  echo "→ curl $ARCHIVE_URL"
  mkdir -p "$TMP"
  if ! curl -fsSL "$ARCHIVE_URL" | tar -xz -C "$TMP" --strip-components=1; then
    printf "${RED}下载或解压失败${RESET}\n" >&2
    exit 1
  fi
  has_entries "$TMP/.opencode/plugins/opencode-providers" || { printf "${RED}解压后未找到插件入口（index.ts / tui.tsx）${RESET}\n" >&2; exit 1; }
fi

SRC_DIR="$TMP/.opencode/plugins/opencode-providers"
has_entries "$SRC_DIR" || { printf "${RED}未找到 $SRC_DIR 的 index.ts / tui.tsx${RESET}\n" >&2; exit 1; }

# 原子替换：整目录 cp 到同文件系统的 STAGE，再 mv 覆盖 DEST
# STAGE 若残留（上次 kill -9/断电），cp -rf 会嵌套复制而非覆盖，故复制前先清空
rm -rf "$STAGE"
cp -rf "$SRC_DIR" "$STAGE"
has_entries "$STAGE" || { printf "${RED}staging 失败: $STAGE${RESET}\n" >&2; exit 1; }
rm -rf "$DEST"
mv "$STAGE" "$DEST"

has_entries "$DEST" || { printf "${RED}安装失败${RESET}\n" >&2; exit 1; }
printf "${GREEN}✓ 已安装到 $DEST${RESET}\n"
printf "${GREEN}  重启 opencode（或 opencode service restart）后，在 TUI 里运行 /connect-providers${RESET}\n"

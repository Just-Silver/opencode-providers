#!/usr/bin/env bash
# opencode-providers 卸载脚本（bash）
# 用法: curl -fsSL https://raw.githubusercontent.com/Just-Silver/opencode-providers/main/uninstall.sh | bash
set -euo pipefail
XDG_BASE="${XDG_CONFIG_HOME:-$HOME/.config}"
PLUGINS_DIR="$XDG_BASE/opencode/plugins"
DEST="$PLUGINS_DIR/opencode-providers"
STAGE="$PLUGINS_DIR/.tmp.opencode-providers"

if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then
  GREEN='\033[32m'; YELLOW='\033[33m'; RESET='\033[0m'
else
  GREEN=''; YELLOW=''; RESET=''
fi

removed=0
for target in "$DEST" "$STAGE"; do
  if [ -e "$target" ]; then
    rm -rf "$target"
    printf "${GREEN}✓ 已删除 %s${RESET}\n" "$target"
    removed=1
  fi
done

if [ "$removed" -eq 0 ]; then
  printf "${YELLOW}未找到已安装的插件（%s）${RESET}\n" "$DEST"
fi

echo "重启 opencode（或 opencode service restart）后生效。"
echo "凭据仍保留在 opencode 的 SQLite 里；如需清除，用 /connect 或 opencode auth 管理。"

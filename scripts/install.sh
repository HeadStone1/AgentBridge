#!/bin/sh
set -eu

PACKAGE_ROOT=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
PROJECT_PATH=$(pwd)
INSTALL_ROOT=${AGENTBRIDGE_INSTALL_ROOT:-"$HOME/.agentbridge"}
RUN_SETUP=1

while [ "$#" -gt 0 ]; do
  case "$1" in
    --project) PROJECT_PATH=$2; shift 2 ;;
    --install-root) INSTALL_ROOT=$2; shift 2 ;;
    --no-setup) RUN_SETUP=0; shift ;;
    *) PROJECT_PATH=$1; shift ;;
  esac
done

VERSION=$(tr -d '\r\n' < "$PACKAGE_ROOT/VERSION")
[ -n "$VERSION" ] || { echo 'VERSION is empty.' >&2; exit 1; }

VERSION_ROOT="$INSTALL_ROOT/versions/$VERSION"
mkdir -p "$VERSION_ROOT" "$INSTALL_ROOT/bin"
cp -R "$PACKAGE_ROOT/app" "$VERSION_ROOT/"
cp -R "$PACKAGE_ROOT/runtime" "$VERSION_ROOT/"
cp "$PACKAGE_ROOT/release.json" "$PACKAGE_ROOT/LICENSE" "$VERSION_ROOT/"
cp "$PACKAGE_ROOT/bin/agentbridge" "$INSTALL_ROOT/bin/agentbridge"
chmod +x "$VERSION_ROOT/runtime/node" "$INSTALL_ROOT/bin/agentbridge"
printf '%s\n' "$VERSION" > "$INSTALL_ROOT/current"

if [ "$RUN_SETUP" -eq 1 ]; then
  "$INSTALL_ROOT/bin/agentbridge" setup "$PROJECT_PATH"
fi

printf 'AgentBridge %s installed in %s\n' "$VERSION" "$INSTALL_ROOT"
printf 'Launcher: %s\n' "$INSTALL_ROOT/bin/agentbridge"
printf 'Restart Claude Code and Codex after setup.\n'

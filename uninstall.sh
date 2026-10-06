#!/bin/bash
# Remove the dsh-airlock program files. Your data is left alone: the sandbox
# home (sessions, settings, stored keys) and the workspace are listed at the
# end so you can delete them yourself if you want them gone.
set -euo pipefail

PREFIX="${PREFIX:-$HOME/.local}"
ROOT="${DSH_AIRLOCK_ROOT:-$PREFIX/share/dsh-airlock}"
BIN="$PREFIX/bin/dsh-airlock"

if pgrep -f "$ROOT/upstream/" >/dev/null 2>&1; then
  echo "uninstall: dsh-airlock is running; stop it first (Ctrl+C in its terminal)" >&2
  exit 1
fi
[ -d "$ROOT" ] && rm -rf "$ROOT" && echo "removed $ROOT"
[ -f "$BIN" ] && rm -f "$BIN" && echo "removed $BIN"
echo
echo "Left in place (your data):"
echo "  ${DSH_AIRLOCK_HOME:-$HOME/.dsh-airlock}   sandbox home: sessions, settings, stored keys"
echo "  ${DSH_WORKSPACE:-$HOME/Documents/dsh-workspace}   workspace"

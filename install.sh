#!/bin/bash
# Install dsh-airlock for the current user. No admin rights needed.
#
#   ./install.sh            install to ~/.local (launcher in ~/.local/bin)
#   PREFIX=/some/dir ./install.sh
#
# Installs the DSH (DeepSeek Harness) release pinned in upstream/ from npm with
# `npm ci --ignore-scripts` (exact versions and integrity hashes from the
# committed lockfile, no install scripts run), then the search plugin, the
# runner, the self-test and the dsh-airlock launcher.
set -euo pipefail

REPO="$(cd "$(dirname "$0")" && pwd -P)"
PREFIX="${PREFIX:-$HOME/.local}"
ROOT="${DSH_AIRLOCK_ROOT:-$PREFIX/share/dsh-airlock}"
BIN_DIR="$PREFIX/bin"

die() { echo "install: $*" >&2; exit 1; }

[ "$(uname -s)" = "Darwin" ] || die "dsh-airlock needs macOS"
[ -x /usr/bin/sandbox-exec ] || die "/usr/bin/sandbox-exec not found"
command -v node >/dev/null || die "node not found (Node.js 22 or newer)"
command -v npm >/dev/null || die "npm not found"
node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 22 ? 0 : 1)' || die "Node.js 22 or newer is required (found $(node --version))"

VERSION="$(node -p 'require(process.argv[1]).dependencies["@deepseek-ai/dsh"]' "$REPO/upstream/package.json")"
DEST="$ROOT/upstream/$VERSION"
echo "install: DSH $VERSION -> $DEST"

if [ -f "$DEST/node_modules/@deepseek-ai/dsh/lib/bin.js" ] && cmp -s "$REPO/upstream/package-lock.json" "$DEST/package-lock.json"; then
  echo "install: DSH $VERSION already installed from the same lockfile"
else
  rm -rf "$DEST.partial"
  mkdir -p "$DEST.partial"
  cp "$REPO/upstream/package.json" "$REPO/upstream/package-lock.json" "$DEST.partial/"
  (cd "$DEST.partial" && npm ci --ignore-scripts --omit=dev --no-audit --no-fund)
  # node-pty ships its macOS spawn-helper without the executable bit; dsh's own
  # postinstall restores it. Run just that step (it only calls chmod).
  node "$DEST.partial/node_modules/@deepseek-ai/dsh-subprocess-local/scripts/ensure-spawn-helper.mjs"
  rm -rf "$DEST"
  mv "$DEST.partial" "$DEST"
fi

PLUGIN="$DEST/node_modules/dsh-airlock-web-search"
rm -rf "$PLUGIN"
mkdir -p "$PLUGIN"
cp "$REPO/plugins/web-search/package.json" "$REPO/plugins/web-search/index.js" "$REPO/plugins/web-search/provider.js" "$PLUGIN/"
[ -f "$REPO/plugins/web-search/README.md" ] && cp "$REPO/plugins/web-search/README.md" "$PLUGIN/"
# dsh only imports plugins in the dependency closure of its own package.json
# (or installed per profile with pnpm). Declare the search plugin there so
# every profile can load it. This is the one edit made to an upstream file.
node -e '
  const fs = require("fs");
  const [file, name, version] = process.argv.slice(1);
  const manifest = JSON.parse(fs.readFileSync(file, "utf8"));
  manifest.dependencies = { ...manifest.dependencies, [name]: version };
  fs.writeFileSync(file, JSON.stringify(manifest, null, 2) + "\n");
' "$DEST/node_modules/@deepseek-ai/dsh/package.json" dsh-airlock-web-search \
  "$(node -p 'require(process.argv[1]).version' "$REPO/plugins/web-search/package.json")"
ln -sfn "$VERSION" "$ROOT/upstream/current"

mkdir -p "$ROOT/libexec" "$BIN_DIR"
install -m 755 "$REPO/libexec/passthrough-runner" "$REPO/libexec/selftest.sh" "$ROOT/libexec/"
install -m 755 "$REPO/bin/dsh-airlock" "$BIN_DIR/dsh-airlock"
if [ -n "${DSH_AIRLOCK_ROOT:-}" ] || [ "$ROOT" != "$HOME/.local/share/dsh-airlock" ]; then
  echo "install: note: run dsh-airlock with DSH_AIRLOCK_ROOT=$ROOT"
fi

for old in "$ROOT"/upstream/*; do
  name="$(basename "$old")"
  [ "$name" = current ] || [ "$name" = "$VERSION" ] && continue
  echo "install: older DSH install left in place: $old (remove it when you no longer need it)"
done

echo
echo "Installed. Next:"
case ":$PATH:" in *":$BIN_DIR:"*) ;; *) echo "  - add $BIN_DIR to your PATH" ;; esac
echo "  1. dsh-airlock --setup        add a model key in Settings > Models, pick the model, Ctrl+C"
echo "  2. dsh-airlock --set-key BRAVE_SEARCH_API_KEY   (or: dsh-airlock --search searxng <url>)"
echo "  3. dsh-airlock --selftest     prove the box holds"
echo "  4. dsh-airlock                normal use"

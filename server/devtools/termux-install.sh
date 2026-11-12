#!/data/data/com.termux/files/usr/bin/bash
# Sets up Termux for Pocket Agent, in one go:
#   - lets the Pocket Agent app run commands in Termux (the `termux` command Claude has in the app);
#   - installs Claude Code (Linux ARM build, run through proot: it needs glibc's loader at /lib);
#   - installs the Pocket Agent server in ~/pocket-agent, to run Claude in Termux instead of the app's built-in Linux.
# Get it from the app: Settings → Termux → Set up Termux. The app's server fills in APP and CODE and serves
# the server code too, so Termux gets the same version as the app with no GitHub access needed.
# Safe to run again: it updates Claude Code and the server.
set -euo pipefail
APP="${PA_APP:-__APP__}"; CODE="${PA_CODE:-__CODE__}"
P=/data/data/com.termux/files/usr
DEST="$HOME/pocket-agent"
step() { printf '\n\033[1m%s\033[0m\n' "$*"; }
die() { printf '\n\033[31m%s\033[0m\n' "$*" >&2; exit 1; }

[ -d "$P" ] && [ "${PREFIX:-}" = "$P" ] || die "Run this in Termux."
[ "$(uname -m)" = aarch64 ] || die "Claude Code needs a 64-bit ARM phone (this is $(uname -m))."

step "1/5 Termux packages (nodejs, git, proot, glibc)"
export DEBIAN_FRONTEND=noninteractive
PKG_OPTS=(-y -o Dpkg::Options::=--force-confold)
pkg update "${PKG_OPTS[@]}" >/dev/null 2>&1 || pkg update "${PKG_OPTS[@]}"
pkg install "${PKG_OPTS[@]}" nodejs-lts git curl proot glibc-repo
pkg install "${PKG_OPTS[@]}" glibc-runner          # glibc's loader and libraries, in $PREFIX/glibc/lib
[ -e "$P/glibc/lib/ld-linux-aarch64.so.1" ] || die "glibc didn't install ($P/glibc/lib/ld-linux-aarch64.so.1 is missing)."

step "2/5 Let Pocket Agent run commands in Termux"
mkdir -p ~/.termux; F=~/.termux/termux.properties; touch "$F"
if grep -qE '^\s*allow-external-apps' "$F"; then sed -i -E 's/^\s*allow-external-apps.*/allow-external-apps = true/' "$F"
else echo "allow-external-apps = true" >> "$F"; fi
command -v termux-reload-settings >/dev/null && termux-reload-settings || true

step "3/5 Claude Code"
BASE=https://downloads.claude.ai/claude-code-releases
VER=$(curl -fsSL "$BASE/latest")
[[ "$VER" =~ ^[0-9]+\.[0-9]+\.[0-9]+ ]] || die "Couldn't read the latest Claude Code version."
SUM=$(curl -fsSL "$BASE/$VER/manifest.json" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(JSON.parse(s).platforms["linux-arm64"].checksum))')
BIN="$HOME/.cc/package/claude"; mkdir -p "$(dirname "$BIN")"
if [ -x "$BIN" ] && [ "$(sha256sum "$BIN" | cut -d' ' -f1)" = "$SUM" ]; then echo "Claude Code $VER is already installed."
else
  curl -fL --progress-bar -o "$BIN.new" "$BASE/$VER/linux-arm64/claude"
  [ "$(sha256sum "$BIN.new" | cut -d' ' -f1)" = "$SUM" ] || { rm -f "$BIN.new"; die "Claude Code download failed its checksum."; }
  chmod 755 "$BIN.new"; mv "$BIN.new" "$BIN"
fi
cat > "$P/bin/claude" <<'EOF'
#!/data/data/com.termux/files/usr/bin/bash
# Claude Code in Termux (installed by Pocket Agent's server/devtools/termux-install.sh; rerun that to update).
# The binary is built for glibc and expects the loader at /lib/ld-linux-aarch64.so.1, which Android lacks.
# proot maps Termux's glibc onto /lib so the binary runs as itself. (`grun` runs it through the loader
# instead, which breaks everything that re-runs Claude: background sessions, built-in grep/find.)
P=/data/data/com.termux/files/usr
BIN="$HOME/.cc/package/claude"
unset LD_PRELOAD
export DISABLE_AUTOUPDATER=1     # its updater would install a build that can't start here
run() { proot -b "$P/glibc/lib:/lib" "$@"; }
# Background sessions are supervised by `claude daemon`; start it detached so it never holds the terminal.
if ! run "$BIN" daemon status >/dev/null 2>&1; then
  setsid nohup proot -b "$P/glibc/lib:/lib" "$BIN" daemon run </dev/null >>"$HOME/.claude/daemon-launcher.log" 2>&1 &
  for _ in 1 2 3 4 5 6 7 8 9 10; do run "$BIN" daemon status >/dev/null 2>&1 && break; sleep 0.3; done
fi
exec proot --kill-on-exit -b "$P/glibc/lib:/lib" "$BIN" "$@"
EOF
chmod 755 "$P/bin/claude"; mkdir -p ~/.claude
claude --version || die "Claude Code doesn't start. Copy the output above into an issue."

step "4/5 Pocket Agent server (from the app)"
case "$APP" in __*) die "Get this script from the app: Settings → Termux → Set up Termux." ;; esac
TGZ="${TMPDIR:-$P/tmp}/pocket-agent-bundle.tgz"
curl -fsSL "$APP/termux/bundle.tgz?code=$CODE" -o "$TGZ" || die "Couldn't download from the app. Open Pocket Agent, then get a new command (the code lasts 30 minutes)."
mkdir -p "$DEST"; rm -rf "$DEST/server/src" "$DEST/app"
tar xzf "$TGZ" -C "$DEST"; rm -f "$TGZ"
(cd "$DEST/server" && npm install --omit=optional --no-audit --no-fund 2>&1 | tail -1)
chmod 755 "$DEST/server/bin/pocket-agent"
# Its #!/usr/bin/env line works in Termux's shells only; the app starts it through RUN_COMMAND, which doesn't.
termux-fix-shebang "$DEST/server/bin/pocket-agent"
ln -sf "$DEST/server/bin/pocket-agent" "$P/bin/pocket-agent"

step "5/5 Start"
pocket-agent stop >/dev/null 2>&1 || true
pocket-agent start
TOKEN=$(pocket-agent token)
cat <<EOF

Done. Termux is ready for Pocket Agent.
  - The app's Claude can now run commands here (\`termux <command>\`).
  - To run Claude in Termux instead of the app's built-in Linux:
      1. Sign in once:  claude auth login
      2. In Pocket Agent: Settings → Claude runs on → Another server
         address  http://127.0.0.1:8765
         token    $TOKEN
  - Server: pocket-agent status | restart | logs    Update: get a new command from the app and run it again.
EOF

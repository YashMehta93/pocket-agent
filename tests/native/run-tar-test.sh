#!/usr/bin/env bash
# Compares the app's tar extractor (Tar.java) with GNU tar on the real Alpine rootfs archive.
set -euo pipefail
cd "$(dirname "$0")/../.."
W=$(mktemp -d); trap 'chmod -R u+w "$W" 2>/dev/null; rm -rf "$W"' EXIT
Y=$(curl -fsSL https://dl-cdn.alpinelinux.org/alpine/latest-stable/releases/aarch64/latest-releases.yaml)
F=$(echo "$Y" | grep -o 'alpine-minirootfs-[0-9.]*-aarch64\.tar\.gz' | head -1)
TGZ="${ALPINE_TGZ:-$HOME/pa-spike/$F}"
[ -f "$TGZ" ] || { TGZ="$W/$F"; curl -fsSL -o "$TGZ" "https://dl-cdn.alpinelinux.org/alpine/latest-stable/releases/aarch64/$F"; }
mkdir -p "$W/classes" "$W/ours" "$W/ref"
javac -d "$W/classes" app/src/com/pocketagent/Tar.java tests/native/TarAccess.java tests/native/TarTest.java
tar xzpf "$TGZ" -C "$W/ref" 2>/dev/null || true
java -cp "$W/classes" TarTest "$TGZ" "$W/ours" "$W/ref"

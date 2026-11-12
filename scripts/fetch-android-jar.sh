#!/usr/bin/env bash
# Downloads the Android 14 (API 34) platform's android.jar into sdk/ — the only part of the
# Android SDK that build.sh needs besides the build tools. Inside the app, "Build Pocket Agent
# yourself" does this for you.
set -euo pipefail
cd "$(dirname "$0")/.."
[ -f sdk/android.jar ] && { echo "sdk/android.jar already there"; exit 0; }
mkdir -p sdk; tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT
curl -fL --retry 5 -o "$tmp/p.zip" https://dl.google.com/android/repository/platform-34-ext7_r03.zip
unzip -o -j "$tmp/p.zip" '*/android.jar' -d sdk >/dev/null
echo "sdk/android.jar ready ($(du -h sdk/android.jar | cut -f1))"

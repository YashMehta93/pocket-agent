#!/usr/bin/env bash
# Builds the Pocket Agent APK without Gradle, using Termux's Android tools:
# aapt2 (resources) -> javac (code) -> d8 (dex) -> zip (+ native libs) -> zipalign -> apksigner.
#
# The APK carries everything for standalone mode:
#   assets/ui/       the chat UI (also served by the server)
#   assets/server/   the bridge server, copied into the built-in Linux on first run / app update
#   assets/bundle.json  version of that bundle (a change triggers re-copy inside the app)
#   lib/arm64-v8a/   proot + libraries (app/jniLibs, see app/native/prepare-proot.sh)
#
# Usage: ./build.sh   builds build/pocket-agent.apk and copies it to Downloads/claude apps/
set -euo pipefail
cd "$(dirname "$0")"

SDK=sdk/android.jar
APP=app
OUT=build
KS=pocket-agent.keystore
# Versions (see docs/RELEASES.md): the name comes from ./VERSION; the Android version code is the
# number of commits on this branch, so it only ever goes up. Builds that aren't exactly a release
# tag are marked "-dev.<code>".
VERSION=$(cat VERSION)
VERSION_CODE=$(git rev-list --count HEAD 2>/dev/null || echo 1)
if [ "$(git describe --tags --exact-match HEAD 2>/dev/null)" = "v$VERSION" ] || [ "${PA_RELEASE:-}" = 1 ]; then VERSION_NAME="$VERSION"
else VERSION_NAME="$VERSION-dev.$VERSION_CODE"; fi
# SDK 28 like Termux: newer targets can't execute programs from app storage (needed by proot).
TARGET_SDK=28

[ -f "$SDK" ] || { echo "missing $SDK (see CONTRIBUTING.md)"; exit 1; }
rm -rf "$OUT"; mkdir -p "$OUT/gen" "$OUT/classes" "$OUT/dex" "$OUT/assets" "$OUT/apkroot/lib/arm64-v8a"

echo "[1/7] bundle"
cp -r "$APP/assets/." "$OUT/assets/"
mkdir -p "$OUT/assets/server"
cp -r server/src server/bin server/devtools server/package.json server/trusted-keys.json "$OUT/assets/server/"
cp VERSION "$OUT/assets/server/VERSION"
[ -f server/package-lock.json ] && cp server/package-lock.json "$OUT/assets/server/"
BUNDLE_HASH=$( (cd "$OUT/assets" && find server ui -type f | sort | xargs cat) | sha256sum | cut -c1-16)
printf '{"version": "%s", "versionCode": %s, "hash": "%s"}\n' "$VERSION_NAME" "$VERSION_CODE" "$BUNDLE_HASH" > "$OUT/assets/bundle.json"

echo "[2/7] resources"
aapt2 compile --dir "$APP/res" -o "$OUT/res.zip"
aapt2 link -I "$SDK" --manifest "$APP/AndroidManifest.xml" -A "$OUT/assets" \
  --java "$OUT/gen" --min-sdk-version 26 --target-sdk-version "$TARGET_SDK" \
  --version-code "$VERSION_CODE" --version-name "$VERSION_NAME" \
  -o "$OUT/unsigned.apk" "$OUT/res.zip"

echo "[3/7] compile"
find "$APP/src" "$OUT/gen" -name '*.java' > "$OUT/sources.txt"
javac --release 11 -Xlint:-options -encoding UTF-8 \
  -cp "$SDK" -d "$OUT/classes" @"$OUT/sources.txt"

echo "[4/7] dex"
d8 --release --min-api 26 --lib "$SDK" --output "$OUT/dex" \
  $(find "$OUT/classes" -name '*.class')

echo "[5/7] package"
(cd "$OUT/dex" && zip -qj ../unsigned.apk classes.dex)
cp "$APP"/jniLibs/arm64-v8a/*.so "$OUT/apkroot/lib/arm64-v8a/"
(cd "$OUT/apkroot" && zip -qr ../unsigned.apk lib)
zipalign -p -f 4 "$OUT/unsigned.apk" "$OUT/aligned.apk"

echo "[6/7] sign"
if [ ! -f "$KS" ]; then
  keytool -genkeypair -keystore "$KS" -alias pocket -keyalg RSA -keysize 2048 \
    -validity 36500 -storepass pocketagent -keypass pocketagent \
    -dname "CN=Pocket Agent" >/dev/null 2>&1
fi
apksigner sign --ks "$KS" --ks-pass pass:pocketagent --key-pass pass:pocketagent \
  --out "$OUT/pocket-agent.apk" "$OUT/aligned.apk"

# Version info for in-app updates (served by the server as app.update).
# signer: SHA-256 of the signing certificate. The app compares it with its own, because Android only
# installs an update signed with the same key (a friend's own build can't update the official app).
SIGNER=$(keytool -exportcert -keystore "$KS" -alias pocket -storepass pocketagent 2>/dev/null | sha256sum | cut -c1-64)
printf '{"versionCode": %s, "versionName": "%s", "builtAt": %s, "signer": "%s"}\n' "$VERSION_CODE" "$VERSION_NAME" "$(date +%s)000" "$SIGNER" > "$OUT/pocket-agent.json"
rm -rf "$OUT/unsigned.apk" "$OUT/aligned.apk" "$OUT/apkroot"

echo "[7/7] done: $OUT/pocket-agent.apk ($(du -h "$OUT/pocket-agent.apk" | cut -f1), v$VERSION_NAME, bundle $BUNDLE_HASH)"

DEST="$HOME/storage/downloads/claude apps"
mkdir -p "$DEST"
cp "$OUT/pocket-agent.apk" "$DEST/pocket-agent.apk"
echo "saved: Downloads/claude apps/pocket-agent.apk"

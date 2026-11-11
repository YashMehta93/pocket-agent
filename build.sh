#!/data/data/com.termux/files/usr/bin/bash
# Builds the Pocket Agent APK without Gradle, using Termux's Android tools:
# aapt2 (resources) -> javac (code) -> d8 (dex) -> zipalign -> apksigner.
# Usage: ./build.sh   build build/pocket-agent.apk and copy it to
#                     Downloads/claude apps/ (install it from Files)
set -euo pipefail
cd "$(dirname "$0")"

SDK=sdk/android.jar
APP=app
OUT=build
KS=pocket-agent.keystore
VERSION_CODE=$(git rev-list --count HEAD 2>/dev/null || echo 1)
VERSION_NAME="0.1.$VERSION_CODE"

[ -f "$SDK" ] || { echo "missing $SDK (see README)"; exit 1; }
rm -rf "$OUT"; mkdir -p "$OUT/gen" "$OUT/classes" "$OUT/dex"

echo "[1/6] resources"
aapt2 compile --dir "$APP/res" -o "$OUT/res.zip"
aapt2 link -I "$SDK" --manifest "$APP/AndroidManifest.xml" -A "$APP/assets" \
  --java "$OUT/gen" --min-sdk-version 26 --target-sdk-version 34 \
  --version-code "$VERSION_CODE" --version-name "$VERSION_NAME" \
  -o "$OUT/unsigned.apk" "$OUT/res.zip"

echo "[2/6] compile"
find "$APP/src" "$OUT/gen" -name '*.java' > "$OUT/sources.txt"
javac -source 8 -target 8 -Xlint:-options -encoding UTF-8 \
  -bootclasspath "$SDK" -d "$OUT/classes" @"$OUT/sources.txt"

echo "[3/6] dex"
d8 --release --min-api 26 --lib "$SDK" --output "$OUT/dex" \
  $(find "$OUT/classes" -name '*.class')

echo "[4/6] package"
(cd "$OUT/dex" && zip -qj ../unsigned.apk classes.dex)
zipalign -p -f 4 "$OUT/unsigned.apk" "$OUT/aligned.apk"

echo "[5/6] sign"
if [ ! -f "$KS" ]; then
  keytool -genkeypair -keystore "$KS" -alias pocket -keyalg RSA -keysize 2048 \
    -validity 36500 -storepass pocketagent -keypass pocketagent \
    -dname "CN=Pocket Agent" >/dev/null 2>&1
fi
apksigner sign --ks "$KS" --ks-pass pass:pocketagent --key-pass pass:pocketagent \
  --out "$OUT/pocket-agent.apk" "$OUT/aligned.apk"

echo "[6/6] done: $OUT/pocket-agent.apk ($(du -h "$OUT/pocket-agent.apk" | cut -f1), v$VERSION_NAME)"

DEST="$HOME/storage/downloads/claude apps"
mkdir -p "$DEST"
cp "$OUT/pocket-agent.apk" "$DEST/pocket-agent.apk"
echo "saved: Downloads/claude apps/pocket-agent.apk"

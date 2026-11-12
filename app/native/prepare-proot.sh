#!/data/data/com.termux/files/usr/bin/bash
# Copies proot and its libraries from Termux into app/jniLibs/arm64-v8a/ as lib*.so files
# (Android only lets apps execute files shipped as native libraries), patched to run
# outside Termux: no Termux library path, and libtalloc renamed to a plain .so name.
# Run after `pkg upgrade proot` to pick up a new proot. Output is committed.
set -euo pipefail
P=/data/data/com.termux/files/usr
PE="$P/glibc/bin/patchelf"; command -v patchelf >/dev/null && PE=patchelf
OUT="$(cd "$(dirname "$0")/.." && pwd)/jniLibs/arm64-v8a"
mkdir -p "$OUT"
install -m 755 "$P/bin/proot" "$OUT/libproot.so"
install -m 755 "$P/lib/libtalloc.so.2" "$OUT/libtalloc.so"
install -m 755 "$P/lib/libandroid-shmem.so" "$OUT/libandroid-shmem.so"
install -m 755 "$P/libexec/proot/loader" "$OUT/libproot-loader.so"
"$PE" --replace-needed libtalloc.so.2 libtalloc.so --remove-rpath "$OUT/libproot.so"
"$PE" --set-soname libtalloc.so --remove-rpath "$OUT/libtalloc.so"
"$PE" --remove-rpath "$OUT/libandroid-shmem.so"
for f in "$OUT"/*.so; do echo "$(basename "$f"): $("$PE" --print-needed "$f" 2>/dev/null | tr '\n' ' ')"; done
echo "proot $(dpkg -s proot 2>/dev/null | sed -n 's/^Version: //p') prepared in $OUT"

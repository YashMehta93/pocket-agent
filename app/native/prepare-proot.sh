#!/usr/bin/env bash
# Refreshes the proot binaries bundled in the APK (app/jniLibs/arm64-v8a/), from Termux's public
# package repository — no Termux install needed. Android only executes files shipped as native
# libraries, so they're renamed to lib*.so and patched to run outside Termux (no Termux library
# path; libtalloc under a plain .so name). The output is committed; run this only to update proot.
#
# Needs: curl, node, tar with xz, patchelf (all present after Settings → Build Pocket Agent yourself).
set -euo pipefail
cd "$(dirname "$0")/.."
REPO=https://packages-cf.termux.dev/apt/termux-main
OUT="$PWD/jniLibs/arm64-v8a"
W=$(mktemp -d); trap 'rm -rf "$W"' EXIT
command -v patchelf >/dev/null || { echo "patchelf is missing (Alpine: apk add patchelf)"; exit 1; }

echo "== package index"
curl -fsSL "$REPO/dists/stable/main/binary-aarch64/Packages" -o "$W/Packages"
for pkg in proot libtalloc libandroid-shmem; do
  file=$(awk -v p="$pkg" '$1=="Package:"{cur=$2} $1=="Filename:" && cur==p {print $2; exit}' "$W/Packages")
  [ -n "$file" ] || { echo "$pkg not found in the index"; exit 1; }
  echo "   $pkg: $(basename "$file")"
  curl -fsSL "$REPO/$file" -o "$W/$pkg.deb"
  # .deb files are 'ar' archives; pull out data.tar.* with a few lines of node (no binutils needed)
  node -e '
    const fs = require("fs"); const b = fs.readFileSync(process.argv[1]); let o = 8;
    while (o < b.length) {
      const name = b.toString("latin1", o, o + 16).trim().replace(/\/$/, ""), size = parseInt(b.toString("latin1", o + 48, o + 58));
      if (name.startsWith("data.tar")) { fs.writeFileSync(process.argv[2] + "/" + name, b.subarray(o + 60, o + 60 + size)); break; }
      o += 60 + size + (size % 2);
    }' "$W/$pkg.deb" "$W"
  mkdir -p "$W/root"; tar xf "$W"/data.tar.* -C "$W/root"; rm -f "$W"/data.tar.*
done

P="$W/root/data/data/com.termux/files/usr"
mkdir -p "$OUT"
install -m 755 "$P/bin/proot" "$OUT/libproot.so"
install -m 755 "$(readlink -f "$P/lib/libtalloc.so.2")" "$OUT/libtalloc.so"
install -m 755 "$P/lib/libandroid-shmem.so" "$OUT/libandroid-shmem.so"
install -m 755 "$P/libexec/proot/loader" "$OUT/libproot-loader.so"
patchelf --replace-needed libtalloc.so.2 libtalloc.so --remove-rpath "$OUT/libproot.so"
patchelf --set-soname libtalloc.so --remove-rpath "$OUT/libtalloc.so"
patchelf --remove-rpath "$OUT/libandroid-shmem.so"
for f in "$OUT"/*.so; do echo "   $(basename "$f"): needs $(patchelf --print-needed "$f" 2>/dev/null | tr '\n' ' ')"; done
echo "done. Rebuild the APK (bash build.sh) and commit app/jniLibs."

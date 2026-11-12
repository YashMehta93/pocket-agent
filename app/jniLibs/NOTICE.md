# Bundled native binaries

Prepared from Termux packages by `app/native/prepare-proot.sh` (aarch64).

| File | Project | License | Source |
|---|---|---|---|
| `libproot.so`, `libproot-loader.so` | PRoot (Termux fork) | GPL-2.0 | https://github.com/termux/proot |
| `libtalloc.so` | talloc (Samba) | LGPL-3.0 | https://talloc.samba.org |
| `libandroid-shmem.so` | libandroid-shmem | BSD-3-Clause | https://github.com/termux/libandroid-shmem |

These run Pocket Agent's built-in Linux environment. If you share the APK, point people to these
sources (GPL/LGPL require the corresponding source to be available).

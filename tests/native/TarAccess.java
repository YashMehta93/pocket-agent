package com.pocketagent;

import java.io.File;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.attribute.PosixFilePermission;
import java.util.HashSet;
import java.util.Set;

/** Test bridge: runs the package-private Tar extractor with java.nio instead of android.system.Os. */
public final class TarAccess {
    public static int extract(File tgz, File dest) throws Exception {
        return Tar.extractGz(tgz, dest, new Tar.Fs() {
            @Override public void symlink(String target, String path) throws Exception { Files.createSymbolicLink(Path.of(path), Path.of(target)); }
            @Override public void chmod(String path, int mode) throws Exception {
                Set<PosixFilePermission> s = new HashSet<>();
                PosixFilePermission[] all = { PosixFilePermission.OTHERS_EXECUTE, PosixFilePermission.OTHERS_WRITE, PosixFilePermission.OTHERS_READ,
                    PosixFilePermission.GROUP_EXECUTE, PosixFilePermission.GROUP_WRITE, PosixFilePermission.GROUP_READ,
                    PosixFilePermission.OWNER_EXECUTE, PosixFilePermission.OWNER_WRITE, PosixFilePermission.OWNER_READ };
                for (int i = 0; i < 9; i++) if ((mode & (1 << i)) != 0) s.add(all[i]);
                Files.setPosixFilePermissions(Path.of(path), s);
            }
        });
    }
}

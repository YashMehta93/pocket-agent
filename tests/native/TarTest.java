import java.io.File;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.nio.file.attribute.PosixFilePermission;
import java.security.MessageDigest;
import java.util.HashSet;
import java.util.Set;
import java.util.stream.Stream;

/**
 * Checks app/src/.../Tar.java against GNU tar on a real archive (the Alpine rootfs the app downloads):
 * same entries, types, symlink targets, file contents and permission bits.
 * Run: tests/native/run-tar-test.sh
 */
public class TarTest {
    public static void main(String[] a) throws Exception {
        File tgz = new File(a[0]); Path ours = Path.of(a[1]), ref = Path.of(a[2]);
        long t0 = System.currentTimeMillis();
        int n = com.pocketagent.TarAccess.extract(tgz, ours.toFile());
        System.out.println("extracted " + n + " entries in " + (System.currentTimeMillis() - t0) + " ms");
        int checked = 0, bad = 0;
        Set<String> seen = new HashSet<>();
        try (Stream<Path> s = Files.walk(ref)) {
            for (Path r : (Iterable<Path>) s::iterator) {
                String rel = ref.relativize(r).toString();
                if (rel.isEmpty()) continue;
                seen.add(rel);
                Path o = ours.resolve(rel);
                String why = compare(r, o);
                checked++;
                if (why != null) { bad++; if (bad <= 15) System.out.println("DIFF " + rel + ": " + why); }
            }
        }
        try (Stream<Path> s = Files.walk(ours)) {
            for (Path o : (Iterable<Path>) s::iterator) {
                String rel = ours.relativize(o).toString();
                if (!rel.isEmpty() && !seen.contains(rel)) { bad++; if (bad <= 15) System.out.println("EXTRA " + rel); }
            }
        }
        System.out.println((bad == 0 ? "PASS" : "FAIL") + " tar extraction matches GNU tar (" + checked + " paths, " + bad + " differences)");
        System.exit(bad == 0 ? 0 : 1);
    }

    static String compare(Path r, Path o) throws Exception {
        boolean rl = Files.isSymbolicLink(r), ol = Files.isSymbolicLink(o);
        if (rl != ol) return "symlink " + rl + " vs " + ol;
        if (rl) { String rt = Files.readSymbolicLink(r).toString(), ot = Files.readSymbolicLink(o).toString(); return rt.equals(ot) ? null : "link " + rt + " vs " + ot; }
        if (!Files.exists(o, LinkOption.NOFOLLOW_LINKS)) return "missing";
        boolean rd = Files.isDirectory(r, LinkOption.NOFOLLOW_LINKS), od = Files.isDirectory(o, LinkOption.NOFOLLOW_LINKS);
        if (rd != od) return "dir " + rd + " vs " + od;
        Set<PosixFilePermission> rp = Files.getPosixFilePermissions(r, LinkOption.NOFOLLOW_LINKS), op = Files.getPosixFilePermissions(o, LinkOption.NOFOLLOW_LINKS);
        if (!rp.equals(op)) return "mode " + rp + " vs " + op;
        if (!rd && !sha(r).equals(sha(o))) return "content";
        return null;
    }
    static String sha(Path p) throws Exception { return new java.math.BigInteger(1, MessageDigest.getInstance("SHA-256").digest(Files.readAllBytes(p))).toString(16); }
}

package com.pocketagent;

import java.io.BufferedInputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import java.util.zip.GZIPInputStream;

/**
 * Minimal .tar.gz extractor (files, dirs, symlinks, hard links, modes, GNU long names, pax paths).
 * Plain Java with the two OS calls behind {@link Fs}, so it's tested on a desktop JVM
 * (tests/native/TarTest.java) against the real Alpine archive.
 */
final class Tar {
    interface Fs {
        void symlink(String target, String path) throws Exception;
        void chmod(String path, int mode) throws Exception;
    }

    private Tar() {}

    static int extractGz(File tgz, File dest, Fs fs) throws Exception {
        try (InputStream in = new BufferedInputStream(new GZIPInputStream(new FileInputStream(tgz), 65536))) { return extract(in, dest, fs); }
    }

    /** Returns the number of entries written. */
    static int extract(InputStream in, File dest, Fs fs) throws Exception {
        String root = dest.getCanonicalPath();
        byte[] hdr = new byte[512];
        String longName = null, longLink = null;
        int count = 0;
        while (true) {
            if (readFully(in, hdr) < 512) break;
            boolean empty = true; for (byte b : hdr) if (b != 0) { empty = false; break; }
            if (empty) break;
            String name = str(hdr, 0, 100), prefix = str(hdr, 345, 155), link = str(hdr, 157, 100);
            if (!prefix.isEmpty()) name = prefix + "/" + name;
            int mode = (int) octal(hdr, 100, 8);
            long size = octal(hdr, 124, 12);
            char type = (char) hdr[156];
            if (type == 'L' || type == 'K' || type == 'x' || type == 'g') {
                byte[] data = new byte[(int) size]; readFully(in, data); skip(in, pad(size));
                String s = new String(data, StandardCharsets.UTF_8);
                if (type == 'L') longName = s.replace("\0", "");
                else if (type == 'K') longLink = s.replace("\0", "");
                else if (type == 'x') {
                    Matcher pm = Pattern.compile("\\d+ path=([^\n]*)\n").matcher(s); if (pm.find()) longName = pm.group(1);
                    Matcher lm = Pattern.compile("\\d+ linkpath=([^\n]*)\n").matcher(s); if (lm.find()) longLink = lm.group(1);
                }
                continue;
            }
            if (longName != null) { name = longName; longName = null; }
            if (longLink != null) { link = longLink; longLink = null; }
            while (name.startsWith("./")) name = name.substring(2);
            if (name.isEmpty() || name.equals(".")) { skip(in, size + pad(size)); continue; }
            File out = new File(dest, name);
            // refuse paths escaping the destination (e.g. "../")
            String parentPath = out.getParentFile().getCanonicalPath();
            if (!(parentPath + "/").startsWith(root + "/")) { skip(in, size + pad(size)); continue; }
            switch (type) {
                case '5':
                    out.mkdirs(); fs.chmod(out.getPath(), mode & 07777);
                    skip(in, size + pad(size)); break;
                case '2':
                    out.getParentFile().mkdirs(); out.delete();
                    fs.symlink(link, out.getPath());
                    skip(in, size + pad(size)); break;
                case '1': {
                    out.getParentFile().mkdirs();
                    String l = link; while (l.startsWith("./")) l = l.substring(2);
                    copy(new File(dest, l), out); fs.chmod(out.getPath(), mode & 07777);
                    skip(in, size + pad(size)); break;
                }
                case '0': case '\0': case '7': {
                    out.getParentFile().mkdirs(); out.delete();
                    try (OutputStream o = new FileOutputStream(out)) {
                        byte[] buf = new byte[65536]; long left = size;
                        while (left > 0) { int n = in.read(buf, 0, (int) Math.min(buf.length, left)); if (n < 0) throw new IOException("Truncated archive"); o.write(buf, 0, n); left -= n; }
                    }
                    skip(in, pad(size)); fs.chmod(out.getPath(), mode & 07777);
                    break;
                }
                default: skip(in, size + pad(size));   // devices, fifos: not needed
            }
            count++;
        }
        return count;
    }

    private static long pad(long size) { return (512 - size % 512) % 512; }
    private static String str(byte[] b, int off, int len) { int e = off; while (e < off + len && b[e] != 0) e++; return new String(b, off, e - off, StandardCharsets.UTF_8); }
    private static long octal(byte[] b, int off, int len) { String s = str(b, off, len).trim(); return s.isEmpty() ? 0 : Long.parseLong(s, 8); }
    private static int readFully(InputStream in, byte[] b) throws IOException { int n = 0; while (n < b.length) { int r = in.read(b, n, b.length - n); if (r < 0) break; n += r; } return n; }
    private static void skip(InputStream in, long n) throws IOException { while (n > 0) { long s = in.skip(n); if (s <= 0) { if (in.read() < 0) return; s = 1; } n -= s; } }
    private static void copy(File a, File b) throws IOException { try (InputStream in = new FileInputStream(a); OutputStream o = new FileOutputStream(b)) { byte[] buf = new byte[65536]; int n; while ((n = in.read(buf)) > 0) o.write(buf, 0, n); } }
}

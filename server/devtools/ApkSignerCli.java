import com.android.apksig.ApkSigner;
import com.android.apksig.ApkVerifier;

import java.io.File;
import java.io.FileInputStream;
import java.security.KeyStore;
import java.security.MessageDigest;
import java.security.PrivateKey;
import java.security.cert.X509Certificate;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;

/**
 * Minimal `apksigner` built on Google's apksig library (Maven: com.android.tools.build:apksig),
 * so APKs can be signed without the Android SDK or Termux. Supports what build.sh uses:
 *
 *   sign --ks KEYSTORE [--ks-key-alias A] --ks-pass pass:P [--key-pass pass:K] --out OUT IN
 *   verify [--print-certs] APK
 *   --version
 *
 * Signs with v1 + v2 + v3 schemes (Android decides which to use per device).
 */
public class ApkSignerCli {
    public static void main(String[] a) throws Exception {
        if (a.length == 0 || a[0].equals("--version")) { System.out.println("pocket-agent apksigner (apksig)"); return; }
        if (a[0].equals("sign")) sign(a); else if (a[0].equals("verify")) verify(a);
        else { System.err.println("usage: sign|verify|--version"); System.exit(2); }
    }

    static String opt(String[] a, String name, String dflt) {
        for (int i = 1; i < a.length - 1; i++) if (a[i].equals(name)) return a[i + 1];
        return dflt;
    }
    static String pass(String v) { return v == null ? null : v.startsWith("pass:") ? v.substring(5) : v; }

    static void sign(String[] a) throws Exception {
        String ksPath = opt(a, "--ks", null), out = opt(a, "--out", null), in = a[a.length - 1];
        String ksPass = pass(opt(a, "--ks-pass", null)), keyPass = pass(opt(a, "--key-pass", null)), alias = opt(a, "--ks-key-alias", null);
        if (ksPath == null || out == null || ksPass == null) { System.err.println("sign needs --ks, --ks-pass and --out"); System.exit(2); }
        KeyStore ks = load(ksPath, ksPass.toCharArray());
        if (alias == null) alias = Collections.list(ks.aliases()).stream().filter(x -> { try { return ks.isKeyEntry(x); } catch (Exception e) { return false; } }).findFirst().orElseThrow();
        PrivateKey key = (PrivateKey) ks.getKey(alias, (keyPass != null ? keyPass : ksPass).toCharArray());
        List<X509Certificate> chain = new ArrayList<>();
        for (java.security.cert.Certificate c : ks.getCertificateChain(alias)) chain.add((X509Certificate) c);
        ApkSigner.SignerConfig sc = new ApkSigner.SignerConfig.Builder(alias, key, chain).build();
        new ApkSigner.Builder(List.of(sc)).setInputApk(new File(in)).setOutputApk(new File(out))
            .setV1SigningEnabled(true).setV2SigningEnabled(true).setV3SigningEnabled(true).build().sign();
    }

    static KeyStore load(String path, char[] pass) throws Exception {
        for (String type : new String[]{"PKCS12", "JKS"}) {
            try (FileInputStream f = new FileInputStream(path)) { KeyStore ks = KeyStore.getInstance(type); ks.load(f, pass); return ks; }
            catch (Exception ignored) {}
        }
        throw new Exception("Can't open keystore " + path + " (wrong password?)");
    }

    static void verify(String[] a) throws Exception {
        boolean certs = false; for (String s : a) if (s.equals("--print-certs")) certs = true;
        ApkVerifier.Result r = new ApkVerifier.Builder(new File(a[a.length - 1])).build().verify();
        if (!r.isVerified()) { for (var e : r.getErrors()) System.err.println("ERROR: " + e); System.exit(1); }
        if (certs) for (X509Certificate c : r.getSignerCertificates()) {
            System.out.println("Signer: certificate DN: " + c.getSubjectX500Principal().getName());
            byte[] d = MessageDigest.getInstance("SHA-256").digest(c.getEncoded());
            StringBuilder sb = new StringBuilder(); for (byte b : d) sb.append(String.format("%02x", b));
            System.out.println("Signer: certificate SHA-256 digest: " + sb);
        }
        System.out.println("Verified (v1 " + r.isVerifiedUsingV1Scheme() + ", v2 " + r.isVerifiedUsingV2Scheme() + ", v3 " + r.isVerifiedUsingV3Scheme() + ")");
    }
}

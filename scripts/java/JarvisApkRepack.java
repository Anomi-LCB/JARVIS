import com.android.apksig.ApkSigner;
import com.android.apksig.ApkVerifier;
import com.android.zipflinger.Entry;
import com.android.zipflinger.FullFileSource;
import com.android.zipflinger.ZipArchive;
import com.android.zipflinger.ZipSource;

import java.io.InputStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.Key;
import java.security.KeyStore;
import java.security.PrivateKey;
import java.security.cert.X509Certificate;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeSet;
import java.util.zip.Deflater;

public final class JarvisApkRepack {
  private static final long NATIVE_LIBRARY_ALIGNMENT = 16 * 1024L;
  private static final long RESOURCE_TABLE_ALIGNMENT = 4L;

  private JarvisApkRepack() {}

  public static void main(String[] args) throws Exception {
    if (args.length != 5) {
      throw new IllegalArgumentException(
          "usage: <input-apk> <arm64-lib-dir> <unsigned-apk> <signed-apk> <debug-keystore>");
    }

    Path inputApk = Path.of(args[0]).toAbsolutePath().normalize();
    Path arm64LibDir = Path.of(args[1]).toAbsolutePath().normalize();
    Path unsignedApk = Path.of(args[2]).toAbsolutePath().normalize();
    Path signedApk = Path.of(args[3]).toAbsolutePath().normalize();
    Path debugKeystore = Path.of(args[4]).toAbsolutePath().normalize();

    Files.createDirectories(unsignedApk.getParent());
    Files.createDirectories(signedApk.getParent());
    Files.deleteIfExists(unsignedApk);
    Files.deleteIfExists(signedApk);

    Map<String, Entry> inputEntries = ZipArchive.listEntries(inputApk);
    Set<String> expectedLibraries = new TreeSet<>();
    for (String name : inputEntries.keySet()) {
      if (name.matches("lib/[^/]+/[^/]+\\.so")) {
        expectedLibraries.add(name.substring(name.lastIndexOf('/') + 1));
      }
    }
    if (expectedLibraries.isEmpty()) {
      throw new IllegalStateException("input APK contains no native libraries");
    }

    List<Path> arm64Libraries = new ArrayList<>();
    for (String libraryName : expectedLibraries) {
      Path library = arm64LibDir.resolve(libraryName);
      if (!Files.isRegularFile(library)) {
        throw new IllegalStateException("missing ARM64 library: " + libraryName);
      }
      arm64Libraries.add(library);
    }
    arm64Libraries.sort(Comparator.comparing(path -> path.getFileName().toString()));

    try (ZipArchive output = new ZipArchive(unsignedApk)) {
      ZipSource originalEntries = new ZipSource(inputApk);
      for (Map.Entry<String, Entry> item : inputEntries.entrySet()) {
        String name = item.getKey();
        if (name.startsWith("lib/") || isV1SignatureEntry(name)) continue;
        long alignment = item.getValue().isCompressed() ? 0L : RESOURCE_TABLE_ALIGNMENT;
        originalEntries.select(name, name, ZipSource.COMPRESSION_NO_CHANGE, alignment);
      }
      output.add(originalEntries);
      for (Path library : arm64Libraries) {
        String entryName = "lib/arm64-v8a/" + library.getFileName();
        FullFileSource source = new FullFileSource(
            library,
            entryName,
            Deflater.NO_COMPRESSION);
        source.align(NATIVE_LIBRARY_ALIGNMENT);
        output.add(source);
      }
    }

    ApkSigner.SignerConfig signerConfig = loadDebugSigner(debugKeystore);
    new ApkSigner.Builder(List.of(signerConfig))
        .setInputApk(unsignedApk.toFile())
        .setOutputApk(signedApk.toFile())
        .setMinSdkVersion(24)
        .setV1SigningEnabled(true)
        .setV2SigningEnabled(true)
        .setV3SigningEnabled(true)
        .setV4SigningEnabled(false)
        .setAlignmentPreserved(true)
        .setLibraryPageAlignmentBytes((int) NATIVE_LIBRARY_ALIGNMENT)
        .setCreatedBy("JARVIS mobile device harness")
        .build()
        .sign();

    ApkVerifier.Result verification = new ApkVerifier.Builder(signedApk.toFile())
        .setMinCheckedPlatformVersion(24)
        .build()
        .verify();
    if (!verification.isVerified()) {
      throw new IllegalStateException("APK signature verification failed: " + verification.getAllErrors());
    }

    Map<String, Entry> signedEntries = ZipArchive.listEntries(signedApk);
    Entry resources = signedEntries.get("resources.arsc");
    if (resources == null || resources.isCompressed()) {
      throw new IllegalStateException("resources.arsc must be stored without compression");
    }
    if (resources.getPayloadLocation().first % RESOURCE_TABLE_ALIGNMENT != 0) {
      throw new IllegalStateException("resources.arsc must be aligned on a 4-byte boundary");
    }
    Entry jsBundle = signedEntries.get("assets/index.android.bundle");
    if (jsBundle == null || jsBundle.isCompressed()) {
      throw new IllegalStateException("Hermes bundle must be stored without compression");
    }
    if (jsBundle.getPayloadLocation().first % RESOURCE_TABLE_ALIGNMENT != 0) {
      throw new IllegalStateException("Hermes bundle must be aligned on a 4-byte boundary");
    }
    int alignedUncompressedEntries = 0;
    for (Entry entry : signedEntries.values()) {
      if (entry.isDirectory() || entry.isCompressed() || entry.getName().startsWith("lib/")) continue;
      if (entry.getPayloadLocation().first % RESOURCE_TABLE_ALIGNMENT != 0) {
        throw new IllegalStateException("unaligned uncompressed APK entry: " + entry.getName());
      }
      alignedUncompressedEntries += 1;
    }
    int alignedLibraries = 0;
    for (String libraryName : expectedLibraries) {
      String entryName = "lib/arm64-v8a/" + libraryName;
      Entry entry = signedEntries.get(entryName);
      if (entry == null || entry.isCompressed()) {
        throw new IllegalStateException("invalid native library entry: " + entryName);
      }
      if (entry.getPayloadLocation().first % NATIVE_LIBRARY_ALIGNMENT != 0) {
        throw new IllegalStateException("unaligned native library entry: " + entryName);
      }
      alignedLibraries += 1;
    }

    System.out.println("status=verified");
    System.out.println("apk=" + signedApk);
    System.out.println("abi=arm64-v8a");
    System.out.println("nativeLibraries=" + alignedLibraries);
    System.out.println("resourcesArscAligned=true");
    System.out.println("hermesBundleAligned=true");
    System.out.println("alignedUncompressedEntries=" + alignedUncompressedEntries);
    System.out.println("v1=" + verification.isVerifiedUsingV1Scheme());
    System.out.println("v2=" + verification.isVerifiedUsingV2Scheme());
    System.out.println("v3=" + verification.isVerifiedUsingV3Scheme());
  }

  private static boolean isV1SignatureEntry(String name) {
    String upper = name.toUpperCase();
    return upper.startsWith("META-INF/")
        && (upper.endsWith(".SF")
            || upper.endsWith(".RSA")
            || upper.endsWith(".DSA")
            || upper.endsWith(".EC"));
  }

  private static ApkSigner.SignerConfig loadDebugSigner(Path keystorePath) throws Exception {
    char[] password = "android".toCharArray();
    KeyStore keyStore = KeyStore.getInstance("JKS");
    try (InputStream input = Files.newInputStream(keystorePath)) {
      keyStore.load(input, password);
    }

    String alias = "androiddebugkey";
    Key key = keyStore.getKey(alias, password);
    if (!(key instanceof PrivateKey)) {
      throw new IllegalStateException("debug keystore private key is unavailable");
    }
    X509Certificate certificate = (X509Certificate) keyStore.getCertificate(alias);
    return new ApkSigner.SignerConfig.Builder(
        "JARVIS Debug",
        (PrivateKey) key,
        List.of(certificate))
        .build();
  }
}

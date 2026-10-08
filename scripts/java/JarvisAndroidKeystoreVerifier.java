import java.io.FileInputStream;
import java.security.Key;
import java.security.KeyStore;
import java.security.PrivateKey;
import java.security.interfaces.ECKey;
import java.security.interfaces.RSAKey;
import java.security.cert.Certificate;
import java.security.cert.X509Certificate;
import java.time.Duration;
import java.time.Instant;
import java.util.Arrays;

public final class JarvisAndroidKeystoreVerifier {
  private static String required(String name) {
    String value = System.getenv(name);
    if (value == null || value.trim().isEmpty()) throw new IllegalArgumentException("missing-environment");
    return value;
  }

  private static KeyStore load(String path, char[] password) throws Exception {
    Exception last = null;
    for (String type : new String[] { "PKCS12", "JKS" }) {
      try (FileInputStream input = new FileInputStream(path)) {
        KeyStore store = KeyStore.getInstance(type);
        store.load(input, password);
        return store;
      } catch (Exception error) {
        last = error;
      }
    }
    throw last == null ? new IllegalStateException("keystore-load-failed") : last;
  }

  private static int keyBits(Key key) {
    if (key instanceof RSAKey) return ((RSAKey) key).getModulus().bitLength();
    if (key instanceof ECKey) return ((ECKey) key).getParams().getOrder().bitLength();
    return 0;
  }

  private static void output(boolean passed, boolean storeOpened, boolean aliasFound,
      boolean privateKeyPresent, boolean certificatePresent, boolean certificateValid,
      boolean keyStrengthAccepted, int keyBits, long certificateDaysRemaining) {
    System.out.println("{"
      + "\"status\":\"" + (passed ? "passed" : "failed") + "\","
      + "\"storeOpened\":" + storeOpened + ","
      + "\"aliasFound\":" + aliasFound + ","
      + "\"privateKeyPresent\":" + privateKeyPresent + ","
      + "\"certificatePresent\":" + certificatePresent + ","
      + "\"certificateValid\":" + certificateValid + ","
      + "\"keyStrengthAccepted\":" + keyStrengthAccepted + ","
      + "\"keyBits\":" + keyBits + ","
      + "\"certificateDaysRemaining\":" + certificateDaysRemaining + ","
      + "\"secretValuesStored\":false"
      + "}");
  }

  public static void main(String[] args) {
    char[] storePassword = null;
    char[] keyPassword = null;
    try {
      String path = required("JARVIS_ANDROID_KEYSTORE_PATH");
      String alias = required("JARVIS_ANDROID_KEY_ALIAS");
      storePassword = required("JARVIS_ANDROID_KEYSTORE_PASSWORD").toCharArray();
      keyPassword = required("JARVIS_ANDROID_KEY_PASSWORD").toCharArray();
      KeyStore store = load(path, storePassword);
      boolean aliasFound = store.containsAlias(alias);
      Key key = aliasFound ? store.getKey(alias, keyPassword) : null;
      Certificate certificate = aliasFound ? store.getCertificate(alias) : null;
      boolean privateKeyPresent = key instanceof PrivateKey;
      boolean certificatePresent = certificate instanceof X509Certificate;
      boolean certificateValid = false;
      long daysRemaining = -1;
      if (certificatePresent) {
        X509Certificate x509 = (X509Certificate) certificate;
        x509.checkValidity();
        certificateValid = true;
        daysRemaining = Duration.between(Instant.now(), x509.getNotAfter().toInstant()).toDays();
      }
      int bits = keyBits(key);
      boolean strengthAccepted = (key != null && "RSA".equalsIgnoreCase(key.getAlgorithm()) && bits >= 2048)
        || (key != null && "EC".equalsIgnoreCase(key.getAlgorithm()) && bits >= 256);
      boolean passed = aliasFound && privateKeyPresent && certificatePresent && certificateValid && strengthAccepted;
      output(passed, true, aliasFound, privateKeyPresent, certificatePresent, certificateValid,
        strengthAccepted, bits, daysRemaining);
      if (!passed) System.exit(2);
    } catch (Exception error) {
      output(false, false, false, false, false, false, false, 0, -1);
      System.exit(2);
    } finally {
      if (storePassword != null) Arrays.fill(storePassword, '\0');
      if (keyPassword != null) Arrays.fill(keyPassword, '\0');
    }
  }
}

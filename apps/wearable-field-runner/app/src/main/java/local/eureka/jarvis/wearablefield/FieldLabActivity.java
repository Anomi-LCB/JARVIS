package local.eureka.jarvis.wearablefield;

import android.Manifest;
import android.app.Activity;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.view.KeyEvent;
import android.view.View;
import android.view.Window;
import android.view.WindowInsets;
import android.view.WindowInsetsController;
import android.view.WindowManager;
import android.webkit.CookieManager;
import android.webkit.PermissionRequest;
import android.webkit.SslErrorHandler;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.net.http.SslError;

import java.io.IOException;
import java.util.Locale;

public final class FieldLabActivity extends Activity {
  private static final int AUDIO_PERMISSION_REQUEST = 4107;
  private static final int FIELD_PORT = 4176;
  private static final String URL_EXTRA = "url";

  private WebView webView;
  private PermissionRequest pendingAudioRequest;
  private NativeAudioLoopbackServer nativeAudioServer;
  private boolean nativeAudioReady;
  private boolean audioPermissionRequestInFlight;

  @Override
  protected void onCreate(Bundle savedInstanceState) {
    super.onCreate(savedInstanceState);
    requestWindowFeature(Window.FEATURE_NO_TITLE);
    getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);

    startNativeAudioServer();
    webView = new WebView(this);
    webView.setBackgroundColor(Color.rgb(0, 4, 0));
    configureWebView(webView);
    setContentView(webView);
    enterImmersiveMode();
    loadRequestedUrl(getIntent());
    ensureAudioPermission();
  }

  @Override
  protected void onNewIntent(Intent intent) {
    super.onNewIntent(intent);
    setIntent(intent);
    loadRequestedUrl(intent);
  }

  private void configureWebView(WebView view) {
    WebView.setWebContentsDebuggingEnabled(false);
    WebSettings settings = view.getSettings();
    settings.setJavaScriptEnabled(true);
    settings.setDomStorageEnabled(true);
    settings.setAllowFileAccess(false);
    settings.setAllowContentAccess(false);
    settings.setJavaScriptCanOpenWindowsAutomatically(false);
    settings.setSupportMultipleWindows(false);
    settings.setGeolocationEnabled(false);
    settings.setMediaPlaybackRequiresUserGesture(true);
    settings.setCacheMode(WebSettings.LOAD_NO_CACHE);
    settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
    String runnerAgent = " JARVIS-Wearable-Field/1.1";
    if (nativeAudioReady) runnerAgent += " JARVIS-Native-Audio/1.0";
    settings.setUserAgentString(settings.getUserAgentString() + runnerAgent);

    CookieManager cookies = CookieManager.getInstance();
    cookies.setAcceptCookie(false);
    cookies.setAcceptThirdPartyCookies(view, false);

    view.setWebViewClient(new FieldWebViewClient());
    view.setWebChromeClient(new FieldWebChromeClient());
  }

  private void loadRequestedUrl(Intent intent) {
    String requested = intent == null ? null : intent.getStringExtra(URL_EXTRA);
    if ((requested == null || requested.trim().isEmpty()) && intent != null && intent.getData() != null) {
      requested = translateCustomUri(intent.getData());
    }
    String target = isAllowedFieldUrl(requested) ? requested : BuildConfig.DEFAULT_FIELD_URL;
    webView.loadUrl(target);
  }

  private String translateCustomUri(Uri uri) {
    if (uri == null || !"jarvis-field".equalsIgnoreCase(uri.getScheme())) return null;
    String path = uri.getQueryParameter("path");
    if (path == null || path.trim().isEmpty()) path = "/field-calibration.html";
    if (!path.startsWith("/") || path.contains("..")) return null;
    return "http://127.0.0.1:" + FIELD_PORT + path;
  }

  private boolean isAllowedFieldUrl(String value) {
    if (value == null) return false;
    try {
      Uri uri = Uri.parse(value);
      String host = uri.getHost();
      boolean loopback = "127.0.0.1".equals(host) || "localhost".equalsIgnoreCase(host);
      int port = uri.getPort() == -1 ? 80 : uri.getPort();
      return "http".equalsIgnoreCase(uri.getScheme()) && loopback && port == FIELD_PORT;
    } catch (RuntimeException ignored) {
      return false;
    }
  }

  private boolean isAllowedAudioOrigin(Uri origin) {
    if (origin == null) return false;
    String host = origin.getHost();
    boolean loopback = "127.0.0.1".equals(host) || "localhost".equalsIgnoreCase(host);
    int port = origin.getPort() == -1 ? 80 : origin.getPort();
    return "http".equalsIgnoreCase(origin.getScheme()) && loopback && port == FIELD_PORT;
  }

  private boolean requestsOnlyAudio(PermissionRequest request) {
    String[] resources = request == null ? null : request.getResources();
    if (resources == null || resources.length == 0) return false;
    for (String resource : resources) {
      if (!PermissionRequest.RESOURCE_AUDIO_CAPTURE.equals(resource)) return false;
    }
    return true;
  }

  private void grantOrRequestAudio(PermissionRequest request) {
    if (!isAllowedAudioOrigin(request.getOrigin()) || !requestsOnlyAudio(request)) {
      request.deny();
      return;
    }
    if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) {
      request.grant(new String[]{PermissionRequest.RESOURCE_AUDIO_CAPTURE});
      return;
    }
    pendingAudioRequest = request;
    ensureAudioPermission();
  }

  private void ensureAudioPermission() {
    if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED
      || audioPermissionRequestInFlight) return;
    audioPermissionRequestInFlight = true;
    requestPermissions(new String[]{Manifest.permission.RECORD_AUDIO}, AUDIO_PERMISSION_REQUEST);
  }

  private void startNativeAudioServer() {
    NativeAudioLoopbackServer server = new NativeAudioLoopbackServer(this);
    try {
      server.start();
      nativeAudioServer = server;
      nativeAudioReady = true;
    } catch (IOException ignored) {
      server.close();
      nativeAudioServer = null;
      nativeAudioReady = false;
    }
  }

  @Override
  public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
    super.onRequestPermissionsResult(requestCode, permissions, grantResults);
    if (requestCode != AUDIO_PERMISSION_REQUEST) return;
    audioPermissionRequestInFlight = false;
    if (pendingAudioRequest == null) return;
    PermissionRequest request = pendingAudioRequest;
    pendingAudioRequest = null;
    if (grantResults.length > 0 && grantResults[0] == PackageManager.PERMISSION_GRANTED) {
      request.grant(new String[]{PermissionRequest.RESOURCE_AUDIO_CAPTURE});
    } else {
      request.deny();
    }
  }

  private void enterImmersiveMode() {
    View decorView = getWindow().getDecorView();
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
      WindowInsetsController controller = decorView.getWindowInsetsController();
      if (controller != null) {
        controller.hide(WindowInsets.Type.statusBars() | WindowInsets.Type.navigationBars());
        controller.setSystemBarsBehavior(WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
      }
      return;
    }
    decorView.setSystemUiVisibility(
      View.SYSTEM_UI_FLAG_FULLSCREEN
        | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
        | View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
        | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
        | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
        | View.SYSTEM_UI_FLAG_LAYOUT_STABLE
    );
  }

  private void renderLoadFailure(String code) {
    String safeCode = code == null ? "FIELD_LOAD_FAILED" : code.replaceAll("[^A-Z0-9_.:-]", "_");
    String html = "<!doctype html><meta name=viewport content='width=device-width,initial-scale=1'>"
      + "<style>html,body{margin:0;background:#000400;color:#00ff66;font:16px sans-serif}"
      + "main{padding:24px}small{color:#37a86b}</style><main><b>JARVIS FIELD LINK</b>"
      + "<p>LOCAL FIELD SERVER UNAVAILABLE</p><small>" + safeCode + "</small></main>";
    webView.loadDataWithBaseURL(null, html, "text/html", "UTF-8", null);
  }

  @Override
  public boolean onKeyDown(int keyCode, KeyEvent event) {
    if (keyCode == KeyEvent.KEYCODE_BACK && webView != null && webView.canGoBack()) {
      webView.goBack();
      return true;
    }
    return super.onKeyDown(keyCode, event);
  }

  @Override
  protected void onResume() {
    super.onResume();
    enterImmersiveMode();
    if (webView != null) webView.onResume();
  }

  @Override
  protected void onPause() {
    if (webView != null) webView.onPause();
    super.onPause();
  }

  @Override
  protected void onDestroy() {
    if (pendingAudioRequest != null) pendingAudioRequest.deny();
    pendingAudioRequest = null;
    if (nativeAudioServer != null) nativeAudioServer.close();
    nativeAudioServer = null;
    nativeAudioReady = false;
    if (webView != null) {
      webView.stopLoading();
      webView.loadUrl("about:blank");
      webView.clearHistory();
      webView.removeAllViews();
      webView.destroy();
      webView = null;
    }
    super.onDestroy();
  }

  private final class FieldWebChromeClient extends WebChromeClient {
    @Override
    public void onPermissionRequest(PermissionRequest request) {
      runOnUiThread(() -> grantOrRequestAudio(request));
    }

    @Override
    public void onPermissionRequestCanceled(PermissionRequest request) {
      if (pendingAudioRequest == request) pendingAudioRequest = null;
    }
  }

  private final class FieldWebViewClient extends WebViewClient {
    @Override
    public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
      return !isAllowedFieldUrl(request.getUrl().toString());
    }

    @Override
    @SuppressWarnings("deprecation")
    public boolean shouldOverrideUrlLoading(WebView view, String url) {
      return !isAllowedFieldUrl(url);
    }

    @Override
    public void onReceivedSslError(WebView view, SslErrorHandler handler, SslError error) {
      handler.cancel();
    }

    @Override
    public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
      if (request.isForMainFrame()) renderLoadFailure("HTTP_LOAD_ERROR");
    }

    @Override
    public void onReceivedHttpError(WebView view, WebResourceRequest request, WebResourceResponse response) {
      if (request.isForMainFrame() && response.getStatusCode() >= 400) {
        renderLoadFailure(String.format(Locale.ROOT, "HTTP_%d", response.getStatusCode()));
      }
    }
  }
}

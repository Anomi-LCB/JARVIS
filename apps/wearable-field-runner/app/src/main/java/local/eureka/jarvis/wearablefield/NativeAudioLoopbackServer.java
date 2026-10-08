package local.eureka.jarvis.wearablefield;

import android.Manifest;
import android.content.Context;
import android.content.pm.PackageManager;
import android.media.AudioFormat;
import android.media.AudioManager;
import android.media.AudioRecord;
import android.media.MediaRecorder;
import android.media.ToneGenerator;
import android.os.Build;

import java.io.ByteArrayOutputStream;
import java.io.Closeable;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.net.SocketException;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.ThreadFactory;
import java.util.concurrent.atomic.AtomicBoolean;

final class NativeAudioLoopbackServer implements Closeable {
  static final int PORT = 4186;

  private static final int SAMPLE_RATE_HZ = 16000;
  private static final int MIN_CAPTURE_MS = 500;
  private static final int MAX_CAPTURE_MS = 8000;
  private static final int SOURCE_PROBE_MS = 350;
  private static final int CAPTURE_CUE_MS = 180;
  private static final int CAPTURE_CUE_SETTLE_MS = 320;
  private static final int ROKID_AUDIO_CHANNEL_MASK = 0x3c;
  private static final int ROKID_VIDEO_CHANNEL_MASK = 0x6000fc;
  private static final int MAX_HEADER_BYTES = 8192;
  private static final String PRIMARY_ORIGIN = "http://127.0.0.1:4176";
  private static final String SECONDARY_ORIGIN = "http://localhost:4176";

  private final Context context;
  private final AtomicBoolean running = new AtomicBoolean(false);
  private final AtomicBoolean recording = new AtomicBoolean(false);
  private final ExecutorService clients = Executors.newFixedThreadPool(2, new NamedThreadFactory());
  private ServerSocket serverSocket;
  private Thread acceptThread;
  private volatile AudioRoute selectedAudioRoute;

  NativeAudioLoopbackServer(Context context) {
    this.context = context.getApplicationContext();
  }

  synchronized void start() throws IOException {
    if (running.get()) return;
    ServerSocket socket = new ServerSocket();
    socket.setReuseAddress(true);
    socket.bind(new InetSocketAddress(InetAddress.getByName("127.0.0.1"), PORT), 4);
    serverSocket = socket;
    running.set(true);
    acceptThread = new Thread(this::acceptLoop, "jarvis-native-audio-accept");
    acceptThread.setDaemon(true);
    acceptThread.start();
  }

  private void acceptLoop() {
    while (running.get()) {
      try {
        Socket socket = serverSocket.accept();
        if (!socket.getInetAddress().isLoopbackAddress()) {
          socket.close();
          continue;
        }
        clients.execute(() -> handle(socket));
      } catch (SocketException error) {
        if (running.get()) {
          running.set(false);
          closeQuietly();
        }
      } catch (IOException error) {
        if (running.get()) {
          running.set(false);
          closeQuietly();
        }
      }
    }
  }

  private void handle(Socket socket) {
    try (Socket client = socket) {
      client.setSoTimeout(MAX_CAPTURE_MS + 5000);
      HttpRequest request = readRequest(client.getInputStream());
      String origin = request.headers.get("origin");
      if (origin != null && !isAllowedOrigin(origin)) {
        writeJson(client.getOutputStream(), 403, "Forbidden", "{\"error\":\"origin_not_allowed\"}", null);
        return;
      }
      if ("OPTIONS".equals(request.method)) {
        writeResponse(client.getOutputStream(), 204, "No Content", "text/plain", new byte[0], origin, null);
        return;
      }
      if ("GET".equals(request.method) && "/health".equals(request.path)) {
        AudioRoute selectedRoute = selectedAudioRoute;
        String body = String.format(Locale.ROOT,
          "{\"status\":\"ready\",\"audioCapture\":\"android-native\",\"captureCue\":\"device-tone\",\"recording\":%s,\"selectedSource\":%s,\"rawAudioStored\":false}",
          recording.get() ? "true" : "false",
          selectedRoute == null ? "null" : "\"" + selectedRoute.name + "\"");
        writeJson(client.getOutputStream(), 200, "OK", body, origin);
        return;
      }
      if ("POST".equals(request.method) && "/audio/capture".equals(request.path)) {
        handleCapture(client.getOutputStream(), request, origin);
        return;
      }
      writeJson(client.getOutputStream(), 404, "Not Found", "{\"error\":\"not_found\"}", origin);
    } catch (Exception ignored) {
      // The browser may close a request when the user leaves the field page.
    }
  }

  private void handleCapture(OutputStream output, HttpRequest request, String origin) throws IOException {
    if (context.checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
      writeJson(output, 403, "Forbidden", "{\"error\":\"microphone_permission_required\"}", origin);
      return;
    }
    if (!recording.compareAndSet(false, true)) {
      writeJson(output, 409, "Conflict", "{\"error\":\"capture_in_progress\"}", origin);
      return;
    }
    try {
      int durationMs = clamp(parseInteger(request.query.get("durationMs"), 3500), MIN_CAPTURE_MS, MAX_CAPTURE_MS);
      boolean cueRequested = parseBoolean(request.query.get("cue"));
      CapturedAudio capture = capturePcm(durationMs, cueRequested);
      Map<String, String> headers = new HashMap<>();
      headers.put("X-Jarvis-Audio-Source", capture.sourceName);
      headers.put("X-Jarvis-Sample-Rate", String.valueOf(SAMPLE_RATE_HZ));
      headers.put("X-Jarvis-Audio-Duration-Ms", String.valueOf(capture.durationMs));
      headers.put("X-Jarvis-Capture-Cue", capture.cuePlayed ? "device-tone" : "none");
      headers.put("X-Jarvis-Raw-Audio-Stored", "false");
      writeResponse(output, 200, "OK", "audio/wav", capture.wav, origin, headers);
    } catch (IllegalStateException error) {
      writeJson(output, 503, "Service Unavailable", "{\"error\":\"native_audio_capture_failed\"}", origin);
    } finally {
      recording.set(false);
    }
  }

  private CapturedAudio capturePcm(int durationMs, boolean cueRequested) {
    AudioRoute route = resolveAudioRoute();
    if (route == null) throw new IllegalStateException("audio-input-silenced");
    boolean cuePlayed = cueRequested && playCaptureCue();
    byte[] samples = captureRoute(route, durationMs);
    if (hasPhysicalSignal(samples)) return capturedAudio(samples, route, cuePlayed);

    selectedAudioRoute = null;
    AudioRoute retryRoute = resolveAudioRoute();
    if (retryRoute == null) throw new IllegalStateException("audio-input-silenced");
    boolean retryCuePlayed = cueRequested && playCaptureCue();
    samples = captureRoute(retryRoute, durationMs);
    if (hasPhysicalSignal(samples)) return capturedAudio(samples, retryRoute, cuePlayed || retryCuePlayed);
    selectedAudioRoute = null;
    throw new IllegalStateException("audio-input-silenced");
  }

  private AudioRoute resolveAudioRoute() {
    AudioRoute cachedRoute = selectedAudioRoute;
    if (cachedRoute != null) {
      byte[] probe = captureRoute(cachedRoute, SOURCE_PROBE_MS);
      if (hasPhysicalSignal(probe)) return cachedRoute;
      selectedAudioRoute = null;
    }
    AudioRoute strongestRoute = null;
    double strongestSignal = 0;
    for (AudioRoute route : candidateAudioRoutes()) {
      byte[] probe = captureRoute(route, SOURCE_PROBE_MS);
      double signal = signalStrength(probe);
      if (route.oemPreferred && hasPhysicalSignal(probe)) {
        selectedAudioRoute = route;
        return route;
      }
      if (hasPhysicalSignal(probe) && signal > strongestSignal) {
        strongestRoute = route;
        strongestSignal = signal;
      }
    }
    if (strongestRoute != null) {
      selectedAudioRoute = strongestRoute;
      return strongestRoute;
    }
    return null;
  }

  private static boolean playCaptureCue() {
    ToneGenerator tone = null;
    try {
      tone = new ToneGenerator(AudioManager.STREAM_MUSIC, 90);
      boolean started = tone.startTone(ToneGenerator.TONE_PROP_BEEP, CAPTURE_CUE_MS);
      Thread.sleep(CAPTURE_CUE_MS + CAPTURE_CUE_SETTLE_MS);
      return started;
    } catch (RuntimeException ignored) {
      return false;
    } catch (InterruptedException ignored) {
      Thread.currentThread().interrupt();
      return false;
    } finally {
      if (tone != null) {
        tone.stopTone();
        tone.release();
      }
    }
  }

  private byte[] captureRoute(AudioRoute route, int durationMs) {
    AudioRecord recorder = null;
    try {
      int minimumBuffer = AudioRecord.getMinBufferSize(
        SAMPLE_RATE_HZ,
        route.channelMask,
        AudioFormat.ENCODING_PCM_16BIT
      );
      if (minimumBuffer <= 0) return new byte[0];
      int bufferSize = Math.max(minimumBuffer * 2, SAMPLE_RATE_HZ * route.channelCount / 2);
      recorder = new AudioRecord(
        route.source,
        SAMPLE_RATE_HZ,
        route.channelMask,
        AudioFormat.ENCODING_PCM_16BIT,
        bufferSize
      );
      if (recorder.getState() != AudioRecord.STATE_INITIALIZED) return new byte[0];
      recorder.startRecording();
      if (recorder.getRecordingState() != AudioRecord.RECORDSTATE_RECORDING) return new byte[0];
      int targetBytes = SAMPLE_RATE_HZ * 2 * route.channelCount * durationMs / 1000;
      ByteArrayOutputStream rawPcm = new ByteArrayOutputStream(targetBytes);
      byte[] buffer = new byte[Math.min(bufferSize, 16384)];
      long deadlineNs = System.nanoTime() + (durationMs + 1000L) * 1_000_000L;
      while (rawPcm.size() < targetBytes && System.nanoTime() < deadlineNs) {
        int remaining = targetBytes - rawPcm.size();
        int count = recorder.read(buffer, 0, Math.min(buffer.length, remaining));
        if (count > 0) rawPcm.write(buffer, 0, count);
        else if (count < 0) return new byte[0];
      }
      byte[] samples = extractInputChannel(rawPcm.toByteArray(), route.channelCount, route.channelIndex);
      return samples.length >= SAMPLE_RATE_HZ / 2 ? samples : new byte[0];
    } catch (SecurityException ignored) {
      throw new IllegalStateException("microphone-permission-denied");
    } catch (IllegalArgumentException ignored) {
      return new byte[0];
    } finally {
      if (recorder != null) {
        try {
          if (recorder.getRecordingState() == AudioRecord.RECORDSTATE_RECORDING) recorder.stop();
        } catch (IllegalStateException ignored) {
          // The audio service may already have stopped the recorder.
        }
        recorder.release();
      }
    }
  }

  private static byte[] extractInputChannel(byte[] interleaved, int channelCount, int channelIndex) {
    if (channelCount <= 1) return interleaved;
    int frameSize = channelCount * 2;
    int frameCount = interleaved.length / frameSize;
    byte[] mono = new byte[frameCount * 2];
    int sourceOffset = channelIndex * 2;
    for (int frame = 0; frame < frameCount; frame += 1) {
      int inputOffset = frame * frameSize + sourceOffset;
      int outputOffset = frame * 2;
      mono[outputOffset] = interleaved[inputOffset];
      mono[outputOffset + 1] = interleaved[inputOffset + 1];
    }
    return mono;
  }

  private static CapturedAudio capturedAudio(byte[] samples, AudioRoute route, boolean cuePlayed) {
    int capturedMs = samples.length * 1000 / (SAMPLE_RATE_HZ * 2);
    return new CapturedAudio(createWav(samples), route.name, capturedMs, cuePlayed);
  }

  private static boolean hasPhysicalSignal(byte[] pcm) {
    if (pcm == null || pcm.length < 2) return false;
    int nonZeroSamples = 0;
    int meaningfulSamples = 0;
    for (int index = 0; index + 1 < pcm.length; index += 2) {
      int sample = (short) ((pcm[index] & 0xff) | (pcm[index + 1] << 8));
      if (sample != 0) nonZeroSamples += 1;
      if (Math.abs(sample) > 2) meaningfulSamples += 1;
    }
    int totalSamples = pcm.length / 2;
    return nonZeroSamples >= Math.max(8, totalSamples / 1000)
      && meaningfulSamples >= Math.max(4, totalSamples / 2000);
  }

  private static double signalStrength(byte[] pcm) {
    if (pcm == null || pcm.length < 8) return 0;
    int totalSamples = pcm.length / 2;
    int startSample = totalSamples / 4;
    double squareSum = 0;
    int measured = 0;
    for (int sampleIndex = startSample; sampleIndex < totalSamples; sampleIndex += 1) {
      int index = sampleIndex * 2;
      int sample = (short) ((pcm[index] & 0xff) | (pcm[index + 1] << 8));
      squareSum += (double) sample * sample;
      measured += 1;
    }
    return measured > 0 ? Math.sqrt(squareSum / measured) : 0;
  }

  private static AudioRoute[] candidateAudioRoutes() {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
      return new AudioRoute[]{
        new AudioRoute(MediaRecorder.AudioSource.MIC, ROKID_AUDIO_CHANNEL_MASK, 4, 3, "rokid-array-4ch-ch4", true),
        new AudioRoute(MediaRecorder.AudioSource.MIC, ROKID_VIDEO_CHANNEL_MASK, 8, 5, "rokid-array-8ch-ch6", true),
        monoRoute(MediaRecorder.AudioSource.MIC),
        monoRoute(MediaRecorder.AudioSource.VOICE_RECOGNITION),
        monoRoute(MediaRecorder.AudioSource.CAMCORDER),
        monoRoute(MediaRecorder.AudioSource.VOICE_COMMUNICATION),
        monoRoute(MediaRecorder.AudioSource.UNPROCESSED),
        monoRoute(MediaRecorder.AudioSource.DEFAULT)
      };
    }
    return new AudioRoute[]{
      new AudioRoute(MediaRecorder.AudioSource.MIC, ROKID_AUDIO_CHANNEL_MASK, 4, 3, "rokid-array-4ch-ch4", true),
      new AudioRoute(MediaRecorder.AudioSource.MIC, ROKID_VIDEO_CHANNEL_MASK, 8, 5, "rokid-array-8ch-ch6", true),
      monoRoute(MediaRecorder.AudioSource.MIC),
      monoRoute(MediaRecorder.AudioSource.VOICE_RECOGNITION),
      monoRoute(MediaRecorder.AudioSource.CAMCORDER),
      monoRoute(MediaRecorder.AudioSource.VOICE_COMMUNICATION),
      monoRoute(MediaRecorder.AudioSource.DEFAULT)
    };
  }

  private static AudioRoute monoRoute(int source) {
    return new AudioRoute(source, AudioFormat.CHANNEL_IN_MONO, 1, 0, audioSourceName(source), false);
  }

  private static byte[] createWav(byte[] pcm) {
    ByteArrayOutputStream output = new ByteArrayOutputStream(44 + pcm.length);
    writeAscii(output, "RIFF");
    writeLittleEndianInt(output, 36 + pcm.length);
    writeAscii(output, "WAVE");
    writeAscii(output, "fmt ");
    writeLittleEndianInt(output, 16);
    writeLittleEndianShort(output, 1);
    writeLittleEndianShort(output, 1);
    writeLittleEndianInt(output, SAMPLE_RATE_HZ);
    writeLittleEndianInt(output, SAMPLE_RATE_HZ * 2);
    writeLittleEndianShort(output, 2);
    writeLittleEndianShort(output, 16);
    writeAscii(output, "data");
    writeLittleEndianInt(output, pcm.length);
    output.write(pcm, 0, pcm.length);
    return output.toByteArray();
  }

  private static HttpRequest readRequest(InputStream input) throws IOException {
    int[] consumed = { 0 };
    String requestLine = readLine(input, consumed);
    String[] parts = requestLine.split(" ", 3);
    if (parts.length != 3) throw new IOException("invalid-request-line");
    Map<String, String> headers = new HashMap<>();
    while (true) {
      String line = readLine(input, consumed);
      if (line.isEmpty()) break;
      int separator = line.indexOf(':');
      if (separator <= 0) throw new IOException("invalid-header");
      headers.put(line.substring(0, separator).trim().toLowerCase(Locale.ROOT), line.substring(separator + 1).trim());
    }
    URI uri = URI.create(parts[1]);
    return new HttpRequest(parts[0].toUpperCase(Locale.ROOT), uri.getPath(), parseQuery(uri.getRawQuery()), headers);
  }

  private static String readLine(InputStream input, int[] consumed) throws IOException {
    ByteArrayOutputStream line = new ByteArrayOutputStream();
    int previous = -1;
    while (true) {
      int current = input.read();
      if (current < 0) throw new IOException("unexpected-end-of-request");
      consumed[0] += 1;
      if (consumed[0] > MAX_HEADER_BYTES) throw new IOException("request-headers-too-large");
      if (previous == '\r' && current == '\n') break;
      if (previous >= 0) line.write(previous);
      previous = current;
    }
    return line.toString(StandardCharsets.US_ASCII.name());
  }

  private static Map<String, String> parseQuery(String rawQuery) {
    Map<String, String> query = new HashMap<>();
    if (rawQuery == null || rawQuery.isEmpty()) return query;
    for (String pair : rawQuery.split("&")) {
      int separator = pair.indexOf('=');
      String key = separator < 0 ? pair : pair.substring(0, separator);
      String value = separator < 0 ? "" : pair.substring(separator + 1);
      query.put(key, value);
    }
    return query;
  }

  private static void writeJson(OutputStream output, int status, String reason, String body, String origin) throws IOException {
    writeResponse(output, status, reason, "application/json; charset=utf-8", body.getBytes(StandardCharsets.UTF_8), origin, null);
  }

  private static void writeResponse(
    OutputStream output,
    int status,
    String reason,
    String contentType,
    byte[] body,
    String origin,
    Map<String, String> extraHeaders
  ) throws IOException {
    StringBuilder headers = new StringBuilder();
    headers.append("HTTP/1.1 ").append(status).append(' ').append(reason).append("\r\n");
    headers.append("Content-Type: ").append(contentType).append("\r\n");
    headers.append("Content-Length: ").append(body.length).append("\r\n");
    headers.append("Cache-Control: no-store\r\n");
    headers.append("Connection: close\r\n");
    headers.append("X-Content-Type-Options: nosniff\r\n");
    headers.append("Cross-Origin-Resource-Policy: same-site\r\n");
    if (origin != null && isAllowedOrigin(origin)) {
      headers.append("Access-Control-Allow-Origin: ").append(origin).append("\r\n");
      headers.append("Access-Control-Allow-Methods: GET, POST, OPTIONS\r\n");
      headers.append("Access-Control-Allow-Headers: Content-Type\r\n");
      headers.append("Access-Control-Expose-Headers: X-Jarvis-Audio-Source, X-Jarvis-Sample-Rate, X-Jarvis-Audio-Duration-Ms, X-Jarvis-Capture-Cue, X-Jarvis-Raw-Audio-Stored\r\n");
      headers.append("Vary: Origin\r\n");
    }
    if (extraHeaders != null) {
      for (Map.Entry<String, String> entry : extraHeaders.entrySet()) {
        headers.append(entry.getKey()).append(": ").append(entry.getValue()).append("\r\n");
      }
    }
    headers.append("\r\n");
    output.write(headers.toString().getBytes(StandardCharsets.US_ASCII));
    output.write(body);
    output.flush();
  }

  private static boolean isAllowedOrigin(String origin) {
    return PRIMARY_ORIGIN.equals(origin) || SECONDARY_ORIGIN.equals(origin);
  }

  private static String audioSourceName(int source) {
    if (source == MediaRecorder.AudioSource.VOICE_RECOGNITION) return "voice-recognition";
    if (source == MediaRecorder.AudioSource.CAMCORDER) return "camcorder";
    if (source == MediaRecorder.AudioSource.VOICE_COMMUNICATION) return "voice-communication";
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N && source == MediaRecorder.AudioSource.UNPROCESSED) return "unprocessed";
    if (source == MediaRecorder.AudioSource.DEFAULT) return "default";
    return "microphone";
  }

  private static int parseInteger(String value, int fallback) {
    try {
      return Integer.parseInt(value);
    } catch (RuntimeException ignored) {
      return fallback;
    }
  }

  private static boolean parseBoolean(String value) {
    return "1".equals(value) || "true".equalsIgnoreCase(value) || "yes".equalsIgnoreCase(value);
  }

  private static int clamp(int value, int minimum, int maximum) {
    return Math.max(minimum, Math.min(maximum, value));
  }

  private static void writeAscii(ByteArrayOutputStream output, String value) {
    byte[] bytes = value.getBytes(StandardCharsets.US_ASCII);
    output.write(bytes, 0, bytes.length);
  }

  private static void writeLittleEndianInt(ByteArrayOutputStream output, int value) {
    output.write(value & 0xff);
    output.write((value >>> 8) & 0xff);
    output.write((value >>> 16) & 0xff);
    output.write((value >>> 24) & 0xff);
  }

  private static void writeLittleEndianShort(ByteArrayOutputStream output, int value) {
    output.write(value & 0xff);
    output.write((value >>> 8) & 0xff);
  }

  @Override
  public synchronized void close() {
    running.set(false);
    closeQuietly();
    clients.shutdownNow();
    if (acceptThread != null) acceptThread.interrupt();
    acceptThread = null;
  }

  private void closeQuietly() {
    ServerSocket socket = serverSocket;
    serverSocket = null;
    if (socket == null) return;
    try {
      socket.close();
    } catch (IOException ignored) {
      // Closing an already closed loopback socket is harmless.
    }
  }

  private static final class HttpRequest {
    final String method;
    final String path;
    final Map<String, String> query;
    final Map<String, String> headers;

    HttpRequest(String method, String path, Map<String, String> query, Map<String, String> headers) {
      this.method = method;
      this.path = path;
      this.query = query;
      this.headers = headers;
    }
  }

  private static final class CapturedAudio {
    final byte[] wav;
    final String sourceName;
    final int durationMs;
    final boolean cuePlayed;

    CapturedAudio(byte[] wav, String sourceName, int durationMs, boolean cuePlayed) {
      this.wav = wav;
      this.sourceName = sourceName;
      this.durationMs = durationMs;
      this.cuePlayed = cuePlayed;
    }
  }

  private static final class AudioRoute {
    final int source;
    final int channelMask;
    final int channelCount;
    final int channelIndex;
    final String name;
    final boolean oemPreferred;

    AudioRoute(int source, int channelMask, int channelCount, int channelIndex, String name, boolean oemPreferred) {
      this.source = source;
      this.channelMask = channelMask;
      this.channelCount = channelCount;
      this.channelIndex = channelIndex;
      this.name = name;
      this.oemPreferred = oemPreferred;
    }
  }

  private static final class NamedThreadFactory implements ThreadFactory {
    private int index;

    @Override
    public synchronized Thread newThread(Runnable runnable) {
      Thread thread = new Thread(runnable, "jarvis-native-audio-client-" + (++index));
      thread.setDaemon(true);
      return thread;
    }
  }
}

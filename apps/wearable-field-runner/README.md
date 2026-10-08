# JARVIS Wearable Field Runner

Minimal Android WebView host for physical JARVIS HUD validation on glasses that provide Android WebView but no browser activity.

Security boundaries:

- navigation is restricted to `http://127.0.0.1:4176` and `http://localhost:4176`;
- cleartext traffic is allowed only for loopback ADB reverse transport;
- file access, content access, cookies, popups, mixed content, and WebView debugging are disabled;
- microphone capture is granted only to the loopback field origin after Android runtime permission;
- a native PCM capture service listens only on `127.0.0.1:4186`, accepts the two field origins, and never writes raw audio;
- no JavaScript interface is exposed to page code.

Build and deploy through the repository harness:

```powershell
npm run wearable:field-runner -- --serial <adb-serial>
```

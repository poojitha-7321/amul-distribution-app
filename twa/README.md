# Android app (Trusted Web Activity) with push notifications

A TWA opens the live site in Chrome's engine, so cookies, live stock and **Web Push notifications work**.
(The Capacitor project in `client/android` uses a WebView, which cannot receive Web Push. Use this TWA for push.)

Requirements: Node 20+, JDK 17, Android SDK (platform 34+ and build-tools). Bubblewrap asks for the JDK/SDK
paths the first time it runs.

```bash
cd twa
npx @bubblewrap/cli doctor            # first run: point it at your JDK 17 and Android SDK
npx @bubblewrap/cli init --manifest https://amul-order-desk.onrender.com/manifest.webmanifest
#   Accept the defaults. Package ID: com.orderdesk.dairy. Enable notifications: YES.
#   (twa-manifest.json here is a ready-made version; init can reuse or regenerate it.)
#   Create a NEW signing key when asked, and keep android.keystore + its password safe. Never commit them.
npx @bubblewrap/cli build             # produces app-release-signed.apk
npx @bubblewrap/cli fingerprint       # prints the SHA-256 of your signing key (for the next step)
```

Output: `twa/app-release-signed.apk` (install/share this one).

## Make it full-screen (remove the browser address bar)
Create `client/public/.well-known/assetlinks.json` with your fingerprint, commit, push (Render redeploys):

```json
[{
  "relation": ["delegate_permission/common.handle_all_urls"],
  "target": {
    "namespace": "android_app",
    "package_name": "com.orderdesk.dairy",
    "sha256_cert_fingerprints": ["PASTE:THE:SHA256:FINGERPRINT:HERE"]
  }
}]
```
Check: `https://amul-order-desk.onrender.com/.well-known/assetlinks.json` must return that JSON.

## Turn on push on the phone
Install the APK, log in, open the bell, tap "Turn on push alerts", allow notifications.

## Windows build notes (learned the hard way)
- Bubblewrap calls `gradlew.bat` without `.\`, which Windows may not resolve: add the `twa` folder to `PATH` for the build.
- Bubblewrap expects build-tools `36.1.0` and an SDK folder containing `tools/` or `bin/`. If your SDK only has `cmdline-tools/latest`, create an empty `sdk/tools` folder and (if `sdkmanager` cannot see 36.1.0) copy `build-tools/36.0.0` to `build-tools/36.1.0`.
- Non-interactive build: set `BUBBLEWRAP_KEYSTORE_PASSWORD` and `BUBBLEWRAP_KEY_PASSWORD`, run `bubblewrap update --skipVersionUpgrade`, then `bubblewrap build --skipPwaValidation`.
- The Play Store `.aab` signing step may fail at the very end; `app-release-signed.apk` is already produced by then and is the file to share.
- `twa-manifest.json` must be complete (e.g. `splashScreenFadeOutDuration`, `minSdkVersion` 24, version in `appVersion` + `appVersionCode`).
- The signing-key SHA-256 for this app's key is already published in `client/public/.well-known/assetlinks.json`. A new keystore means a new fingerprint: update that file.

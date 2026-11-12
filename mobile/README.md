# Rider Requests — Android app

A Capacitor app that opens the hosted Rider Requests server (the same one browsers use) and adds what a
browser can't do reliably on a phone:

- **Background GPS** — a foreground service (`TrackerService`, with a visible "clocked in" notification) reads
  GPS and posts it straight to the server with the rider's session, so tracking continues with the screen off.
  Without signal it keeps positions on the phone and uploads them in batches when the connection returns.
  It stops by itself when the rider clocks out or is signed out.
- **Offline start-up** — after the first sign-in, the app opens with no connection (service-worker cache +
  saved session) and riders keep recording collections, drop-offs (with photo, signature and GPS), address
  confirmations and emergency reports. Everything syncs exactly once when back online.
- **Alerts** — system notifications and vibration for critical events when the app is in the background;
  Firebase push when configured (below). SMS through Africa's Talking is the fallback either way.
- Camera photos/videos, one-tap calls and turn-by-turn navigation through the phone's own apps.

Because the app loads the central HTTPS server, riders anywhere (Nairobi, Thika, Mombasa…) use it over any
mobile network or Wi-Fi. Nothing depends on being on the same network as dispatch.

| | |
|---|---|
| Package | `ke.co.lookmedia.riders` |
| Android | 7.0 (API 24) and newer; targets Android 16 (API 36) |
| Version | 2.0.0 (versionCode 200) |
| Default server | `https://ride-request.lookmedia.co.ke` (must equal the server's `APP_ORIGIN`) |

## Install on a phone (internal testing)

1. Copy `dist/rider-requests-2.0.0.apk` to the phone (USB, email, Google Drive or a download link).
2. Open it. Android asks to allow installs from that source (Files / Chrome / Drive); allow it once.
3. Open **Rider Requests**, sign in, and allow **Location** (*While using the app*), **Camera** and
   **Notifications** when asked.
4. Riders: tap **Clock in**. A "Rider Requests — clocked in" notification shows while location is shared.
   Some phones (Tecno, Infinix, Xiaomi, Samsung) stop background apps to save battery: in
   *Settings → Apps → Rider Requests → Battery*, choose **Unrestricted** / **No restrictions**.

If an older Rider Requests APK (v1, signed with the previous key) is installed, uninstall it first; v2 is
signed with a new key and Android will not update over it.

The debug build (`rider-requests-2.0.0-debug.apk`) is for testers only: it allows Chrome remote debugging
of the app (`chrome://inspect`).

## Build

Requirements: Node 22+, JDK 21, Android SDK (platform 36, build-tools 36) at `~/Android/Sdk` or `ANDROID_HOME`.

```bash
cd mobile
npm install
./build.sh debug   https://ride-request.lookmedia.co.ke   # debug APK
./build.sh release https://ride-request.lookmedia.co.ke   # signed release APK + AAB
```

Outputs land in `mobile/dist/`. Release builds accept `https://` only. Debug builds may also use a local
server for testing (`./build.sh debug http://localhost:3000` plus `adb reverse tcp:3000 tcp:3000`).
Set `VERSION_NAME` / `VERSION_CODE` to bump the version (`VERSION_CODE` must increase for every release).

### Signing

Release builds are signed with the key in `~/.config/rider-requests/release.jks` (RSA 4096, valid to 2056).
`android/keystore.properties` points at it and holds its password; both are git-ignored and readable only by
you. **Back up the keystore and `keystore.properties` somewhere safe (a password manager or an encrypted
drive). If they are lost, installed apps can never be updated; riders would have to uninstall and reinstall.**

```
storeFile=/home/<you>/.config/rider-requests/release.jks
storePassword=…
keyAlias=rider-requests
keyPassword=…
```

### Google Play (AAB)

`dist/rider-requests-2.0.0.aab` is ready for the Play Console. Enrol in **Play App Signing** (Google holds the
distribution key; the key above becomes your upload key). Play will ask for a privacy policy and the
*background location / foreground service* declaration: explain that location is shared only while a rider
is clocked in, for live dispatch and delivery proof. Internal testing tracks need no review.

For distribution outside Play (side-loading), share the APK.

### Push notifications (optional)

1. Create a Firebase project, add an Android app with package `ke.co.lookmedia.riders`, download
   `google-services.json` into `mobile/`, and rebuild (`build.sh` adds the push plugin automatically).
2. In Firebase → Project settings → Service accounts, generate a key and set it on the server as
   `FCM_SERVICE_ACCOUNT` (the JSON, or its base64).

Without this, the app still raises alerts while it is running, and critical notifications reach riders by SMS.

## iOS

An Android APK does not run on iPhones. iPhone users can use the web app in Safari (it works offline too,
but iOS pauses GPS in the background). A native iOS build needs a Mac with Xcode, an Apple Developer account,
`npx cap add ios`, and a Swift port of the background tracker; it is not part of this release.

## How it is put together

- `capacitor.config.json` — server URL, allowed host and Android options (rewritten by `build.sh` per build).
- `www/` — bundled fallback pages only (`offline.html` is shown if the very first launch has no connection).
- `android/app/src/main/java/ke/co/lookmedia/riders/` — `MainActivity`, `RiderTrackerPlugin` (JS bridge),
  `TrackerService` (foreground GPS service with offline queue).
- `android/app/src/main/AndroidManifest.xml` — permissions: internet, location, foreground service
  (location), camera, notifications, vibrate. Backups of app data are disabled; release builds are HTTPS-only
  (`res/xml/network_security_config.xml`).

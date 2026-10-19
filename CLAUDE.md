# Project handoff for Claude Code

Read this first. The previous session ran on another laptop and stopped part-way through building the Android APK.

## What this project is
Dairy Order Desk: order and inventory management for an Amul milk and curd distributor and their retailers. See `README.md` for features, stock policy, local run, and assumptions.

- `client/`: React + TypeScript + Vite + Tailwind PWA, plus a Capacitor Android project in `client/android/`
- `server/`: Node + Express + TypeScript + PostgreSQL, 58 automated tests (`npm test`)
- Deployed and working: **https://amul-order-desk.onrender.com** (Render free web service + Neon free PostgreSQL)
- GitHub: `poojitha-7321/amul-distribution-app`. Use the `poojitha-7321` GitHub account for this repo (`gh auth switch` if needed). Never change the global git identity.

## Where things stand
- Backend, web app, tests, README, `render.yaml`, and the live deployment are all done.
- Users live in the database. `SEED_ADMIN_EMAIL` and `SEED_ADMIN_PASSWORD` are only used to create the first admin on Render and can be removed after that.
- **The only unfinished task is producing an installable Android APK** so the user can install it on their phone and share it on WhatsApp.

## Android APK: what is already done
- `client/capacitor.config.ts`: `appId` is `com.orderdesk.dairy`, app name `Order Desk`, and the app loads the live site. `server.url` defaults to `https://amul-order-desk.onrender.com`; it can be overridden with the `CAP_SERVER_URL` environment variable.
- The Android project already exists in `client/android/` and has been synced (`npm run android:sync`).
- `client/android/gradle/wrapper/gradle-wrapper.properties` was changed from `gradle-8.14.3-all.zip` to `gradle-8.14.3-bin.zip` to save download size. Either distribution works.

## What to do next (on the laptop that has Gradle, the JDK and the Android SDK)
Requirements: JDK 17, Android SDK with platform `android-36` and build-tools 36, and Node 20+.

```powershell
cd <repo>
git pull
npm install
cd client
npm run android:sync          # builds the web app and syncs it into the Android project
cd android
# if Gradle says "SDK location not found", create local.properties with:
#   sdk.dir=C\:\\Users\\<user>\\AppData\\Local\\Android\\Sdk
.\gradlew.bat assembleDebug
```
The APK is written to `client/android/app/build/outputs/apk/debug/app-debug.apk`. Confirm it exists, tell the user the full path, and check that it installs and the login screen loads.

Notes for the build:
- If `JAVA_HOME` is not set, point it at JDK 17 (Android Studio's `jbr` folder works).
- The compile and target SDK is 36 and the minimum is 24 (see `client/android/variables.gradle`).
- A debug APK is fine for sideloading and WhatsApp sharing. A signed release build or an `.aab` is only needed for the Google Play Store. If asked, create a keystore, and **never commit keystores, passwords, or `local.properties`**.
- WhatsApp may block `.apk` files; renaming the file to `.apk.zip`, or sharing via Google Drive, works.

## Fallback if the local build fails
PWABuilder (https://www.pwabuilder.com) can package the live site as an APK online. It generated a package successfully before, but the user could not see its Download button. The package ID used was `com.orderdesk.dairy`.

## Other facts worth knowing
- The Render free instance sleeps when idle, so the first request takes about 30 seconds.
- Demo logins (`admin@amul-demo.local` and so on) exist only in local development seeds, never on the live site. The live admin was created from the Render environment variables, which are not stored in this repo.
- The Neon connection string must not use the `-pooler` host or `channel_binding=require`.
- Do not paste secrets (database URLs, passwords) into the repo or into commit messages.

# Project handoff for Claude Code

Read this first. A previous session built everything below on another laptop. The Android APK was not yet built.

## What this project is
Dairy Order Desk: order and inventory management for an Amul milk and curd distributor and their retailers. See `README.md` for features, the stock policy, local run, and assumptions.

- `client/`: React + TypeScript + Vite + Tailwind PWA (also has a Capacitor project in `client/android/`, see below)
- `server/`: Node + Express + TypeScript + PostgreSQL, 66 automated tests (`npm test`)
- `twa/`: Bubblewrap config for the Android app that supports **push notifications**
- `data/amul-milk-curd-catalogue.csv`: 47 real Amul milk and curd variants, loaded via Admin → Import
- Live: **https://amul-order-desk.onrender.com** (Render free web service + Neon free PostgreSQL)
- GitHub: `poojitha-7321/amul-distribution-app`. Use the `poojitha-7321` GitHub account for this repo. Never change the global git identity.

## Done
- Backend, web app, tests, README, `render.yaml`, live deployment.
- Users live in the database. `SEED_ADMIN_*` env vars only create the first admin, and can be removed afterwards.
- Web Push (VAPID): admins get a push when a retailer places an order (and on low stock); retailers get one on status changes. Code is in `server/src/services/push.ts`, `server/src/routes/push.ts`, `client/src/push.ts`, `client/public/push-sw.js`. The bell panel has a "Turn on push alerts" button.
- Catalogue CSV (prices, crate sizes and min stock are intentionally blank).

## Still to do (needs the user's accounts; Claude cannot do these)
1. **Render env vars for push**: the user must add `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` (e.g. `mailto:...`) to the `amul-order-desk` service in their own Render dashboard. Generate with `npx web-push generate-vapid-keys`. Push is silently disabled until they exist. The keys were shared in chat once and the user plans to rotate them; never commit keys.
   Note: the Render MCP connector in some sessions is signed in to a *different* Render account (another person's projects). Do not modify those services. Check that the workspace contains `amul-order-desk` before using it.
2. **Import the catalogue**: log in as admin → Import → Product catalogue → upload `data/amul-milk-curd-catalogue.csv`, then deactivate packs the distributor does not supply, fill prices/crate sizes/min stock, and load opening stock (Import → Stock quantities).
3. **Build the Android APK (this is the main task on the laptop with JDK 17 + Android SDK)**.

## Building the APK: use the TWA in `twa/` (push works), not Capacitor
Capacitor's WebView cannot receive Web Push. The TWA opens the live site in Chrome, so push, cookies and live data all work.

```powershell
cd twa
npx @bubblewrap/cli doctor      # first run: set JDK 17 and Android SDK paths
npx @bubblewrap/cli init --manifest https://amul-order-desk.onrender.com/manifest.webmanifest
#   package id com.orderdesk.dairy, enable notifications = YES, create a NEW signing key
npx @bubblewrap/cli build       # -> twa/app-release-signed.apk
npx @bubblewrap/cli fingerprint # SHA-256 of the signing key
```
Then create `client/public/.well-known/assetlinks.json` with that fingerprint (template in `twa/README.md`), commit, push, and wait for Render to redeploy, so the app opens full-screen without the address bar. The server already serves `/.well-known`.

After installing the APK: log in → bell → "Turn on push alerts" → allow notifications → "Send test".

Rules:
- **Never commit** `*.keystore`, `*.jks`, passwords, or `local.properties` (already in `.gitignore`). Tell the user to back up the keystore: every future update must use the same key.
- A debug or signed APK is fine for sideloading and WhatsApp sharing. WhatsApp may block `.apk`; rename to `.apk.zip` or share via Google Drive.
- Fallback with no tools: PWABuilder (https://www.pwabuilder.com) packages the live site; tick notification delegation. Package ID `com.orderdesk.dairy`.
- The Capacitor project (`client/android`, `npm run android:sync`, `gradlew assembleDebug`) still works for a plain WebView app without push. Compile SDK 36, min SDK 24.

## Facts worth knowing
- The Render free instance sleeps when idle, so the first request takes about 30 seconds.
- Demo logins (`admin@amul-demo.local`, etc.) exist only in local development seeds, never on the live site. The live admin comes from the Render environment variables, which are not in this repo.
- The Neon connection string must not use the `-pooler` host or `channel_binding=require`.
- iPhone push needs iOS 16.4+ and the app added to the Home Screen from Safari.
- Do not paste secrets (database URLs, passwords, private keys) into the repo or commit messages.

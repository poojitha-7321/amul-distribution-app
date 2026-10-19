import type { CapacitorConfig } from '@capacitor/cli';

// The APK is a native shell around the hosted web app, so cookies, live stock and
// orders behave exactly as in the browser. Set CAP_SERVER_URL before `npx cap sync`:
//   emulator + local server : http://10.0.2.2:4000
//   production              : https://your-app.onrender.com
const url = process.env.CAP_SERVER_URL;

const config: CapacitorConfig = {
  appId: 'com.orderdesk.dairy',
  appName: 'Order Desk',
  webDir: 'dist',
  server: url ? { url, cleartext: url.startsWith('http://'), androidScheme: 'https' } : undefined,
  android: { allowMixedContent: false },
};

export default config;

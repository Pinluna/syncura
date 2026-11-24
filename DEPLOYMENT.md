# Syncura self-hosting

The server stores account, cycle, journal, and pairing data in
`data/syncura.json`. In production, set `NODE_ENV=production` and provide
`SYNCURA_DATA_KEY` as a base64-encoded 32-byte secret. Generate it with:

```sh
openssl rand -base64 32
```

Keep the key in the host's secret store or a root-readable environment file;
never commit it or include it in the APK. Back up the encrypted data file and
the key separately. Losing the key makes the data unrecoverable.

When a key is configured, new writes use AES-256-GCM with a fresh nonce and
authentication tag. Existing plaintext JSON is validated and atomically
converted to the encrypted format at startup. Make a protected backup of
`data/syncura.json` before the first keyed startup. Production requires the
key, and an encrypted file always requires it. Invalid keys, corrupted files,
or failed authentication stop startup instead of replacing the data with an
empty store. Without a key, non-production development keeps the existing
plaintext behavior. Files are written atomically with restrictive
permissions.

This encryption protects data at rest;
the running server still decrypts it in memory. Use HTTPS for client
connections and protect backups and host snapshots as sensitive health data.

## Calls and shared media

Chat attachments are encrypted on the sender's device with the pair's
end-to-end key before upload. The server stores only opaque ciphertext in
`data/syncura.json.media`; each file is limited to 20 MB and each pair has a
200 MB total limit. Files are available only to that pair and are removed when
the pair disconnects. Downloads
are decrypted only on the recipient's device and saved through the browser or
to the app's Documents folder.

Audio and video calls use peer-to-peer WebRTC; the Syncura server carries only
authenticated call signaling. Calls on the same local network can connect
without an ICE relay. For calls across NATs or mobile networks, configure your
own STUN/TURN services in the server environment using a JSON array:

```sh
SYNCURA_ICE_SERVERS='[{"urls":"stun:stun.your-domain.example:3478"},{"urls":"turn:turn.your-domain.example:3478","username":"syncura","credential":"replace-with-a-secret"}]'
```

Use time-limited TURN credentials for public deployments and keep them in the
server's secret store. ICE configuration is returned only to authenticated
clients. Microphone and camera access is requested by the device when a call is
started.

The custom still or looping-video wallpaper is stored locally in each device's
browser storage; it is not uploaded to the Syncura server or shared with the
partner.

## Android message notifications

Android message notifications use Firebase Cloud Messaging (FCM). In Firebase,
create an Android app with package name `app.syncura` and place its
`google-services.json` at `android/app/google-services.json`. The Android build
applies the Google Services plugin when that file is present. On the server,
provide a Firebase service-account JSON document through the
`SYNCURA_FCM_SERVICE_ACCOUNT` environment variable. Grant that service account
permission to send Firebase Cloud Messaging messages for the same project.
Keep the service-account private key on the server; never add it to the app,
source control, or the APK.

When `google-services.json` is present during the app build, Syncura requests
notification permission and registers its FCM token with the authenticated
server. Incoming chat messages are sent as notifications with the Syncura
status icon and the bundled `syncura_message_tone` sound. Android notification
channel settings are controlled by the device owner; if a user changes the
channel sound, Android keeps that choice. If FCM is not configured, push
registration is skipped, in-app messaging continues to work, and remote
notifications are not delivered.

## Offline use and syncing

Syncura caches the authenticated account, dashboard, cycle, journal, task,
shared-thread and encrypted-chat responses in the device's IndexedDB storage.
Changes to logs, settings, period days, journal entries, tasks, the shared
thread, and encrypted text messages are saved locally while disconnected and
sent in order when connectivity returns. The app shows an offline or
waiting-to-sync banner while changes are queued. Chat history remains available
after leaving the tab and reopening the app.

For the browser app, the production service worker caches the app shell and
static assets after the first online visit. The server must be visited once
online before the web app can launch offline.

Initial registration/pairing, calls, and view-once media still require a live
server connection. Offline changes are replayed against the server in order;
for simultaneous edits from both partners, the server's existing update rules
remain authoritative.

## Local server control panel

On the Syncura PC, run `npm run control` from the project directory and open
`http://127.0.0.1:3002`. The control interface binds to loopback only and can
start or stop this project's API server on port 3001. If the project's API is
already running outside the panel, choosing **Start server** asks before
restarting that verified Syncura process under panel control. Other processes
using the API port are never stopped.

The panel shows rolling request counts, response bytes, live Socket.IO clients,
and recent HTTP route/status/timing metadata. It does not record request bodies,
message content, authentication tokens, or client IP addresses. Metrics are
held in memory and reset when the API restarts. The panel itself is separate
from the Syncura app and is not reachable from other devices on the network.

## Android on the same Wi-Fi

For a temporary local connection, run the API with `SYNCURA_HOST` set to the
computer's Wi-Fi IPv4 address, and provide TLS key and certificate files using
`SYNCURA_TLS_KEY_FILE` and `SYNCURA_TLS_CERT_FILE`. The Android build must
trust the CA that issued that certificate in
`android/app/src/main/res/raw/syncura_local_ca.pem`; rebuild and reinstall the
APK after changing the CA. In the APK, select **Using a self-hosted server?**
and enter `https://<computer-wifi-ip>:3001`.

For a temporary local setup, replace `<computer-wifi-ip>` with the computer's Wi-Fi address:

```sh
SYNCURA_DATA_KEY="$(cat ~/.local/share/syncura/data.key)" \
SYNCURA_HOST=<computer-wifi-ip> \
SYNCURA_TLS_KEY_FILE=~/.local/share/syncura/tls/server.key \
SYNCURA_TLS_CERT_FILE=~/.local/share/syncura/tls/server.pem \
VITE_API_PROXY_TARGET=https://<computer-wifi-ip>:3001 \
npm run dev
```

To build an APK preconfigured for this Wi-Fi address, add
`VITE_NATIVE_API_BASE=https://<computer-wifi-ip>:3001` to the Android build command.
The app's self-hosted server setting can override this default. The updated
debug APK is `android/app/build/outputs/apk/debug/app-debug.apk`.

The Wi-Fi address can change, and the phone must be on the same trusted
network. This is not public hosting; for access away from home, use a VPS,
domain, and publicly trusted HTTPS certificate.

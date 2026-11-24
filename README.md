# N54 Advanced Monitor

A live dashboard in your phone's browser for the **BMW N54** (E90/E92 335i, 2007+). It connects to a
**Bluetooth LE ELM327 OBD-II adapter**. You don't install anything: open the web page, tap **Connect**
and pick the adapter.

Displays: **RPM** (with shift lights), **boost** (with DME target if reported), **HPFP rail pressure**,
**coolant temperature**, and **wastegate duty** for both banks (actual + commanded). Also: peak/min hold,
warnings (low rail pressure, overheating, overboost), CSV logging, a raw ELM327 terminal, and a Demo mode.

## Android APK
Download **[n54-monitor.apk](https://github.com/asw2012/N54_Advanced_Monitor/releases/download/apk-latest/n54-monitor.apk)**
on the phone, open it and allow "install unknown apps" for your browser. Every push rebuilds it
(`.github/workflows/android.yml`) and replaces the `apk-latest` release. Updates install over the old version.
The APK uses native Bluetooth LE (Capacitor + `@capacitor-community/bluetooth-le`), so it doesn't depend
on browser support. It's signed with a fixed, non-secret debug key (`android/app/n54-debug.keystore`).
That's fine for sideloading, but you'd need a proper key for the Play Store.

Local build: `npm ci && npm run sync && (cd android && ./gradlew assembleDebug)`.

## What you need
| | |
|---|---|
| Adapter | A **BLE** ELM327 adapter: OBDLink CX, Vgate iCar Pro **BLE 4.0**, Veepeak OBDCheck **BLE+** or similar. Classic-Bluetooth (SPP) dongles **won't work** from a browser. |
| Android | Chrome |
| iPhone | **Bluefy** browser (free, App Store). Safari doesn't support Web Bluetooth. |
| Hosting | Any HTTPS URL (Web Bluetooth requires HTTPS). See GitHub Pages below. |

## Hosting on GitHub Pages
1. Repo **Settings → Pages → Build and deployment → Source: Deploy from a branch**.
2. Branch: the branch holding these files, folder **/ (root)** → **Save**.
3. About a minute later it's live at `https://<user>.github.io/N54_Advanced_Monitor/`.
4. On the phone, open the URL, then **Install app / Add to Home screen**. It runs full-screen and works offline after the first load.

## How each value is obtained
All values come from standard SAE J1979 mode 01 PIDs. When the app connects, it asks the DME which PIDs it
supports and uses the best one available:

| Gauge | Source (in order of preference) |
|---|---|
| RPM | `010C` |
| Boost | `0170` boost-pressure control (actual + target) → `0187` extended MAP → `010B` MAP; minus baro `0133` |
| HPFP rail | `0159` absolute rail pressure → `0123` rail gauge pressure |
| Coolant | `0105` |
| Wastegate | `0172` wastegate control (bank 1/2, commanded + actual) |

**Menu → Settings** lists the PIDs your DME reported as supported. `010B` maxes out at 255 kPa abs
(~22 psi boost at sea level). That covers stock and most tunes.

### If HPFP or wastegate shows `--`
The MSD80/MSD81 DME might not expose these through standard OBD. In that case, read them from the DME's
BMW-specific identifiers. Go to **Menu → BMW DME** and add a channel, for example:
```json
[{ "target": "rail", "header": "6F1", "cea": "12", "cra": "612",
   "request": "22XXXX", "formula": "(A*256+B)*10" }]
```
- `target`: `rpm | boost | boostTarget | rail | coolant | wg1 | wg2 | wg1c | wg2c`
- `formula`: response bytes `A, B, C…` after the echoed request. Output units: kPa (boost absolute), °C, %.
- Optional `fcsh` / `fcsd` set ELM flow-control (`ATFCSH`/`ATFCSD`/`ATFCSM1`) for multi-frame replies.

The app **doesn't ship guessed DME identifiers**. They depend on the DME software version, and wrong
values on a fuel-pressure gauge are worse than none. Use identifiers you've verified, for example
cross-checked against INPA/ISTA or a known-good logger. Test them first in **Menu → Terminal**. Only
read services (`22`/`21`/`2C`) belong here. Never send write or coding services.

## Safety
Set it up before driving and mount the phone. Don't operate the app while the car is moving. Warnings
are informational. An N54 with a low-rail-pressure warning (failing HPFP) should be checked before
you drive it hard.

## Files
`index.html`, `styles.css`, `app.js` (BLE transport, ELM327 driver, PID decoding, UI, demo simulator),
`sw.js` + `manifest.webmanifest` (installable/offline).

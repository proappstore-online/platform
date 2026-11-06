---
description: "How the Android ProAppStore companion connects your apps to background location, and how to pause or disconnect."
---

# ProAppStore on Android

The Android companion is an early preview. Your PAS apps still run in your browser. ProAppStore can collect location for apps you explicitly enable, including while those apps are closed.

## Connect your phone

Sign in with the same Google or GitHub account you use in your PAS apps. Match the short code shown on your phone with the browser connection page before approving. Connecting the phone does not enable location for any app.

## Enable an app

Review the app's location explanation and choose Enable. Grant precise location, then background access (Allow all the time) when Android asks. ProAppStore appears as the collector in Android's permission settings. Each app's separate permission appears inside ProAppStore.

The first preview supports Ski's location service. The Ski website integration is still being built; its existing browser recorder is unchanged.

## Control sharing

- **Pause all** stops new location collection. Already collected updates may still sync.
- **Disable an app** immediately stops that recipient on your phone. If offline, its platform disconnection finishes when the phone reconnects; ProAppStore displays that pending state.
- **Disconnect this phone** stops collection and deletes its pending device updates and raw platform copies. Internet is required to finish disconnection.
- Rides or other results already saved separately inside an app are managed by that app.

## Your data

Location is stored privately on this phone while offline, then uploaded to the PAS platform for your enabled apps and account. Raw platform copies expire after seven days. Device queue entries also expire after seven days when synchronization runs. This preview does not use location for advertising.

Collection stops if required permissions are missing or the queue cannot safely save another update. Android power controls, force-stop and poor GPS can interrupt recording. ProAppStore cannot promise an uninterrupted or perfectly accurate route.

Device connections expire after 90 days in this preview. Reconnect when asked. The preview has not been submitted to Google Play.

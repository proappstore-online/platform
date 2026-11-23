---
description: "How the ProAppStore companion on Android and iPhone connects your apps to background location, and how to pause or disconnect."
---

# ProAppStore on your phone

The Android companion is an early preview. Your PAS apps still run in your browser. ProAppStore can collect location for apps you explicitly enable, including while those apps are closed.

## Connect your phone

Sign in with the same Google or GitHub account you use in your PAS apps. Match the short code shown on your phone with the browser connection page before approving. Connecting the phone does not enable location for any app.

## Enable an app

Review the app's location explanation and choose Enable. Grant precise location, then background access (Allow all the time) when Android asks. ProAppStore appears as the collector in Android's permission settings. Each app's separate permission appears inside ProAppStore.

The preview supports Ski, Run and Rideshare. Run adds locked-screen location only to a run you are recording. Rideshare receives each new position within seconds and uses it only while you are online as a driver or on a trip.

**Open** on an app takes you to it in Chrome. If the app isn't installed yet, it offers an **Install** button. Tap it to add the app to your home screen.

The **Store** tab lists every public PAS app. Search, browse by category, or open an app's page for its description and features. The store works offline from the last copy it downloaded. Apps you have enabled for background features appear under **Yours**.

## On iPhone

Build and install from Xcode (developer preview; not on the App Store). Choose **Allow While Using App** and keep **Precise Location** on. Start collection in ProAppStore, then lock your phone or switch to your app: the blue location indicator shows ProAppStore is recording. Choose **Change to Always Allow** only if you want ProAppStore to resume after iOS closes it. A free Apple developer team build stops opening after 7 days until it is reinstalled from Xcode.

## Browse apps (iPhone)

The **Storefront** tab lists every public PAS app. Search, browse by category, or open an app's page for its description and features. **Open** takes you to the app in your browser. The store works offline from the last copy it downloaded. Apps you have enabled for background features appear under **Yours**.

The first time you open an app, ProAppStore shows how to add it to your Home Screen (Share → Add to Home Screen). Choose **Don't show this again** to skip the guide for every app.

## Heart rate (Run)

Run can add heart rate from a standard Bluetooth chest strap (Polar, Garmin, Wahoo and others) to the runs and walks you record, including while your phone is locked.

1. Under Run in **Sharing**, choose **Enable** next to Heart rate and read what is shared.
2. Choose **Choose sensor**, put the strap on so it wakes up, and pick it from the list. ProAppStore looks for sensors only while this list is open. Allow Bluetooth when your phone asks.
3. Keep the strap on. ProAppStore reconnects to it on its own when it comes back into range, without opening the app.

Only beats per minute and the time of each reading leave the phone. The sensor's name and identifier stay on it. Readings are taken at most once a second, and only while the strap reports skin contact. **Pause** on Run and **Pause all** stop heart rate as well as location. **Forget sensor** disconnects the strap and removes it from the phone; **Turn off heart rate for Run** stops sharing it and leaves Run's location as it was.

Run's row shows the strap's state and current bpm, readings waiting to upload, the last upload and the last reading. Heart-rate events (sensor connected or out of range, Bluetooth off, uploads rejected) appear in **Activity**. A session's page charts your heart rate under its map, from the phone's own 30-day copy, which **Clear sharing history** deletes with the rest.

## Control sharing

- **Pause all** stops new location collection. Already collected updates may still sync.
- **Pause an app** stops sending new location to that app only. It keeps your consent, so **Resume** needs no new approval. If every app is paused, ProAppStore stops using location. The app is not told you paused; it just stops receiving new points.
- **Activity** lists when sharing was turned on, paused or off, and any upload or permission problem, for the last 30 days. It stays on your phone.
- **Disable an app** immediately stops that recipient on your phone. If offline, its platform disconnection finishes when the phone reconnects; ProAppStore displays that pending state.
- **Disconnect this phone** stops collection and deletes its pending device updates and raw platform copies. Internet is required to finish disconnection.
- Rides or other results already saved separately inside an app are managed by that app.

## Your data

Location is stored privately on this phone while offline, then uploaded to the PAS platform for your enabled apps and account. Raw platform copies expire after seven days. Device queue entries expire after seven days when synchronization runs. ProAppStore also keeps a private history on the phone of the locations it shared with each app and when you enabled, paused or turned off sharing, so it can show your sharing map and timeline. That history never leaves the phone, is excluded from backups, is kept for 30 days, and is deleted by **Clear sharing history** or **Disconnect this phone**. The sharing map draws your history from the phone. On Android it is drawn on a plain background, with no map service involved. On iPhone, map backgrounds are loaded from Apple Maps, so Apple receives the map area you view, as with any Apple map; your shared track itself is not sent to Apple or to ProAppStore when you view it. This preview does not use location for advertising.

Collection stops if required permissions are missing or the queue cannot safely save another update. Android power controls, force-stop and poor GPS can interrupt recording. ProAppStore cannot promise an uninterrupted or perfectly accurate route.

Device connections expire after 90 days in this preview. Reconnect when asked. The preview has not been submitted to Google Play.

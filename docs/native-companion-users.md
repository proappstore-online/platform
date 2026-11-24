---
description: "How the ProAppStore companion on Android and iPhone shares location with your apps while you record, and how to stop or disconnect."
---

# ProAppStore on your phone

The Android companion is an early preview. Your PAS apps still run in your browser. ProAppStore shares location with an app you enabled only while you have started sharing with it, including while that app is closed and your phone is locked.

## Connect your phone

Sign in with the same Google or GitHub account you use in your PAS apps. Match the short code shown on your phone with the browser connection page before approving. Connecting the phone does not enable location for any app.

## Enable an app

Review the app's location explanation and choose Enable. Allow precise location when Android asks; ProAppStore never needs "Allow all the time". ProAppStore appears as the collector in Android's permission settings. Each app's separate permission appears inside ProAppStore.

Enabling an app does not start sharing. Tap **Start** on the app's row when you go out. A link from the app (`proappstore://native/apps/<app>`) opens ProAppStore at a **Start sharing with Run?** prompt; it never starts anything until you tap Start.

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

1. Enable location for Run first: heart rate is shared during Run's sessions, which need location. Then, under Run in **Sharing**, choose **Enable** next to Heart rate and read what is shared.
2. Choose **Choose sensor**, put the strap on so it wakes up, and pick it from the list. ProAppStore looks for sensors only while this list is open. Allow Bluetooth when your phone asks.
3. Keep the strap on. ProAppStore reconnects to it on its own when it comes back into range, without opening the app.

Only beats per minute and the time of each reading leave the phone. The sensor's name and identifier stay on it. Readings are taken at most once a second, and only while the strap reports skin contact. Heart rate is shared only while Run's session runs: **Stop** on Run, **Stop all** and the end of the session stop heart rate as well as location. **Forget sensor** disconnects the strap and removes it from the phone; **Turn off heart rate for Run** stops sharing it and leaves Run's location as it was.

Run's row shows the strap's state and current bpm, readings waiting to upload, the last upload and the last reading. Heart-rate events (sensor connected or out of range, Bluetooth off, uploads rejected) appear in **Activity**. A session's page charts your heart rate under its map, from the phone's own 30-day copy, which **Clear sharing history** deletes with the rest.

On Android, ProAppStore's notification says when it is sharing heart rate. Bluetooth permission is asked for when you choose a sensor.

## Control sharing

- **Start** on an app's row begins sharing with that app. The notification "ProAppStore is sharing your location" names the apps you are sharing with and for how long.
- **Stop** on the row stops sharing with that app only. It keeps your consent, so **Start** needs no new approval. The app is not told you stopped; it just stops receiving new points. When no app is sharing, ProAppStore stops using location.
- **Stop all**, or **Stop** in the notification, stops sharing with every app. Already collected updates may still sync.
- Sharing also stops on its own after **30 minutes without moving**, or **12 hours** after you started it. A notification says which app and why ("Stopped sharing with Run: no movement for 30 minutes"); tapping it opens ProAppStore and does not start again. Tap **Start** to continue.
- If Android closes ProAppStore during a session, opening ProAppStore again resumes it, unless 12 hours have passed.
- **Activity** lists when sharing was turned on, started, stopped or off, and any upload or permission problem, for the last 30 days. It stays on your phone.
- **Disable an app** immediately stops that recipient on your phone. If offline, its platform disconnection finishes when the phone reconnects; ProAppStore displays that pending state.
- **Disconnect this phone** stops collection and deletes its pending device updates and raw platform copies. Internet is required to finish disconnection.
- Rides or other results already saved separately inside an app are managed by that app.
- **Delete your account:** Settings → Delete account opens the [deletion page](https://proappstore.online/privacy#data-deletion).

## Your data

Location is stored privately on this phone while offline, then uploaded to the PAS platform for your enabled apps and account. Raw platform copies expire after seven days. Device queue entries expire after seven days when synchronization runs. ProAppStore also keeps a private history on the phone of the locations it shared with each app and when you enabled, started, stopped or turned off sharing, so it can show your sharing map and timeline. That history never leaves the phone, is excluded from backups, is kept for 30 days, and is deleted by **Clear sharing history** or **Disconnect this phone**. The sharing map draws your history from the phone. On Android it is drawn on a plain background, with no map service involved. On iPhone, map backgrounds are loaded from Apple Maps, so Apple receives the map area you view, as with any Apple map; your shared track itself is not sent to Apple or to ProAppStore when you view it. This preview does not use location for advertising.

Collection stops if required permissions are missing or the queue cannot safely save another update. Android power controls, force-stop and poor GPS can interrupt recording. ProAppStore cannot promise an uninterrupted or perfectly accurate route.

Device connections expire after 90 days in this preview. Reconnect when asked. The preview has not been submitted to Google Play.
